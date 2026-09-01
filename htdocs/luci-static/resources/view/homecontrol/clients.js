/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * HomeControl - Clients management: add/remove clients (from ARP list or by
 * hand), quick block toggles, temporary blocks.
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

const callApply = rpc.declare({
	object: 'luci.homecontrol',
	method: 'apply',
	expect: { '': {} }
});

const CSS = `
	.hc-tbl { width: 100%; border-collapse: collapse; margin-top: 8px; }
	.hc-tbl th { text-align: left; padding: 6px 8px; border-bottom: 2px solid rgba(128,128,128,.35); }
	.hc-tbl td { padding: 6px 8px; border-bottom: 1px solid rgba(128,128,128,.15); vertical-align: middle; }
	.hc-tbl tr.hc-row-blocked td { background: rgba(217,83,79,.06); }
	.hc-pill { padding: 2px 10px; border-radius: 10px; font-size: .8em; font-weight: 600; white-space: nowrap; }
	.hc-pill.g { background: rgba(92,184,92,.15); color: #5cb85c; }
	.hc-pill.r { background: rgba(217,83,79,.15); color: #d9534f; }
	.hc-add { display: grid; grid-template-columns: 1fr 1fr 2fr auto; gap: 8px; align-items: end; margin-top: 6px; }
	@media (max-width: 700px) { .hc-add { grid-template-columns: 1fr 1fr; } }
`;

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('homecontrol'),
			L.resolveDefault(callStatus(), {})
		]);
	},

	render: function(data) {
		const tableWrap = E('div', {});
		const view = this;

		/* add form */
		const inName = E('input', { 'class': 'cbi-input-text', 'placeholder': _('Name (e.g. Kids Tablet)'), 'id': 'hc-new-name' });
		const inIp = E('input', { 'class': 'cbi-input-text', 'placeholder': _('IP address (e.g. 192.168.1.100)'), 'id': 'hc-new-ip' });
		const inMac = E('input', { 'class': 'cbi-input-text', 'placeholder': _('MAC (optional, e.g. AA:BB:CC:DD:EE:FF)'), 'id': 'hc-new-mac' });

		const addBtn = E('button', {
			'class': 'btn cbi-button-positive',
			'click': ui.createHandlerFn(this, function() {
				const name = inName.value, ip = inIp.value, mac = inMac.value;
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
					ui.addNotification(null, _('Client added'));
					return L.resolveDefault(callApply(), {});
				});
			})
		}, [ _('Add client') ]);

		function refresh() {
			return L.resolveDefault(callStatus(), {}).then(function(st) {
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
					const blocked = (c.state === 'block');
					const tr = E('tr', { 'class': blocked ? 'hc-row-blocked' : '' });

					tr.appendChild(E('td', {}, [
						E('strong', {}, [ c.name ]),
						c.online ? '' : E('span', { 'style': 'color:#999; font-size:.8em' }, [ ' · ' + _('offline') ])
					]));
					tr.appendChild(E('td', {}, [ c.ip || '—' ]));
					tr.appendChild(E('td', {}, [ c.mac || '—' ]));
					tr.appendChild(E('td', {}, [
						E('span', { 'class': 'hc-pill ' + (blocked ? 'r' : 'g') },
							[ blocked ? _('Blocked') : _('Allowed') ])
					]));

					const actions = E('td', {});
					actions.appendChild(E('button', {
						'class': 'btn cbi-button cbi-button-negative',
						'style': 'margin-right:4px',
						'click': ui.createHandlerFn(view, function() {
							return L.resolveDefault(callSetBlocked({ id: c.id, blocked: true }), {})
								.then(function() { return L.resolveDefault(callApply(), {}); });
						})
					}, [ _('Block') ]));
					actions.appendChild(E('button', {
						'class': 'btn cbi-button cbi-button-positive',
						'style': 'margin-right:4px',
						'click': ui.createHandlerFn(view, function() {
							return L.resolveDefault(callSetBlocked({ id: c.id, blocked: false }), {})
								.then(function() { return L.resolveDefault(callApply(), {}); });
						})
					}, [ _('Allow') ]));
					actions.appendChild(E('button', {
						'class': 'btn cbi-button',
						'style': 'margin-right:4px',
						'title': _('Block for 30 minutes'),
						'click': ui.createHandlerFn(view, function() {
							return L.resolveDefault(callTempBlock({ id: c.id, minutes: 30 }), {})
								.then(function() { return L.resolveDefault(callApply(), {}); });
						})
					}, [ _('30m') ]));
					actions.appendChild(E('button', {
						'class': 'btn cbi-button',
						'style': 'margin-right:4px',
						'title': _('Block for 2 hours'),
						'click': ui.createHandlerFn(view, function() {
							return L.resolveDefault(callTempBlock({ id: c.id, minutes: 120 }), {})
								.then(function() { return L.resolveDefault(callApply(), {}); });
						})
					}, [ _('2h') ]));
					actions.appendChild(E('button', {
						'class': 'btn cbi-button-remove',
						'click': ui.createHandlerFn(view, function(ev) {
							return ui.showModal(_('Delete client'), [
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
					tr.appendChild(actions);
					tbody.appendChild(tr);
				}
				tbl.appendChild(tbody);
				tableWrap.appendChild(tbl);
			});
		}

		poll.add(refresh, 6);
		refresh();

		return E([
			E('style', { 'type': 'text/css' }, [ CSS ]),
			E('h2', {}, [ _('HomeControl — Clients') ]),
			E('p', {}, [ _('Manage which devices are allowed on the network. Block instantly, or for a limited time.') ]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Add client') ]),
				E('div', { 'class': 'hc-add' }, [
					E('div', {}, [ inName ]),
					E('div', {}, [ inIp ]),
					E('div', {}, [ inMac ]),
					E('div', {}, [ addBtn ])
				]),
				E('p', { 'style': 'color:#888; font-size:.85em' },
					[ _('Tip: leave IP/MAC empty and the client can be matched later. IP is enough for instant blocking.') ])
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Client list') ]),
				tableWrap
			])
		]);
	}
});
