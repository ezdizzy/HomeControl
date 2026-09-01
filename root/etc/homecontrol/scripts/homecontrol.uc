// SPDX-License-Identifier: GPL-2.0-only
//
// HomeControl shared library: config access helpers, state paths, logging.
//
// NOTE: this ucode build (2026.01.16) requires a trailing `;` after every
// top-level `export function ... { ... }` in module files, otherwise the
// module fails to compile when imported ("Unexpected token; expecting ';'").
// Also: `export` is only valid in module context (import), so `ucode -c`
// always reports "Exports may only appear at top level of a module" —
// that error is EXPECTED for library files and is not a defect.

'use strict';

import { access, readfile, writefile, open } from 'fs';
import { cursor } from 'uci';

export const CONF = 'homecontrol';
export const RUN_DIR = '/var/run/homecontrol';
export const STATE_DIR = '/etc/homecontrol';
export const LOG_PATH = RUN_DIR + '/homecontrol.log';
export const EVENTS_PATH = RUN_DIR + '/events.json';

export const NFT_TABLE = 'inet homecontrol';
export const NFT_PRE = '/var/run/homecontrol/fw4_pre.nft';

let _cursor = null;
let _cursor_ts = 0;

/* UCI cursor caching: the engine daemon re-reads config every loop, so keep
 * the cursor alive for at most 2 seconds. Long-lived processes (rpcd) would
 * otherwise serve stale config forever, since ucode uci cursors snapshot at
 * creation. */
export function get_cursor() {
	const now = time();
	if (!_cursor || (now - _cursor_ts) > 2)
		_cursor = cursor();
	return _cursor;
};

export function systime_stamp() {
	/* NOTE: this ucode build already returns full year in .year (2026, not 126),
	 * and .mon is 1-based (9 = September). Do NOT add 1900/+1 here. */
	const d = localtime(time());
	return sprintf('%04d-%02d-%02d %02d:%02d:%02d',
		d.year, d.mon, d.mday, d.hour, d.min, d.sec);
};

export function log(msg) {
	const f = open(LOG_PATH, 'a');
	if (!f)
		return;
	f.write(sprintf('%s %s\n', systime_stamp(), msg));
	f.close();
};

export function dirname(p) {
	const m = match(p, /^(.*)\/[^\/]+$/);
	return m ? m[1] : '.';
};

export function mkdir_p(p) {
	system(`mkdir -p '${p}'`);
};

/* Atomic write: temp + mv, so watchers never see a truncated file. */
export function atomic_write(path, content) {
	mkdir_p(dirname(path));
	const tmp = path + '.tmp';
	writefile(tmp, content);
	system(`mv -f '${tmp}' '${path}'`);
};

export function shellquote(s) {
	return `'${replace(s, "'", "'\\''")}'`;
};

/* Read all sections of a given UCI type as an array of objects with .id. */
export function get_sections(ctype) {
	const uc = get_cursor();
	const res = [];
	const all = uc.get_all(CONF);
	if (!all)
		return res;
	for (let sid in all) {
		const sec = uc.get_all(CONF, sid);
		if (!sec || sec['.type'] !== ctype)
			continue;
		const obj = { id: sid };
		for (let k in sec) {
			if (k === '.type' || k === '.name' || k === '.anonymous')
				continue;
			obj[k] = sec[k];
		}
		push(res, obj);
	}
	return res;
};

export function get_section(sid) {
	const uc = get_cursor();
	return uc.get_all(CONF, sid);
};

export function sec_opt(sid, opt, def) {
	const uc = get_cursor();
	const v = uc.get(CONF, sid, opt);
	if (v == null || v === '')
		return def;
	return v;
};

export function main_opt(opt, def) {
	const uc = get_cursor();
	const v = uc.get(CONF, 'main', opt);
	if (v == null || v === '')
		return def;
	return v;
};

/* Append an event to the events journal (capped). */
export function add_event(type, who, detail) {
	if (main_opt('log_enabled', '1') !== '1')
		return;
	let events = [];
	const raw = access(EVENTS_PATH) ? readfile(EVENTS_PATH) : null;
	if (raw) {
		try { events = json(raw); } catch (e) { events = []; }
	}
	const maxn = int(main_opt('log_max', '500')) || 500;
	push(events, {
		ts: time(),
		type: type,        /* block, allow, wifi, schedule, temp, system */
		who: who || '',    /* client name/ip/mac or iface name */
		detail: detail || ''
	});
	while (length(events) > maxn)
		shift(events);
	atomic_write(EVENTS_PATH, sprintf('%J', events) + '\n');
};

/* Parse "HH:MM" to minutes-since-midnight, or null. */
export function parse_hhmm(v) {
	const m = match(v || '', /^(\d{1,2}):(\d{2})$/);
	if (!m)
		return null;
	const h = int(m[1]), mi = int(m[2]);
	if (h > 24 || mi > 59)
		return null;
	return h * 60 + mi;
};

/* Weekday name to index (Mon=0..Sun=6). */
const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function wd_index(name) {
	return (name in WD) ? WD[name] : -1;
};

/* Is the schedule section s active right now?
 * Handles daily (time window each day), weekly (time window on chosen days),
 * range (full-day blocking between dates), timer (one-shot: from date/time
 * until date/time). */
export function schedule_active(s, now) {
	const d = localtime(now);
	const wday = (d.wday + 6) % 7; /* localtime: Sun=0 -> Mon=0 index */
	const now_min = d.hour * 60 + d.min;
	const ymd = sprintf('%04d-%02d-%02d', d.year, d.mon, d.mday);

	const stype = s.type || 'daily';

	if (stype === 'range') {
		const d1 = s.date_start, d2 = s.date_stop;
		if (!d1 && !d2)
			return true;
		if (d1 && ymd < d1)
			return false;
		if (d2 && ymd > d2)
			return false;
		return true;
	}

	if (stype === 'timer') {
		/* one-shot absolute window; date_start+time_start .. date_stop+time_stop */
		const t1 = date_to_ts(s.date_start, s.time_start || '00:00');
		const t2 = date_to_ts(s.date_stop, s.time_stop || '23:59');
		if (t1 == null || t2 == null)
			return false;
		return now >= t1 && now <= t2;
	}

	/* daily / weekly */
	const days = s.days || [];
	if (length(days) && !any_day(days, wday))
		return false;

	const t1 = parse_hhmm(s.time_start);
	const t2 = parse_hhmm(s.time_stop);
	if (t1 == null || t2 == null)
		return true; /* no time window => whole day */

	if (t1 <= t2)
		return now_min >= t1 && now_min < t2;
	/* window crosses midnight */
	return now_min >= t1 || now_min < t2;
};

function any_day(days, wday) {
	for (let i = 0; i < length(days); i++)
		if (wd_index(days[i]) === wday)
			return true;
	return false;
};

function date_to_ts(ymd, hhmm) {
	const m = match(ymd || '', /^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m)
		return null;
	const t = parse_hhmm(hhmm);
	if (t == null)
		return null;
	/* time() with an argument: seconds for the given local date+time */
	return time(sprintf('%04d-%02d-%02d %02d:%02d:00',
		int(m[1]), int(m[2]), int(m[3]), int(t / 60), t % 60));
};

/* Enabled schedules only. */
export function get_schedules() {
	const res = [];
	const all = get_sections('schedule');
	for (let i = 0; i < length(all); i++) {
		const s = all[i];
		if (s.enabled !== '1')
			continue;
		push(res, s);
	}
	return res;
};

/* Temporary blocks: { key: until_epoch } where key is ip or mac. */
export function read_temps() {
	const p = RUN_DIR + '/temps.json';
	if (!access(p))
		return {};
	const raw = readfile(p);
	let t = null;
	try {
		t = json(raw);
	} catch (e) {
		return {};
	}
	const now = time();
	const out = {};
	for (let k in t)
		if (t[k] > now)
			out[k] = t[k];
	return out;
};

export function write_temps(t) {
	mkdir_p(RUN_DIR);
	atomic_write(RUN_DIR + '/temps.json', sprintf('%J', t));
};
