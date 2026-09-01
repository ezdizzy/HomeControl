// SPDX-License-Identifier: GPL-2.0-only
//
// HomeControl enforcement engine: renders nftables rules, dnsmasq config
// and wireless state from the UCI config.
//
// Usage: ucode -L /etc/homecontrol/scripts /etc/homecontrol/scripts/apply.uc
//
// Enforcement model:
//   - blocked clients  -> nft set blocked_v4 (src drop) + blocked_macs
//   - GLOBAL rules (no client list):
//       domains -> main dnsmasq server=/domain/ (NXDOMAIN)
//       IPs     -> nft set blocked_rule_v4 (dst drop, all LAN)
//   - PER-CLIENT rules (rule lists clients):
//       IPs     -> nft set pc_<id>_v4 + src-match drop in block_forward
//       domains -> dedicated dnsmasq filter instance on port 5353+n that
//                  answers NXDOMAIN for those domains; the client's DNS
//                  traffic (UDP/TCP dst 53, ANY upstream) is nft-redirected
//                  to that instance. Instance forwards everything else to
//                  the main dnsmasq, so global blocks still apply on top.
//   - Wi-Fi            -> wireless.<iface>.disabled + marker files; auto
//                         restored when a window closes or temp marker expires

'use strict';

import { access, readfile, writefile, popen, readlink } from 'fs';
import {
	RUN_DIR, atomic_write, mkdir_p, get_sections, main_opt,
	client_states, active_rules, client_rule_targets, wifi_off_map,
	read_wifi_temps, log, add_event
} from 'homecontrol';

const DNSF_DIR = RUN_DIR + '/dnsf';
const DNSF_PORT_BASE = 5353;
const DNSF_MAX = 16; /* safety cap: max parallel filter instances */

/* Make a uci section id safe for nft set names / file names. */
function safe_id(id) {
	return replace(id, /[^A-Za-z0-9_-]/g, '_');
}

/* Resolve the active dnsmasq conf-dir at runtime (OpenWrt names it after the
 * dnsmasq section, e.g. /tmp/dnsmasq.cfg01411c.d). */
function dnsmasq_conf_dir() {
	const fd = popen(
		`grep -m1 -h "^conf-dir=" /var/etc/dnsmasq.conf.* 2>/dev/null | sed -n "s/^conf-dir=//p" | head -n1`);
	if (!fd)
		return '/tmp/dnsmasq.d/homecontrol.d';
	let dir = trim((fd.read('all') || ''));
	fd.close();
	while (length(dir) && substr(dir, length(dir) - 1) === '/')
		dir = substr(dir, 0, length(dir) - 1);
	return length(dir) ? dir : '/tmp/dnsmasq.d/homecontrol.d';
}

const CONF_DIR = dnsmasq_conf_dir();

/* ── nftables render ─────────────────────────────────────────────── */

/* pc:   [ { id, ip, mac, ips: [targets] } ]  — per-client IP rules
 * dnsf: [ { id, ip, mac, port } ]            — active DNS filter clients */
function render_nft(ips, macs, rule_ips, pc, dnsf) {
	const lines = [];
	const ipL = length(ips) ? uniq(ips) : [];
	const macL = length(macs) ? uniq(macs) : [];
	const ripL = length(rule_ips) ? uniq(rule_ips) : [];

	const dnsf_ips = [];
	for (let i = 0; i < length(dnsf); i++)
		if (dnsf[i].ip)
			push(dnsf_ips, dnsf[i].ip);

	push(lines, `table inet homecontrol`);
	push(lines, `delete table inet homecontrol`);
	push(lines, `table inet homecontrol {`);
	push(lines, `	set blocked_v4 {`);
	push(lines, `		type ipv4_addr`);
	push(lines, `		flags interval`);
	if (length(ipL))
		push(lines, `		elements = { ${join(', ', ipL)} }`);
	push(lines, `	}`);
	push(lines, `	set blocked_macs {`);
	push(lines, `		type ether_addr`);
	if (length(macL))
		push(lines, `		elements = { ${join(', ', macL)} }`);
	push(lines, `	}`);
	push(lines, `	set blocked_rule_v4 {`);
	push(lines, `		type ipv4_addr`);
	push(lines, `		flags interval`);
	if (length(ripL))
		push(lines, `		elements = { ${join(', ', ripL)} }`);
	push(lines, `	}`);

	/* per-client IP rule sets */
	for (let i = 0; i < length(pc); i++) {
		const p = pc[i];
		if (!length(p.ips))
			continue;
		push(lines, `	set pc_${safe_id(p.id)}_v4 {`);
		push(lines, `		type ipv4_addr`);
		push(lines, `		flags interval`);
		push(lines, `		elements = { ${join(', ', uniq(p.ips))} }`);
		push(lines, `	}`);
	}

	push(lines, `	set dnsf_v4 {`);
	push(lines, `		type ipv4_addr`);
	push(lines, `		flags interval`);
	if (length(dnsf_ips))
		push(lines, `		elements = { ${join(', ', uniq(dnsf_ips))} }`);
	push(lines, `	}`);

	push(lines, `	chain block_forward {`);
	push(lines, `		type filter hook forward priority -100; policy accept;`);
	push(lines, `		ip saddr @blocked_v4 counter drop`);
	push(lines, `		ether saddr @blocked_macs counter drop`);
	push(lines, `		ip daddr @blocked_rule_v4 counter drop`);
	for (let i = 0; i < length(pc); i++) {
		const p = pc[i];
		if (!length(p.ips))
			continue;
		const sname = `pc_${safe_id(p.id)}_v4`;
		if (p.ip)
			push(lines, `		ip saddr ${p.ip} ip daddr @${sname} counter drop`);
		if (p.mac)
			push(lines, `		ether saddr ${p.mac} ip daddr @${sname} counter drop`);
	}
	/* DNS-filtered clients: block direct DoT/DoQ (853) bypass */
	if (length(dnsf_ips)) {
		push(lines, `		ip saddr @dnsf_v4 tcp dport 853 counter reject`);
		push(lines, `		ip saddr @dnsf_v4 udp dport 853 counter reject`);
	}
	push(lines, `	}`);
	push(lines, `	chain block_output_reject {`);
	push(lines, `		type filter hook output priority -100; policy accept;`);
	push(lines, `		oifname != "lo" ip daddr @blocked_v4 counter reject`);
	push(lines, `	}`);
	push(lines, `	chain dns_redirect {`);
	push(lines, `		type nat hook prerouting priority dstnat; policy accept;`);
	for (let i = 0; i < length(dnsf); i++) {
		const d = dnsf[i];
		if (d.ip) {
			push(lines, `		ip saddr ${d.ip} udp dport 53 redirect to :${d.port}`);
			push(lines, `		ip saddr ${d.ip} tcp dport 53 redirect to :${d.port}`);
		}
		if (d.mac) {
			push(lines, `		ether saddr ${d.mac} udp dport 53 redirect to :${d.port}`);
			push(lines, `		ether saddr ${d.mac} tcp dport 53 redirect to :${d.port}`);
		}
	}
	push(lines, `	}`);
	push(lines, `}`);

	return join('\n', lines) + '\n';
}

/* ── dnsmasq render (GLOBAL domain rules) ────────────────────────── */

function render_dnsmasq(rules) {
	mkdir_p(CONF_DIR);
	const out = [];
	for (let i = 0; i < length(rules); i++) {
		const r = rules[i];
		if ((r.type || 'domain') !== 'domain')
			continue;
		const targets = r.target || [];
		for (let k = 0; k < length(targets); k++)
			if (length(targets[k]) > 2)
				push(out, `server=/${targets[k]}/`);
	}
	const content = length(out) ? (join('\n', out) + '\n') : '';

	/* Skip restart when content did not change (avoids DNS blips). */
	const path = CONF_DIR + '/blocked.conf';
	const old = access(path) ? readfile(path) : '';
	if (old === content)
		return false;
	atomic_write(path, content);
	return true;
}

/* ── per-client dnsmasq filter instances ─────────────────────────── */

function dnsf_conf_content(safe, port) {
	const lines = [
		'# generated by homecontrol apply — do not edit',
		`port=${port}`,
		'no-resolv',
		'server=127.0.0.1#53',
		'no-hosts',
		'cache-size=300',
		'local-ttl=1',
		`pid-file=${DNSF_DIR}/${safe}.pid`,
		`conf-file=${DNSF_DIR}/domains.${safe}.conf`,
		`log-facility=${DNSF_DIR}/${safe}.log`
	];
	return join('\n', lines) + '\n';
}

function dnsf_domains_content(domains) {
	const lines = [];
	for (let i = 0; i < length(domains); i++)
		if (length(domains[i]) > 2)
			push(lines, `server=/${domains[i]}/`);
	return length(lines) ? (join('\n', lines) + '\n') : '';
}

/* Is the filter instance for `safe` actually alive (pidfile + /proc exe)?
 * NOTE: /proc/<pid>/cmdline contains NUL bytes and ucode regex matching
 * truncates at the first NUL — use /proc/<pid>/exe instead. */
function dnsf_running(safe) {
	const pidp = `${DNSF_DIR}/${safe}.pid`;
	if (!access(pidp))
		return false;
	const pid = int(trim(readfile(pidp) || '')) || 0;
	if (pid < 2)
		return false;
	const exe = access(`/proc/${pid}/exe`) ? (readlink(`/proc/${pid}/exe`) || '') : '';
	return match(exe || '', /dnsmasq/) ? true : false;
}

function stop_dnsf(safe) {
	const pidp = `${DNSF_DIR}/${safe}.pid`;
	if (access(pidp)) {
		const pid = int(trim(readfile(pidp) || '')) || 0;
		if (pid >= 2 && system(`kill -0 ${pid} 2>/dev/null`) === 0)
			system(`kill ${pid} 2>/dev/null`);
	}
	system(`rm -f '${DNSF_DIR}/${safe}.pid'`);
}

/* Make sure a filter instance is running with this exact config.
 * Returns true when the instance is alive afterwards. */
function ensure_dnsf(safe, port, domains, label) {
	mkdir_p(DNSF_DIR);
	const confp = `${DNSF_DIR}/${safe}.conf`;
	const domp = `${DNSF_DIR}/domains.${safe}.conf`;

	const ccontent = dnsf_conf_content(safe, port);
	const dcontent = dnsf_domains_content(domains);
	const oldc = access(confp) ? readfile(confp) : '';
	const oldd = access(domp) ? readfile(domp) : '';

	if (oldc === ccontent && oldd === dcontent && dnsf_running(safe))
		return true;

	atomic_write(confp, ccontent);
	atomic_write(domp, dcontent);
	stop_dnsf(safe);
	system(`dnsmasq -C '${confp}' >/dev/null 2>&1`);
	sleep(1);
	if (dnsf_running(safe)) {
		log(`dnsf ${label}: filter instance on port ${port} (${length(domains)} domains)`);
		return true;
	}
	log(`dnsf ${label}: FAILED to start on port ${port}`);
	return false;
}

/* Kill filter instances that are no longer needed. */
function cleanup_dnsf(wanted) {
	mkdir_p(DNSF_DIR);
	const fd = popen(`ls ${DNSF_DIR}/*.conf 2>/dev/null`);
	if (!fd)
		return;
	const raw = fd.read('all') || '';
	fd.close();
	const files = split(trim(raw), /\n/);
	for (let i = 0; i < length(files); i++) {
		const f = trim(files[i]);
		const m = match(f, /\/([^\/]+)\.conf$/);
		if (!m)
			continue;
		const safe = m[1];
		if (substr(safe, 0, 8) === 'domains.')
			continue;
		if (safe in wanted)
			continue;
		stop_dnsf(safe);
		system(`rm -f '${DNSF_DIR}/${safe}.conf' '${DNSF_DIR}/domains.${safe}.conf' '${DNSF_DIR}/${safe}.log'`);
		log(`dnsf ${safe}: filter removed (no active per-client rules)`);
	}
}

/* ── wireless management ─────────────────────────────────────────── */

/* Only touch ifaces we manage: those in the off map, the registry, or
 * ifaces we disabled before (markers) — the last group must be enumerated
 * so we can restore them after a window closes / temp marker expires. */
function apply_wifi(off_map) {
	const wifis = get_sections('wifi');
	const managed = {};
	for (let k in off_map)
		managed[k] = true;
	for (let i = 0; i < length(wifis); i++)
		if (wifis[i].network)
			managed[wifis[i].network] = true;

	/* ifaces with our markers (off/on/temp) are ours to restore/clean */
	const fd0 = popen(`ls ${RUN_DIR}/wifi.off.* ${RUN_DIR}/wifi.on.* ${RUN_DIR}/wifi.temp.* 2>/dev/null`);
	if (fd0) {
		const raw0 = fd0.read('all') || '';
		fd0.close();
		const files0 = split(trim(raw0), /\n/);
		for (let i = 0; i < length(files0); i++) {
			const m = match(trim(files0[i]), /wifi\.(off|on|temp)\.(.+)$/);
			if (m && length(m[2]))
				managed[m[2]] = true;
		}
	}

	let changed = false;
	for (let iface in managed) {
		if (!iface)
			continue;
		const want_off = (off_map[iface] === true);
		const offMarker = `${RUN_DIR}/wifi.off.${iface}`;
		const onMarker = `${RUN_DIR}/wifi.on.${iface}`;

		const fd = popen(`uci -q get wireless.${iface}.disabled 2>/dev/null`);
		const cur = fd ? trim((fd.read('all') || '')) : '';
		if (fd)
			fd.close();

		if (want_off) {
			system(`rm -f '${onMarker}'`);
			if (cur !== '1') {
				system(`uci -q set wireless.${iface}.disabled='1'`);
				system(`touch '${offMarker}'`);
				add_event('wifi', iface, 'turned off (schedule/timer)');
				changed = true;
			}
		} else {
			/* Window closed: re-enable only what WE disabled. */
			if (access(offMarker)) {
				system(`rm -f '${offMarker}'`);
				if (cur === '1') {
					system(`uci -q delete wireless.${iface}.disabled`);
					add_event('wifi', iface, 'turned on (window ended)');
					changed = true;
				}
			}
		}

		/* drop expired temp markers */
		const tempMarker = `${RUN_DIR}/wifi.temp.${iface}`;
		if (access(tempMarker)) {
			const tu = int(trim(readfile(tempMarker) || '')) || 0;
			if (tu <= now)
				system(`rm -f '${tempMarker}'`);
		}
	}

	if (changed)
		system(`wifi reload 2>/dev/null`);
	return changed;
}

/* ── main ────────────────────────────────────────────────────────── */

mkdir_p(RUN_DIR);
mkdir_p(CONF_DIR);
mkdir_p(DNSF_DIR);

const now = time();
const enabled = main_opt('enabled', '0') === '1';

let ips = [], macs = [], rule_ips = [];
let global_rules = [];   /* global domain rules -> main dnsmasq */
let pc = [];             /* per-client IP rules for nft */
let dnsf_want = [];      /* per-client domain rules -> filter instances */
let dnsf = [];           /* ACTIVE filter clients (for nft redirect) */
let woff = {};

if (enabled) {
	const states = client_states(now);
	for (let i = 0; i < length(states); i++) {
		if (!states[i].blocked)
			continue;
		if (states[i].ip)
			push(ips, states[i].ip);
		if (states[i].mac)
			push(macs, states[i].mac);
	}

	const all_rules = active_rules(now);
	for (let i = 0; i < length(all_rules); i++) {
		const r = all_rules[i];
		/* rules that list clients are per-client, handled below */
		const cids = r.client_ids || [];
		if (length(cids))
			continue;
		if ((r.type || 'domain') === 'ip') {
			const targets = r.target || [];
			for (let k = 0; k < length(targets); k++)
				push(rule_ips, targets[k]);
		} else {
			push(global_rules, r);
		}
	}

	/* per-client rule targets, resolved to client ip/mac */
	const crt = client_rule_targets(now);
	const clients = get_sections('client');
	const byid = {};
	for (let i = 0; i < length(clients); i++)
		byid[clients[i].id] = clients[i];

	const cids_sorted = [];
	for (let cid in crt)
		push(cids_sorted, cid);
	sort(cids_sorted);

	for (let i = 0; i < length(cids_sorted); i++) {
		const cid = cids_sorted[i];
		const c = byid[cid] || {};
		if (!c.ip && !c.mac) {
			log(`dnsf ${cid}: skipped, client has no ip/mac`);
			continue;
		}
		if (length(crt[cid].ips))
			push(pc, { id: cid, ip: c.ip || '', mac: c.mac || '', ips: crt[cid].ips });
		if (length(crt[cid].domains) && length(dnsf_want) < DNSF_MAX)
			push(dnsf_want, { id: cid, ip: c.ip || '', mac: c.mac || '', domains: crt[cid].domains });
	}

	woff = wifi_off_map(now);
}

/* start/restart filter instances (even when disabled -> none wanted) */
for (let i = 0; i < length(dnsf_want); i++) {
	const d = dnsf_want[i];
	const safe = safe_id(d.id);
	const port = DNSF_PORT_BASE + i;
	if (ensure_dnsf(safe, port, d.domains, d.id)) {
		push(dnsf, { id: d.id, safe: safe, port: port, ip: d.ip, mac: d.mac, n: length(d.domains) });
	} else {
		add_event('system', d.id, 'per-client DNS filter failed to start — client falls back to global DNS');
	}
}

/* remove stale filter instances */
const wanted = {};
for (let i = 0; i < length(dnsf); i++)
	wanted[dnsf[i].safe] = true;
cleanup_dnsf(wanted);

/* persist the active instance map for the UI */
const insts = [];
for (let i = 0; i < length(dnsf); i++)
	push(insts, { id: dnsf[i].id, port: dnsf[i].port, domains: dnsf[i].n });
atomic_write(DNSF_DIR + '/instances.json', sprintf('%J', insts) + '\n');

const nft_file = RUN_DIR + '/fw4_pre.nft';
writefile(nft_file, render_nft(ips, macs, rule_ips, pc, dnsf));
system(`nft -f '${nft_file}' 2>/dev/null`);

const dns_changed = render_dnsmasq(global_rules);
if (dns_changed)
	system(`/etc/init.d/dnsmasq restart >/dev/null 2>&1`);

apply_wifi(woff);

log(`applied: enabled=${enabled} clients=${length(ips)}/${length(macs)} rule_ips=${length(rule_ips)} pc_rules=${length(pc)} dns_filters=${length(dnsf)} dns_domains_applied=${length(global_rules) ? 'y' : 'n'} dns_restart=${dns_changed ? 'y' : 'n'} wifi_off=${length(keys(woff))}`);
print(`homecontrol applied: ${length(ips)} ip, ${length(macs)} mac, ${length(rule_ips)} rule-ip, ${length(pc)} pc-rules, ${length(dnsf)} dns-filters\n`);
