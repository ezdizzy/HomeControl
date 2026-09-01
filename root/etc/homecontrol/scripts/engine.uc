// SPDX-License-Identifier: GPL-2.0-only
//
// HomeControl schedule watcher ("engine"): a lightweight procd-managed loop
// that re-applies the enforcement state once a minute so schedule windows
// open/close on time and temporary blocks expire exactly when they should.
//
// The heavy lifting (nft/dnsmasq/wifi rendering) lives in apply.uc; the
// engine only decides WHEN to call it. It avoids needless churn by hashing
// the effective state and re-running apply only when something changed OR
// when the minute boundary could have crossed a schedule edge.

'use strict';

import { access, readfile, writefile } from 'fs';
import {
	RUN_DIR, get_sections, get_schedules, read_temps, log, atomic_write,
	schedule_active
} from 'homecontrol';

const TICK = 60;          /* seconds per check */

function state_signature(now) {
	/* Anything that changes enforcement output must change this signature:
	 * enabled, paused, blocked clients, temp blocks, active schedules. */
	const clients = get_sections('client');
	const temps = read_temps();
	const schs = get_schedules();

	const parts = [];

	const enabled = (function() {
		const uc_cursor = require('uci').cursor();
		return uc_cursor.get('homecontrol', 'main', 'enabled');
	})();
	push(parts, 'en=' + (enabled === '1' ? 1 : 0));

	for (let i = 0; i < length(clients); i++) {
		const c = clients[i];
		let b = '0';
		if (c.blocked === '1')
			b = '1';
		else if ((c.ip && temps[c.ip]) || (c.mac && temps[c.mac]))
			b = 't';
		else {
			for (let j = 0; j < length(schs); j++) {
				const s = schs[j];
				const cids = s.client_ids || [];
				let mine = false;
				for (let k = 0; k < length(cids); k++)
					if (cids[k] === c.id || cids[k] === c.name)
						mine = true;
				if (mine && schedule_active(s, now) && (s.action || 'deny') === 'deny') {
					b = 's';
					break;
				}
			}
		}
		push(parts, c.id + '=' + b);
	}

	let keys_tmp = [];
	for (let k in temps)
		push(keys_tmp, k);
	for (let i = 0; i < length(keys_tmp); i++)
		push(parts, 'tmp:' + keys_tmp[i] + '@' + temps[keys_tmp[i]]);

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
