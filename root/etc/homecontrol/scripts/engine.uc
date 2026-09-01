// SPDX-License-Identifier: GPL-2.0-only
//
// HomeControl schedule watcher ("engine"): a lightweight procd-managed loop
// that watches the EFFECTIVE enforcement state and re-runs apply.uc only
// when something changed (schedule boundaries, temporary block expiry,
// Wi-Fi markers, rule windows). Checks once a minute, so schedule windows
// open/close within a minute of the boundary.

'use strict';

import {
	client_states, active_rules, wifi_off_map, read_wifi_temps,
	read_temps, main_opt, log
} from 'homecontrol';

const TICK = 60; /* seconds per check */

function state_signature(now) {
	const parts = [];

	push(parts, 'en=' + (main_opt('enabled', '0') === '1' ? 1 : 0));
	push(parts, 'pz=' + (main_opt('paused', '0') === '1' ? 1 : 0));

	const states = client_states(now);
	for (let i = 0; i < length(states); i++) {
		const c = states[i];
		/* ip/mac included: DHCP change must re-render nft/redirect rules */
		push(parts, `${c.id}=${c.blocked ? c.reason : '0'}@${c.until || 0}@${c.ip || ''}@${c.mac || ''}`);
	}

	const rules = active_rules(now);
	for (let i = 0; i < length(rules); i++)
		push(parts, `r:${rules[i].id}:${join(',', rules[i].client_ids || [])}:${join(',', rules[i].target || [])}=1`);

	const temps = read_temps();
	for (let k in temps)
		push(parts, `tmp:${k}@${temps[k]}`);

	const woff = wifi_off_map(now);
	const wkeys = [];
	for (let k in woff)
		push(wkeys, k);
	push(wkeys, 'n=' + length(wkeys));
	push(parts, 'w:' + join(',', wkeys));

	const wtemps = read_wifi_temps();
	for (let k in wtemps)
		push(parts, `wt:${k}@${wtemps[k]}`);

	return join('|', parts);
}

let last_sig = null;

function tick(now) {
	const sig = state_signature(now);
	if (sig === last_sig)
		return;
	last_sig = sig;
	log('state changed, re-applying.');
	system(`/usr/bin/ucode -L /etc/homecontrol/scripts /etc/homecontrol/scripts/apply.uc >/dev/null 2>&1`);
}

/* Main loop: run forever, procd respawns us if we die. */
while (true) {
	const now = time();
	try {
		tick(now);
	} catch (e) {
		log('tick error: ' + e);
	}
	sleep(TICK);
}
