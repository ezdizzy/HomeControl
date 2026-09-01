// SPDX-License-Identifier: GPL-2.0-only
//
// HomeControl enforcement engine: renders nftables rules, dnsmasq
// configuration and wireless (WiFi) state from the UCI config.
//
// Usage:
//   ucode -L /etc/homecontrol/scripts /etc/homecontrol/scripts/apply.uc
//
// Exit codes: 0 = applied, 1 = failed.

'use strict';

import { readfile, access, writefile, popen } from 'fs';
import {
	CONF, RUN_DIR, NFT_PRE, atomic_write, mkdir_p, get_sections,
	sec_opt, main_opt, get_schedules, schedule_active, read_temps,
	log, add_event
} from 'homecontrol';

const DNSMASQ_DIR = '/tmp/dnsmasq.d/homecontrol.d';

/* Resolve the active dnsmasq conf-dir at runtime: OpenWrt names it
 * /tmp/dnsmasq.conf.cfgXXXXX on disk and points conf-dir at a section-named
 * directory (e.g. /tmp/dnsmasq.cfg01411c.d), not statically. */
function dnsmasq_conf_dir() {
	const fd = popen(
		`grep -m1 -h "^conf-dir=" /var/etc/dnsmasq.conf.* 2>/dev/null | sed -n "s/^conf-dir=//p" | head -n1`);
	if (!fd)
		return DNSMASQ_DIR;
	let dir = trim((fd.read('all') || ''));
	fd.close();
	if (dir && access('/proc/')) {
		/* strip trailing slash */
		while (substr(dir, length(dir) - 1) === '/')
			dir = substr(dir, 0, length(dir) - 1);
	}
	if (length(dir))
		return dir;
	return DNSMASQ_DIR;
}

const CONF_DIR = dnsmasq_conf_dir();

function sh(cmd) {
	return system(cmd);
}

/* ── Collect clients ─────────────────────────────────────────────── */

function collect_blocked_clients(now) {
	/* Returns { ips: [], macs: [] } of currently blocked clients. */
	const temps = read_temps();
	const ips = [], macs = [];
	const clients = get_sections('client');
	const paused = main_opt('paused', '0') === '1';

	if (paused)
		return { ips: ips, macs: macs };

	for (let i = 0; i < length(clients); i++) {
		const c = clients[i];
		let blocked = false;

		/* manual quick toggle */
		if (c.blocked === '1')
			blocked = true;

		/* temporary block */
		if (!blocked && c.ip && temps[c.ip])
			blocked = true;
		if (!blocked && c.mac && temps[c.mac])
			blocked = true;

		/* schedules referencing this client (deny action) */
		if (!blocked) {
			const schs = get_schedules();
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
				if (schedule_active(s, now) && (s.action || 'deny') === 'deny') {
					blocked = true;
					break;
				}
			}
		}

		if (blocked) {
			if (c.ip)
				push(ips, c.ip);
			if (c.mac)
				push(macs, c.mac);
		}
	}
	return { ips: ips, macs: macs };
}

/* Collect WiFi overrides currently enforced (iface -> disabled state).
 * A schedule may force a wifi iface off. Returns { iface_name: true }. */
function collect_wifi_off(now) {
	const off = {};
	const schs = get_schedules();
	const wifis = get_sections('wifi');
	for (let j = 0; j < length(schs); j++) {
		const s = schs[j];
		const wids = s.wifi_ids || [];
		if (!length(wids))
			continue;
		if (!schedule_active(s, now))
			continue;
		if ((s.action || 'deny') !== 'deny')
			continue;
		for (let k = 0; k < length(wids); k++)
			for (let n = 0; n < length(wifis); n++)
				if (wifis[n].id === wids[k] || wifis[n].name === wids[k])
					off[wifis[n].network] = true;
	}
	return off;
}

/* ── nftables render ─────────────────────────────────────────────── */

function render_nft(blocked) {
	const lines = [];
	const ips = length(blocked.ips) ? uniq(blocked.ips) : [];
	const macs = length(blocked.macs) ? uniq(blocked.macs) : [];

	/* Note: this ucode build has no Array.prototype.push, so use the
	 * global push() and join() builtins explicitly. */
	push(lines, `table inet homecontrol`);
	push(lines, `delete table inet homecontrol`);
	push(lines, `table inet homecontrol {`);
	push(lines, `	set blocked_v4 {`);
	push(lines, `		type ipv4_addr`);
	push(lines, `		flags interval`);
	if (length(ips))
		push(lines, `		elements = { ${join(', ', ips)} }`);
	push(lines, `	}`);
	push(lines, `	set blocked_macs {`);
	push(lines, `		type ether_addr`);
	if (length(macs))
		push(lines, `		elements = { ${join(', ', macs)} }`);
	push(lines, `	}`);
	push(lines, `	chain block_forward {`);
	push(lines, `		type filter hook forward priority -100; policy accept;`);
	push(lines, `		ip saddr @blocked_v4 counter drop`);
	push(lines, `		ether saddr @blocked_macs counter drop`);
	push(lines, `	}`);
	push(lines, `	chain block_output_reject {`);
	push(lines, `		type filter hook output priority -100; policy accept;`);
	push(lines, `		oifname != "lo" ip daddr @blocked_v4 counter reject`);
	push(lines, `	}`);
	push(lines, `}`);

	return join('\n', lines) + '\n';
}

/* ── dnsmasq render (site blocking via rules) ────────────────────── */

function render_dnsmasq() {
	mkdir_p(CONF_DIR);

	/* Collect domains from enabled rules with action=block and type=domain. */
	const domains = [];
	const addresses = []; /* ip targets to blackhole */
	const rules = get_sections('rule');

	for (let i = 0; i < length(rules); i++) {
		const r = rules[i];
		if (r.enabled !== '1')
			continue;
		const targets = r.target || [];
		for (let k = 0; k < length(targets); k++) {
			const t = targets[k];
			if (r.type === 'domain' && length(t) > 2)
				push(domains, t);
			else if (r.type === 'ip')
				push(addresses, t);
		}
	}

	/* Global block: server config to answer blocked domains with NXDOMAIN.
	 * Applied for ALL LAN clients via the shared conf-dir. */
	const out = [];
	for (let i = 0; i < length(domains); i++)
		push(out, `server=/${domains[i]}/`);
	atomic_write(CONF_DIR + '/blocked.conf', join('\n', out) + (length(out) ? '\n' : ''));

	return {
		domains: length(domains),
		ips: length(addresses)
	};
}

/* ── wireless render (managed WiFi on/off) ───────────────────────── */

function apply_wifi(off_map) {
	const wifis = get_sections('wifi');
	let changed = false;

	for (let i = 0; i < length(wifis); i++) {
		const w = wifis[i];
		const iface = w.network;
		if (!iface)
			continue;
		const want_off = (off_map[iface] === true) || (w.disabled === '1');
		const cur = system(`uci -q get wireless.\${iface}.disabled 2>/dev/null; echo `);

		/* We only manage ifaces we are configured to manage. */
		if (want_off) {
			if (system(`uci -q get wireless.\${iface}.disabled | grep -q 1`) !== 0) {
				sh(`uci -q set wireless.${iface}.disabled='1'`);
				changed = true;
				add_event('wifi', iface, 'disabled by rule');
			}
		} else if (w.disabled !== '1') {
			/* Only re-enable if we disabled it before (marker file). */
			if (access(RUN_DIR + '/wifi.off.' + iface)) {
				sh(`uci -q delete wireless.${iface}.disabled`);
				sh(`rm -f '${RUN_DIR}/wifi.off.${iface}'`);
				changed = true;
				add_event('wifi', iface, 'enabled');
			}
		}

		if (want_off)
			sh(`touch '${RUN_DIR}/wifi.off.${iface}'`);
		else
			sh(`rm -f '${RUN_DIR}/wifi.off.${iface}'`);
	}

	if (changed)
		sh(`wifi reload`);
	return changed;
}

/* ── main ────────────────────────────────────────────────────────── */

mkdir_p(RUN_DIR);
mkdir_p(CONF_DIR);

const now = time();
const enabled = main_opt('enabled', '0') === '1';

let blocked = { ips: [], macs: [] };
if (enabled)
	blocked = collect_blocked_clients(now);

const dns_stat = render_dnsmasq();
writefile(NFT_PRE, render_nft(blocked));
sh(`nft -f '${NFT_PRE}' 2>/dev/null`);

if (enabled)
	apply_wifi(collect_wifi_off(now));

sh(`/etc/init.d/dnsmasq restart >/dev/null 2>&1`);

log(`applied: enabled=${enabled} blocked_v4=${length(blocked.ips)} blocked_macs=${length(blocked.macs)} dns_domains=${dns_stat.domains}`);
print(`homecontrol applied: ${length(blocked.ips)} ip, ${length(blocked.macs)} mac, ${dns_stat.domains} domains\n`);
