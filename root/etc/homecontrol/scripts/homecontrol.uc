// SPDX-License-Identifier: GPL-2.0-only
//
// HomeControl shared library: config access, state computation, logging.
// Used by apply.uc (enforcer), engine.uc (watcher) and the rpcd backend.
//
// NOTE: this ucode build (2026.01.16):
//  - top-level `export function ... { ... }` in modules REQUIRES a trailing
//    `;` after the closing brace, or the module fails to import;
//  - `json()` only PARSES (string -> object); to stringify use sprintf('%J');
//  - no Array.prototype.push/map; use global push()/join()/filter builtins;
//  - `for (const k in obj)` is invalid — use `for (let k in obj)`;
//  - localtime() returns a FULL year in .year (2026, not 126) and 1-based
//    .mon; do NOT add 1900/+1;
//  - `export` is only valid in module context: `ucode -c lib.uc` always
//    prints "Exports may only appear at top level of a module" — that is
//    EXPECTED for library files, verify via a test import instead;
//  - ucode uci cursors snapshot config at creation; keep a short TTL cache.

'use strict';

import { access, readfile, writefile, open, popen } from 'fs';
import { cursor } from 'uci';

export const CONF = 'homecontrol';
export const RUN_DIR = '/var/run/homecontrol';
export const STATE_DIR = '/etc/homecontrol';
export const LOG_PATH = RUN_DIR + '/homecontrol.log';
export const EVENTS_PATH = RUN_DIR + '/events.json';

let _cursor = null;
let _cursor_ts = 0;

export function get_cursor() {
	const now = time();
	if (!_cursor || (now - _cursor_ts) > 2) {
		_cursor = cursor();
		_cursor_ts = now;
	}
	return _cursor;
};

export function systime_stamp() {
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
		type: type,        /* block, allow, wifi, schedule, temp, system, update */
		who: who || '',
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
	return time(sprintf('%04d-%02d-%02d %02d:%02d:00',
		int(m[1]), int(m[2]), int(m[3]), int(t / 60), t % 60));
};

/* Is the schedule section s active right now?
 *  daily  - time window each day (may cross midnight)
 *  weekly - time window on selected weekdays
 *  range  - whole-day window between two dates
 *  timer  - one-shot absolute window (date_start+time_start .. date_stop+time_stop)
 */
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

/* Temporary client blocks: { key: until_epoch } (key = ip or mac). */
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

/* Temporary Wi-Fi off markers: { iface: until_epoch }. */
export function read_wifi_temps() {
	mkdir_p(RUN_DIR);
	const out = {};
	const fd = popen(`ls ${RUN_DIR}/wifi.temp.* 2>/dev/null`);
	if (!fd)
		return out;
	const raw = fd.read('all') || '';
	fd.close();
	const files = split(trim(raw), /\n/);
	const now = time();
	for (let i = 0; i < length(files); i++) {
		const f = trim(files[i]);
		const m = match(f, /wifi\.temp\.(.+)$/);
		if (!m)
			continue;
		const until = int(trim(readfile(f) || '')) || 0;
		if (until > now)
			out[m[1]] = until;
	}
	return out;
};

export function wifi_temp_set(iface, until) {
	mkdir_p(RUN_DIR);
	writefile(`${RUN_DIR}/wifi.temp.${iface}`, '' + until + '\n');
};

export function wifi_temp_clear(iface) {
	system(`rm -f '${RUN_DIR}/wifi.temp.${iface}'`);
};

/* ── Effective state computation (shared by apply/engine/rpcd) ──────── */

/* Per-client effective state:
 * { id, name, ip, mac, blocked, reason: manual|temp|schedule, until } */
export function client_states(now) {
	const temps = read_temps();
	const paused = main_opt('paused', '0') === '1';
	const clients = get_sections('client');
	const schs = get_schedules();
	const out = [];

	for (let i = 0; i < length(clients); i++) {
		const c = clients[i];
		let blocked = false, reason = '', until = 0;

		if (!paused) {
			if (c.blocked === '1') {
				blocked = true;
				reason = 'manual';
			}
			const t_until = (c.ip && temps[c.ip]) ? temps[c.ip] : (c.mac && temps[c.mac]) ? temps[c.mac] : 0;
			if (!blocked && t_until) {
				blocked = true;
				reason = 'temp';
				until = t_until;
			}
			if (!blocked) {
				let allow_bound = false, allow_active = false;
				for (let j = 0; j < length(schs); j++) {
					const s = schs[j];
					const cids = s.client_ids || [];
					if (!length(cids))
						continue;
					let mine = false;
					for (let k = 0; k < length(cids); k++)
						if (cids[k] === c.id || cids[k] === c.name)
							mine = true;
					if (!mine)
						continue;
					const act = schedule_active(s, now);
					const deny = (s.action || 'deny') === 'deny';
					if (deny) {
						if (act) {
							blocked = true;
							reason = 'schedule';
							break;
						}
					} else {
						allow_bound = true;
						if (act)
							allow_active = true;
					}
				}
				if (!blocked && allow_bound && !allow_active) {
					blocked = true;
					reason = 'schedule';
				}
			}
		}

		push(out, {
			id: c.id,
			name: c.name || c.ip || c.mac || '?',
			ip: c.ip || '',
			mac: c.mac || '',
			blocked: blocked,
			reason: reason,
			until: until
		});
	}
	return out;
};

/* Rules to enforce right now (enabled, not paused-for, inside time window).
 * Empty when global pause ("allow everything") is on. */
export function active_rules(now) {
	const out = [];
	if (main_opt('paused', '0') === '1')
		return out;
	const rules = get_sections('rule');
	for (let i = 0; i < length(rules); i++) {
		const r = rules[i];
		if (r.enabled !== '1')
			continue;
		/* temporary pause (e.g. "allow for 1h") */
		const du = int(r.disabled_until) || 0;
		if (du > now)
			continue;
		/* embedded daily/weekly window */
		if (r.time_start || r.time_stop || (r.days && length(r.days))) {
			const probe = { type: 'daily', time_start: r.time_start, time_stop: r.time_stop, days: r.days };
			if (!schedule_active(probe, now))
				continue;
		}
		/* embedded date range */
		if (r.date_start || r.date_stop) {
			const probe = { type: 'range', date_start: r.date_start, date_stop: r.date_stop };
			if (!schedule_active(probe, now))
				continue;
		}
		push(out, r);
	}
	return out;
};

function in_list(arr, v) {
	for (let i = 0; i < length(arr); i++)
		if (arr[i] === v)
			return true;
	return false;
};

/* Per-client rule targets active right now — only rules that list clients
 * (client_ids). Rules with an EMPTY client_ids list are GLOBAL and handled
 * separately (main dnsmasq blocked.conf / blocked_rule_v4 set).
 * Returns { client_section_id: { domains: [...], ips: [...] } } */
export function client_rule_targets(now) {
	const out = {};
	const rules = active_rules(now);
	const clients = get_sections('client');

	for (let i = 0; i < length(rules); i++) {
		const r = rules[i];
		const cids = r.client_ids || [];
		if (!length(cids))
			continue;
		const rtype = r.type || 'domain';
		const targets = r.target || [];
		for (let k = 0; k < length(cids); k++) {
			/* resolve the rule's client ref (section id or name) to a real client */
			let cid = '';
			for (let c = 0; c < length(clients); c++)
				if (clients[c].id === cids[k] || clients[c].name === cids[k])
					cid = clients[c].id;
			if (!cid)
				continue;
			if (!out[cid])
				out[cid] = { domains: [], ips: [] };
			for (let t = 0; t < length(targets); t++) {
				const v = targets[t];
				if (!length(v))
					continue;
				if (rtype === 'ip') {
					if (!in_list(out[cid].ips, v))
						push(out[cid].ips, v);
				} else if (length(v) > 2) {
					if (!in_list(out[cid].domains, v))
						push(out[cid].domains, v);
				}
			}
		}
	}
	return out;
};

/* Wi-Fi ifaces that must be OFF right now:
 *  - deny-schedule active, OR allow-schedule outside its window;
 *  - temp off markers (auto-expiring). */
export function wifi_off_map(now) {
	const off = {};
	const schs = get_schedules();
	const wifis = get_sections('wifi');

	function resolve(wid) {
		for (let n = 0; n < length(wifis); n++)
			if (wifis[n].id === wid || wifis[n].name === wid)
				return wifis[n].network || wid;
		return wid;
	}

	for (let j = 0; j < length(schs); j++) {
		const s = schs[j];
		const wids = s.wifi_ids || [];
		if (!length(wids))
			continue;
		const act = schedule_active(s, now);
		const deny = (s.action || 'deny') === 'deny';
		/* deny+active => off; allow+outside-window => off ("Wi-Fi only during...") */
		if (act === deny) {
			for (let k = 0; k < length(wids); k++) {
				const iface = resolve(wids[k]);
				if (iface)
					off[iface] = true;
			}
		}
	}

	const wtemps = read_wifi_temps();
	for (let k in wtemps)
		off[k] = true;

	return off;
};

/* Semantic version compare: -1 a<b, 0 equal, 1 a>b. */
export function vercmp(a, b) {
	const sa = split(a || '', '.'), sb = split(b || '', '.');
	const pa = [], pb = [];
	for (let i = 0; i < length(sa); i++)
		push(pa, int(sa[i]) || 0);
	for (let i = 0; i < length(sb); i++)
		push(pb, int(sb[i]) || 0);
	const n = max(length(pa), length(pb));
	for (let i = 0; i < n; i++) {
		const x = pa[i] || 0, y = pb[i] || 0;
		if (x < y)
			return -1;
		if (x > y)
			return 1;
	}
	return 0;
};
