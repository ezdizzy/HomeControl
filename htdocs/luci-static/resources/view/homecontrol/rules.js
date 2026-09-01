/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * HomeControl - Site rules: manage domain/IP block rules and named rule
 * sets (groups of rules that can be enabled together).
 */

'use strict';
'require rpc';
'require uci';
'require ui';
'require view';

const callApply = rpc.declare({
	object: 'luci.homecontrol',
	method: 'apply',
	expect: { '': {} }
});

const CSS = `
	.hc-tbl { width: 100%; border-collapse: collapse; margin-top: 8px; }
	.hc-tbl th { text-align: left; padding: 6px 8px; border-bottom: 2px solid rgba(128,128,128,.35); }
	.hc-tbl td { padding: 6px 8px; border-bottom: 1px solid rgba(128,128,128,.15); }
	.hc-typetag { font-size: .75em; padding: 1px 8px; border-radius: 8px; font-weight: 600; }
	.hc-typetag.d { background: rgba(91,140,255,.15); color: #4a7fe0; }
	.hc-typetag.i { background: rgba(240,173,78,.2); color: #c77c11; }
`;

return view.extend({
	load: function() {
		return uci.load('homecontrol');
	},

	/* Re-render the whole rules map on save. */
	handleSaveApply: null,

	render: function() {
		const rulesMap = E('div', {});
		const view = this;

		function activeRules() {
			const out = [];
			uci.sections('homecontrol', 'rule', function(s) {
				out.push(s);
			});
			return out;
		}

		function renderRules() {
			rulesMap.innerHTML = '';
			const rules = activeRules();

			if (!rules.length) {
				rulesMap.appendChild(E('em', {}, [ _('No rules yet. Add domains or IPs to block below.') ]));
				return;
			}

			const tbl = E('table', { 'class': 'hc-tbl' }, [
				E('thead', {}, [ E('tr', {}, [
					E('th', {}, [ _('Name') ]),
					E('th', {}, [ _('Type') ]),
					E('th', {}, [ _('Targets') ]),
					E('th', {}, [ _('Enabled') ]),
					E('th', {}, [ _('Actions') ])
				]) ])
			]);

			for (let i = 0; i < rules.length; i++) {
				const r = rules[i];
				const isDomain = (r.type || 'domain') === 'domain';
				const targets = (r.target && r.target.length) ? r.target : [];

				const tr = E('tr', {});
				tr.appendChild(E('td', {}, [ E('strong', {}, [ r.name || r['.name'] ]) ]));
				tr.appendChild(E('td', {}, [
					E('span', { 'class': 'hc-typetag ' + (isDomain ? 'd' : 'i') },
						[ isDomain ? _('Domain') : _('IP') ])
				]));
				tr.appendChild(E('td', { 'style': 'max-width:380px; overflow-wrap:anywhere' },
					[ targets.join(', ') || '—' ]));

				const cb = E('input', { 'type': 'checkbox' });
				cb.checked = (r.enabled === '1');
				cb.addEventListener('change', function(ev) {
					uci.set('homecontrol', r['.name'], 'enabled', ev.target.checked ? '1' : '0');
					uci.save().then(function() {
						return L.resolveDefault(callApply(), {});
					});
				});
				tr.appendChild(E('td', {}, [ cb ]));

				const actions = E('td', {});
				actions.appendChild(E('button', {
					'class': 'btn cbi-button-remove',
					'click': ui.createHandlerFn(view, function() {
						uci.remove('homecontrol', r['.name']);
						return uci.save().then(function() {
							return L.resolveDefault(callApply(), {});
						});
					})
				}, [ '✕' ]));
				tr.appendChild(actions);
				tbl.appendChild(tr);
			}
			rulesMap.appendChild(tbl);
		}

		/* new rule form */
		const inName = E('input', { 'class': 'cbi-input-text', 'placeholder': _('Rule name (e.g. Social media)') });
		const inTargets = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': 4,
			'placeholder': _('One domain or IP per line, e.g.\ntiktok.com\ninstagram.com\n1.2.3.4')
		});
		const selType = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'domain' }, [ _('Domain (site blocking via DNS)') ]),
			E('option', { 'value': 'ip' }, [ _('IP / subnet (via firewall)') ])
		]);

		const addBtn = E('button', {
			'class': 'btn cbi-button-positive',
			'click': ui.createHandlerFn(this, function() {
				const name = inName.value.trim();
				const type = selType.value;
				const lines = inTargets.value.split('\n')
					.map(function(s) { return s.trim(); })
					.filter(function(s) { return s.length > 0; });

				if (!lines.length) {
					ui.addNotification('error', _('Enter at least one domain or IP'));
					return;
				}
				if (!name) {
					ui.addNotification('error', _('Enter a rule name'));
					return;
				}

				const sid = uci.add('homecontrol', 'rule');
				uci.set('homecontrol', sid, 'name', name);
				uci.set('homecontrol', sid, 'type', type);
				uci.set('homecontrol', sid, 'enabled', '1');
				for (let i = 0; i < lines.length; i++)
					uci.add_list('homecontrol', sid, 'target', lines[i]);

				return uci.save().then(function() {
					inName.value = '';
					inTargets.value = '';
					ui.addNotification(null, _('Rule added and applied'));
					return L.resolveDefault(callApply(), {});
				});
			})
		}, [ _('Add rule') ]);

		renderRules();

		return E([
			E('style', { 'type': 'text/css' }, [ CSS ]),
			E('h2', {}, [ _('HomeControl — Site Rules') ]),
			E('p', {}, [ _('Block access to sites and resources. Rules are applied network-wide via DNS (domains) or the firewall (IPs). Group them into schedules later.') ]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Existing rules') ]),
				rulesMap
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Add rule') ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', {}, [ _('Name') ]), inName ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', {}, [ _('Type') ]), selType ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', {}, [ _('Targets') ]), inTargets ]),
				E('div', { 'style': 'margin-top:8px' }, [ addBtn ])
			])
		]);
	}
});
