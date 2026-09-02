/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * HomeControl - Clients management: add/remove clients (by hand: name,
 * IP and/or MAC), quick block toggles, custom-time temporary blocks.
 */

'use strict';
'require poll';
'require rpc';
'require uci';
'require ui';
'require view';

const callStatus = rpc.declare({
	object: 'luci.homecontrol',
	method: 'status',
	expect: { '': {} }
});

const callAdd = rpc.declare({
	object: 'luci.homecontrol',
	method: 'client_add',
	expect: { '': {} }
});

const callDelete = rpc.declare({
	object: 'luci.homecontrol',
	method: 'client_delete',
	expect: { '': {} }
});

const callSetBlocked = rpc.declare({
	object: 'luci.homecontrol',
	method: 'client_set_blocked',
	expect: { '': {} }
});

const callTempBlock = rpc.declare({
	object: 'luci.homecontrol',
	method: 'client_temp_block',
	expect: { '': {} }
});

const callTempUnblock = rpc.declare({
	object: 'luci.homecontrol',
	method: 'client_temp_unblock',
	expect: { '': {} }
});

const callApply = rpc.declare({
	object: 'luci.homecontrol',
	method: 'apply',
	expect: { '': {} }
});

const callDHCPLeases = rpc.declare({
	object: 'luci-rpc',
	method: 'getDHCPLeases',
	expect: { '': {} }
});

const callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

const CSS = `
	.hc-form { display: flex; flex-direction: column; gap: 12px; margin-top: 8px; }
	.hc-row { display: flex; gap: 10px; flex-wrap: wrap; }
	.hc-field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 160px; }
	.hc-field.wide { flex: 3 1 260px; }
	.hc-field > label { font-size: .85em; font-weight: 600; color: #777; }
	.hc-field > input, .hc-field > select, .hc-field > textarea { width: 100%; box-sizing: border-box; }
	.hc-tbl { width: 100%; border-collapse: collapse; margin-top: 10px; }
	.hc-tbl th { text-align: left; padding: 6px 8px; border-bottom: 2px solid rgba(128,128,128,.35); white-space: nowrap; }
	.hc-tbl td { padding: 6px 8px; border-bottom: 1px solid rgba(128,128,128,.15); vertical-align: middle; }
	.hc-tbl tr.hc-row-blocked td { background: rgba(217,83,79,.06); }
	.hc-pill { padding: 2px 10px; border-radius: 10px; font-size: .8em; font-weight: 600; white-space: nowrap; }
	.hc-pill.g { background: rgba(92,184,92,.15); color: #5cb85c; }
	.hc-pill.r { background: rgba(217,83,79,.15); color: #d9534f; }
	.hc-pill.o { background: rgba(240,173,78,.2); color: #c77c11; }
	.hc-tbl-actions { display: flex; gap: 4px; flex-wrap: wrap; }
	.hc-tbl .btn { padding: 2px 10px; }
`;

function fmt_remaining(until) {
	const m = Math.max(0, Math.round((until * 1000 - Date.now()) / 60000));
	if (m < 60)
		return m + ' ' + _('min');
	const h = Math.floor(m / 60), mm = m % 60;
	if (h < 24)
		return h + ' ' + _('h') + (mm ? (' ' + mm + ' ' + _('min')) : '');
	const d = Math.floor(h / 24);
	return d + ' ' + _('d') + ' ' + (h % 24) + ' ' + _('h');
}

function customTimeModal(title, defHours, onOk) {
	const inVal = E('input', { 'type': 'number', 'min': '1', 'class': 'cbi-input-text', 'value': String(defHours) });
	const selUnit = E('select', { 'class': 'cbi-input-select' }, [
		E('option', { 'value': '1' }, [_('minutes')]),
		E('option', { 'value': '60', 'selected': 'selected' }, [_('hours')]),
		E('option', { 'value': '1440' }, [_('days')])
	]);
	const row = E('div', { 'style': 'display:flex; gap:8px; align-items:center' }, [ inVal, selUnit ]);

	ui.showModal(title, [
		E('p', {}, [ _('Access will be restored automatically when the time is up.') ]),
		row,
		E('div', { 'class': 'right', 'style': 'margin-top:14px' }, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]),
			E('button', {
				'class': 'btn cbi-button-positive important',
				'click': function() {
					const v = parseInt(inVal.value, 10);
					const u = parseInt(selUnit.value, 10);
					if (!v || v < 1) {
						ui.addNotification('error', _('Enter a positive number'));
						return;
					}
					ui.hideModal();
					onOk(v * u);
				}
			}, [ _('Apply') ])
		])
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('homecontrol'),
			L.resolveDefault(callStatus(), {}),
			L.resolveDefault(callDHCPLeases(), {}),
			L.resolveDefault(callHostHints(), {})
		]);
	},

	render: function() {
		const tableWrap = E('div', {});
		const view = this;

		const inName = E('input', { 'class': 'cbi-input-text', 'placeholder': _('Name (e.g. Kids Tablet)'), 'id': 'hc-new-name' });
		const inIp = E('input', { 'class': 'cbi-input-text', 'placeholder': _('IP address (e.g. 192.168.1.100)'), 'id': 'hc-new-ip' });
		const inMac = E('input', { 'class': 'cbi-input-text', 'placeholder': _('MAC (optional, e.g. AA:BB:CC:DD:EE:FF)'), 'id': 'hc-new-mac' });

		const selPick = E('select', { 'class': 'cbi-input-select', 'id': 'hc-device-pick' }, [
			E('option', { 'value': '' }, [ _('— Select a device from the network —') ])
		]);

		/* device list keyed by display key; rebuilt on every poll */
		const knownDevices = {};

		function applyDevice(d) {
			if (!d)
				return;
			/* MAC always; IP only when the device actually has one */
			inIp.value = d.ips.length ? d.ips[0] : '';
			inMac.value = d.mac || '';
			/* name: fill only while empty — the user names devices
			 * themselves (e.g. "Kid 1") and free text is allowed */
			if (!inName.value.trim() && d.name)
				inName.value = d.name;
		}

		selPick.addEventListener('change', function() {
			const v = selPick.value;
			if (!v)
				return;
			const d = knownDevices[v];
			if (d)
				applyDevice(d);
		});

		function updateDeviceList(leases, hints) {
			const devs = {};
			function addDev(mac, ip, name) {
				if (!mac)
					return;
				const m = String(mac).trim().toUpperCase();
				if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(m))
					return;
				let d = devs[m];
				if (!d) {
					d = devs[m] = { mac: m, name: '', ips: [] };
				}
				if (name && !d.name)
					d.name = String(name).trim();
				if (ip && d.ips.indexOf(String(ip).trim()) < 0)
					d.ips.push(String(ip).trim());
			}

			const ll = (leases && leases.dhcp_leases) || [];
			for (let i = 0; i < ll.length; i++)
				addDev(ll[i].macaddr, ll[i].ipaddr, ll[i].hostname);

			for (let k in hints) {
				const h = hints[k] || {};
				if (Array.isArray(h.ipaddrs))
					for (let i = 0; i < h.ipaddrs.length; i++)
						addDev(k, h.ipaddrs[i], h.name);
				else if (h.name)
					addDev(k, null, h.name);
			}

			/* one-line label: "name (MAC · IP)" */
			const choices = {};
			for (let m in devs) {
				const d = devs[m];
				const key = d.ips.length ? d.ips[0] : d.mac;
				knownDevices[key] = d;
				knownDevices[d.mac] = d;
				if (d.ips.length)
					knownDevices[d.ips[0]] = d;

				const title = d.name || _('Unknown device');
				const sub = d.ips.length
					? d.mac + ' · ' + d.ips.join(', ')
					: d.mac;
				choices[key] = title + ' (' + sub + ')';
			}

			/* rebuild options only when the device set changed */
			const sig = JSON.stringify(Object.keys(choices));
			if (sig === updateDeviceList._sig)
				return;
			updateDeviceList._sig = sig;

			const sel = selPick.value;
			selPick.innerHTML = '';
			selPick.appendChild(E('option', { 'value': '' }, [ _('— Select a device from the network —') ]));
			for (let k in choices)
				selPick.appendChild(E('option', { 'value': k }, [ choices[k] ]));
			selPick.value = (sel && choices[sel]) ? sel : '';
		}

		const addBtn = E('button', {
			'class': 'btn cbi-button-positive',
			'click': ui.createHandlerFn(this, function() {
				let name = inName.value.trim();
				const ip = inIp.value.trim(), mac = inMac.value.trim().toUpperCase();
				/* picked a device but left the name empty: fall back to
				 * the hostname / address so the row is recognisable */
				if (!name) {
					const picked = knownDevices[selPick.value || ''];
					name = (picked && (picked.name || picked.ips[0])) || ip || mac;
				}
				if (!name && !ip && !mac) {
					ui.addNotification('error', _('Fill at least one field'));
					return;
				}
				return L.resolveDefault(callAdd({ name: name, ip: ip, mac: mac }), {}).then(function(r) {
					if (r && r.error) {
						ui.addNotification('error', _('Error') + ': ' + r.error);
						return;
					}
					inName.value = ''; inIp.value = ''; inMac.value = '';
					selPick.value = '';
					ui.addNotification(null, _('Client added'));
					return L.resolveDefault(callApply(), {});
				});
			})
		}, [ _('Add client') ]);

		function refresh() {
			return Promise.all([
				L.resolveDefault(callStatus(), {}),
				L.resolveDefault(callDHCPLeases(), {}),
				L.resolveDefault(callHostHints(), {})
			]).then(function(res) {
				updateDeviceList(res[1], res[2]);

				const st = res[0] || {};
				const sig = JSON.stringify(st.clients || []);
				if (sig === refresh._sig)
					return;
				refresh._sig = sig;

				tableWrap.innerHTML = '';
				const clients = st.clients || [];

				if (!clients.length) {
					tableWrap.appendChild(E('em', {}, [ _('No clients configured.') ]));
					return;
				}

				const tbl = E('table', { 'class': 'hc-tbl' }, [
					E('thead', {}, [ E('tr', {}, [
						E('th', {}, [ _('Client') ]),
						E('th', {}, [ _('IP') ]),
						E('th', {}, [ _('MAC') ]),
						E('th', {}, [ _('State') ]),
						E('th', {}, [ _('Actions') ])
					]) ])
				]);
				const tbody = E('tbody', {});

				for (let i = 0; i < clients.length; i++) {
					const c = clients[i];
					const blocked = c.blocked == true;
					const tr = E('tr', { 'class': blocked ? 'hc-row-blocked' : '' });

					tr.appendChild(E('td', {}, [
						E('strong', {}, [ c.name ]),
						c.online ? '' : E('span', { 'style': 'color:#999; font-size:.8em' }, [ ' · ' + _('offline') ])
					]));
					tr.appendChild(E('td', {}, [ c.ip || '—' ]));
					tr.appendChild(E('td', {}, [ c.mac || '—' ]));

					let pill;
					if (blocked && c.reason === 'temp' && c.until) {
						pill = E('span', { 'class': 'hc-pill o' }, [_('Temp') + ' · ' + fmt_remaining(c.until)]);
					} else if (blocked) {
						pill = E('span', { 'class': 'hc-pill r' }, [_('Blocked')]);
					} else {
						pill = E('span', { 'class': 'hc-pill g' }, [_('Allowed')]);
					}
					tr.appendChild(E('td', {}, [ pill ]));

					const actions = E('td', {});
					const btns = E('div', { 'class': 'hc-tbl-actions' });
					const noAddr = !c.ip && !c.mac;
					const noAddrTitle = _('Add an IP or MAC address to this client first');

					const blockBtn = E('button', {
						'class': 'btn cbi-button cbi-button-negative',
						'title': noAddr ? noAddrTitle : '',
						'disabled': noAddr ? 'disabled' : null,
						'click': ui.createHandlerFn(view, function() {
							return L.resolveDefault(callSetBlocked({ id: c.id, blocked: true }), {})
								.then(function(r) {
									if (r && r.error)
										ui.addNotification('error', _('Error') + ': ' + r.error);
									return L.resolveDefault(callApply(), {});
								});
						})
					}, [ _('Block') ]);
					btns.appendChild(blockBtn);

					btns.appendChild(E('button', {
						'class': 'btn cbi-button cbi-button-positive',
						'title': (blocked && c.reason === 'schedule') ? _('Blocked by an active schedule — pause enforcement or edit the schedule') : '',
						'click': ui.createHandlerFn(view, function() {
							return L.resolveDefault(callSetBlocked({ id: c.id, blocked: false }), {})
								.then(function() { return L.resolveDefault(callTempUnblock({ id: c.id }), {}); })
								.then(function() { return L.resolveDefault(callApply(), {}); });
						})
					}, [ _('Allow') ]));

					const tempBtn = E('button', {
						'class': 'btn cbi-button',
						'title': noAddr ? noAddrTitle : _('Block for a custom time'),
						'disabled': noAddr ? 'disabled' : null,
						'click': function() {
							customTimeModal(_('Block %s for...').format(c.name), 2, function(minutes) {
								L.resolveDefault(callTempBlock({ id: c.id, minutes: minutes }), {})
									.then(function(r) {
										if (r && r.error)
											ui.addNotification('error', _('Error') + ': ' + r.error);
										return L.resolveDefault(callApply(), {});
									});
							});
						}
					}, [ '⏱' ]);
					btns.appendChild(tempBtn);
					btns.appendChild(E('button', {
						'class': 'btn cbi-button-remove',
						'title': _('Delete'),
						'click': ui.createHandlerFn(view, function() {
							ui.showModal(_('Delete client'), [
								E('p', {}, [ _('Really delete %s?').format(c.name) ]),
								E('div', { 'class': 'right' }, [
									E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]),
									E('button', {
										'class': 'btn cbi-button-negative important',
										'click': ui.createHandlerFn(view, function() {
											ui.hideModal();
											return L.resolveDefault(callDelete({ id: c.id }), {})
												.then(function() { return L.resolveDefault(callApply(), {}); });
										})
									}, [ _('Delete') ])
								])
							]);
						})
					}, [ '✕' ]));
					actions.appendChild(btns);
					tr.appendChild(actions);
					tbody.appendChild(tr);
				}
				tbl.appendChild(tbody);
				tableWrap.appendChild(tbl);
			});
		}

		poll.add(refresh, 5);
		refresh();

		return E([
			E('style', { 'type': 'text/css' }, [ CSS ]),
			E('h2', {}, [ _('HomeControl — Clients') ]),
			E('p', {}, [ _('Manage which devices are allowed on the network. Block instantly, or for a limited time.') ]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Add client') ]),
				E('div', { 'class': 'hc-form' }, [
					E('div', { 'class': 'hc-row' }, [
						E('div', { 'class': 'hc-field wide' }, [
							E('label', {}, [ _('Pick a device (from DHCP leases and host hints)') ]),
							selPick,
							E('span', { 'class': 'hint', 'style': 'color:#999; font-size:.8em' },
								[ _('Selecting a device fills IP and MAC automatically. Then give it a name you will recognize (e.g. "Kid 1"). A device missing from the list? Fill the fields below manually.') ])
						])
					]),
					E('div', { 'class': 'hc-row' }, [
						E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('Name') ]), inName ]),
						E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('IP address') ]), inIp ]),
						E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('MAC address') ]), inMac ])
					]),
					E('div', { 'class': 'hc-row' }, [ E('div', { 'class': 'hc-field' }, [ addBtn ]) ])
				])
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Client list') ]),
				tableWrap
			])
		]);
	}
});
