// SPDX-License-Identifier: GPL-2.0-only
//
// HomeControl enforcement engine: renders nftables rules, dnsmasq config
// and wireless state from the UCI config.
//
// Usage: ucode -L /etc/homecontrol/scripts /etc/homecontrol/scripts/apply.uc
//
// Enforcement model:
//   - blocked clients  -> nft set blocked_v4 (src drop) + blocked_macs
//   - rule IP targets  -> nft set blocked_rule_v4 (dst drop/reject, all LAN)
//   - rule domains     -> dnsmasq server=/domain/ (NXDOMAIN), only when the
//                         rule's time window is active
//   - Wi-Fi            -> wireless.<iface>.disabled + marker files; auto
//                         restored when a window closes or temp marker expires

'use strict';

import { access, readfile, writefile, popen } from 'fs';
import {
	RUN_DIR, atomic_write, mkdir_p, get_sections, main_opt,
	client_states, active_rules, wifi_off_map, read_wifi_temps, log
} from 'homecontrol';

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

function render_nft(ips, macs, rule_ips) {
	const lines = [];
	const ipL = length(ips) ? uniq(ips) : [];
	const macL = length(macs) ? uniq(macs) : [];
	const ripL = length(rule_ips) ? uniq(rule_ips) : [];

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
	push(lines, `	chain block_forward {`);
	push(lines, `		type filter hook forward priority -100; policy accept;`);
	push(lines, `		ip saddr @blocked_v4 counter drop`);
	push(lines, `		ether saddr @blocked_macs counter drop`);
	push(lines, `		ip daddr @blocked_rule_v4 counter drop`);
	push(lines, `	}`);
	push(lines, `	chain block_output_reject {`);
	push(lines, `		type filter hook output priority -100; policy accept;`);
	push(lines, `		oifname != "lo" ip daddr @blocked_v4 counter reject`);
	push(lines, `	}`);
	push(lines, `}`);

	return join('\n', lines) + '\n';
}

/* ── dnsmasq render (domain rules) ───────────────────────────────── */

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

const now = time();
const enabled = main_opt('enabled', '0') === '1';

let ips = [], macs = [], rule_ips = [];
let rules = [];
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

	rules = active_rules(now);
	for (let i = 0; i < length(rules); i++) {
		if ((rules[i].type || '') !== 'ip')
			continue;
		const targets = rules[i].target || [];
		for (let k = 0; k < length(targets); k++)
			push(rule_ips, targets[k]);
	}

	woff = wifi_off_map(now);
}

const nft_file = RUN_DIR + '/fw4_pre.nft';
writefile(nft_file, render_nft(ips, macs, rule_ips));
system(`nft -f '${nft_file}' 2>/dev/null`);

const dns_changed = render_dnsmasq(rules);
if (dns_changed)
	system(`/etc/init.d/dnsmasq restart >/dev/null 2>&1`);

apply_wifi(woff);

log(`applied: enabled=${enabled} clients=${length(ips)}/${length(macs)} rule_ips=${length(rule_ips)} dns_domains_applied=${length(rules) ? 'y' : 'n'} dns_restart=${dns_changed ? 'y' : 'n'} wifi_off=${length(keys(woff))}`);
print(`homecontrol applied: ${length(ips)} ip, ${length(macs)} mac, ${length(rule_ips)} rule-ip\n`);
