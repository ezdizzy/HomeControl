/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * HomeControl - Site rules: domain (DNS) and IP (firewall) block rules with
 * optional scope (whole network or selected clients), time windows
 * ("block only 20:00-07:00", date ranges) and a temporary pause
 * ("allow for 1h") with automatic re-enable.
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

const callApply = rpc.declare({
	object: 'luci.homecontrol',
	method: 'apply',
	expect: { '': {} }
});

const CSS = `
	.hc-form { display: flex; flex-direction: column; gap: 12px; margin-top: 8px; }
	.hc-row { display: flex; gap: 10px; flex-wrap: wrap; }
	.hc-field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 160px; }
	.hc-field.wide { flex: 1 1 100%; }
	.hc-field > label { font-size: .85em; font-weight: 600; color: #777; }
	.hc-field > input, .hc-field > select, .hc-field > textarea { width: 100%; box-sizing: border-box; }
	.hc-field .hint { color: #999; font-size: .8em; }
	.hc-tbl { width: 100%; border-collapse: collapse; margin-top: 10px; }
	.hc-tbl th { text-align: left; padding: 6px 8px; border-bottom: 2px solid rgba(128,128,128,.35); white-space: nowrap; }
	.hc-tbl td { padding: 6px 8px; border-bottom: 1px solid rgba(128,128,128,.15); vertical-align: middle; }
	.hc-typetag { font-size: .75em; padding: 1px 8px; border-radius: 8px; font-weight: 600; white-space: nowrap; }
	.hc-typetag.d { background: rgba(91,140,255,.15); color: #4a7fe0; }
	.hc-typetag.i { background: rgba(240,173,78,.2); color: #c77c11; }
	.hc-pill { padding: 2px 10px; border-radius: 10px; font-size: .75em; font-weight: 600; white-space: nowrap; }
	.hc-pill.o { background: rgba(240,173,78,.2); color: #c77c11; }
	.hc-window { color: #4a7fe0; font-size: .8em; }
	.hc-tbl-actions { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
	.hc-tbl .btn { padding: 2px 10px; }
	.hc-days { color: #777; font-size: .78em; }
`;

const DAYS = [ 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun' ];

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

function windowSummary(r) {
	const parts = [];
	if (r.time_start || r.time_stop)
		parts.push((r.time_start || '00:00') + '–' + (r.time_stop || '24:00'));
	if (r.days && r.days.length)
		parts.push(r.days.join(','));
	if (r.date_start || r.date_stop)
		parts.push((r.date_start || '…') + '…' + (r.date_stop || '…'));
	return parts.length ? parts.join(' · ') : _('Always');
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
		E('p', {}, [ _('The rule will start working again automatically when the time is up.') ]),
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
			L.resolveDefault(callStatus(), {})
		]);
	},

	render: function(data) {
		const tableWrap = E('div', {});
		const pausedMap = (data[1] && data[1].rules_paused) || {};
		const statusClients = (data[1] && data[1].clients) || [];
		const clientNames = {};
		for (let i = 0; i < statusClients.length; i++)
			clientNames[statusClients[i].id] = statusClients[i].name || statusClients[i].id;
		const view = this;

		function renderRules() {
			tableWrap.innerHTML = '';
			const rules = [];
			uci.sections('homecontrol', 'rule', function(s) {
				rules.push(s);
			});

			if (!rules.length) {
				tableWrap.appendChild(E('em', {}, [ _('No rules yet. Add domains or IPs to block below.') ]));
				return;
			}

			const tbl = E('table', { 'class': 'hc-tbl' }, [
				E('thead', {}, [ E('tr', {}, [
					E('th', {}, [ _('Name') ]),
					E('th', {}, [ _('Type') ]),
					E('th', {}, [ _('Targets') ]),
					E('th', {}, [ _('Applies to') ]),
					E('th', {}, [ _('Active') ]),
					E('th', {}, [ _('Enabled') ]),
					E('th', {}, [ _('Actions') ])
				]) ])
			]);

			for (let i = 0; i < rules.length; i++) {
				const r = rules[i];
				const sid = r['.name'];
				const isDomain = (r.type || 'domain') === 'domain';
				const targets = (r.target && r.target.length) ? r.target : [];
				const ruleClients = (r.client_ids && r.client_ids.length) ? r.client_ids : [];
				const pausedUntil = (pausedMap[sid] ? pausedMap[sid] : 0) || (int(r.disabled_until) || 0);
				const paused = (pausedUntil * 1000) > Date.now();

				const tr = E('tr', {});
				tr.appendChild(E('td', {}, [ E('strong', {}, [ r.name || sid ]) ]));
				tr.appendChild(E('td', {}, [
					E('span', { 'class': 'hc-typetag ' + (isDomain ? 'd' : 'i') },
						[ isDomain ? _('Domain') : _('IP') ])
				]));
				tr.appendChild(E('td', { 'style': 'max-width:380px; overflow-wrap:anywhere' },
					[ targets.join(', ') || '—' ]));

				if (ruleClients.length)
					tr.appendChild(E('td', { 'style': 'max-width:200px; overflow-wrap:anywhere' },
						[ ruleClients.map(function(c) { return clientNames[c] || c; }).join(', ') ]));
				else
					tr.appendChild(E('td', {}, [ E('em', { 'style': 'color:#999' }, [ _('Whole network') ]) ]));

				/* active column: time window + pause state */
				const activeCell = E('td', {});
				activeCell.appendChild(E('div', { 'class': 'hc-window' }, [ windowSummary(r) ]));
				if (paused)
					activeCell.appendChild(E('div', {}, [
						E('span', { 'class': 'hc-pill o' }, [_('Paused') + ' · ' + fmt_remaining(pausedUntil)])
					]));
				tr.appendChild(activeCell);

				const cb = E('input', { 'type': 'checkbox' });
				cb.checked = (r.enabled === '1');
				cb.addEventListener('change', function(ev) {
					uci.set('homecontrol', sid, 'enabled', ev.target.checked ? '1' : '0');
					uci.save().then(function() {
						return L.resolveDefault(callApply(), {});
					});
				});
				tr.appendChild(E('td', {}, [ cb ]));

				const actions = E('td', {});
				const btns = E('div', { 'class': 'hc-tbl-actions' });

				btns.appendChild(E('button', {
					'class': 'btn cbi-button',
					'title': _('Temporarily allow (pause this rule)'),
					'click': function() {
						customTimeModal(_('Pause "%s" for...').format(r.name || sid), 1, function(minutes) {
							uci.set('homecontrol', sid, 'disabled_until', String(Math.floor(Date.now() / 1000) + minutes * 60));
							uci.save().then(function() {
								return L.resolveDefault(callApply(), {});
							});
						});
					}
				}, [ '⏸' ]));
				btns.appendChild(E('button', {
					'class': 'btn cbi-button',
					'title': _('Resume immediately'),
					'click': ui.createHandlerFn(view, function() {
						uci.unset('homecontrol', sid, 'disabled_until');
						return uci.save().then(function() {
							return L.resolveDefault(callApply(), {});
						});
					})
				}, [ '▶' ]));
				btns.appendChild(E('button', {
					'class': 'btn cbi-button-remove',
					'click': ui.createHandlerFn(view, function() {
						uci.remove('homecontrol', sid);
						return uci.save().then(function() {
							return L.resolveDefault(callApply(), {});
						});
					})
				}, [ '✕' ]));
				actions.appendChild(btns);
				tr.appendChild(actions);
				tbl.appendChild(tr);
			}
			tableWrap.appendChild(tbl);
		}

		/* ── add form ─────────────────────────────────────────────────── */

		const inName = E('input', { 'class': 'cbi-input-text', 'placeholder': _('Rule name (e.g. Social media)') });
		const inTargets = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': 4,
			'style': 'width:100%; box-sizing:border-box',
			'placeholder': _('One domain or IP per line, e.g.\ntiktok.com\ninstagram.com\n1.2.3.4')
		});
		const selType = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'domain' }, [ _('Domain (site blocking via DNS)') ]),
			E('option', { 'value': 'ip' }, [ _('IP / subnet (via firewall)') ])
		]);

		/* per-client scope: empty selection = whole network */
		const clientChecks = E('div', { 'style': 'display:flex; gap:10px; flex-wrap:wrap' });
		for (let i = 0; i < statusClients.length; i++) {
			const c = statusClients[i];
			const lbl = E('label', { 'style': 'display:flex; align-items:center; gap:4px' },
				[ (c.name || c.ip || c.id) ]);
			const cb = E('input', { 'type': 'checkbox', 'value': c.id });
			lbl.insertBefore(cb, lbl.firstChild);
			clientChecks.appendChild(lbl);
		}
		if (!statusClients.length)
			clientChecks.appendChild(E('em', { 'style': 'color:#999' },
				[ _('No clients defined — the rule will apply to the whole network.') ]));

		const inTimeStart = E('input', { 'type': 'time', 'class': 'cbi-input-text' });
		const inTimeStop = E('input', { 'type': 'time', 'class': 'cbi-input-text' });
		const inDateStart = E('input', { 'type': 'date', 'class': 'cbi-input-text' });
		const inDateStop = E('input', { 'type': 'date', 'class': 'cbi-input-text' });

		const dayChecks = E('div', { 'style': 'display:flex; gap:10px; flex-wrap:wrap' });
		for (let d = 0; d < DAYS.length; d++) {
			const lbl = E('label', { 'style': 'display:flex; align-items:center; gap:4px' }, [ DAYS[d] ]);
			const cb = E('input', { 'type': 'checkbox', 'value': DAYS[d] });
			lbl.insertBefore(cb, lbl.firstChild);
			dayChecks.appendChild(lbl);
		}

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

				/* per-client scope (empty = whole network) */
				clientChecks.querySelectorAll('input:checked').forEach(function(cb) {
					uci.add_list('homecontrol', sid, 'client_ids', cb.value);
				});

				/* optional time window */
				if (inTimeStart.value)
					uci.set('homecontrol', sid, 'time_start', inTimeStart.value);
				if (inTimeStop.value)
					uci.set('homecontrol', sid, 'time_stop', inTimeStop.value);
				const days = [];
				dayChecks.querySelectorAll('input:checked').forEach(function(cb) {
					days.push(cb.value);
				});
				for (let i = 0; i < days.length; i++)
					uci.add_list('homecontrol', sid, 'days', days[i]);
				if (inDateStart.value)
					uci.set('homecontrol', sid, 'date_start', inDateStart.value);
				if (inDateStop.value)
					uci.set('homecontrol', sid, 'date_stop', inDateStop.value);

				return uci.save().then(function() {
					inName.value = '';
					inTargets.value = '';
					inTimeStart.value = ''; inTimeStop.value = '';
					inDateStart.value = ''; inDateStop.value = '';
					clientChecks.querySelectorAll('input:checked').forEach(function(cb) {
						cb.checked = false;
					});
					ui.addNotification(null, _('Rule added and applied'));
					return L.resolveDefault(callApply(), {});
				});
			})
		}, [ _('Add rule') ]);

		renderRules();

		return E([
			E('style', { 'type': 'text/css' }, [ CSS ]),
			E('h2', {}, [ _('HomeControl — Site Rules') ]),
			E('p', {}, [ _('Block access to sites and resources for the whole network or for selected clients only (e.g. one child, while another can still open the site). Optionally limit each rule to a time window — outside the window the sites are reachable again automatically.') ]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Existing rules') ]),
				tableWrap
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Add rule') ]),
				E('div', { 'class': 'hc-form' }, [
					E('div', { 'class': 'hc-row' }, [
						E('div', { 'class': 'hc-field wide' }, [ E('label', {}, [ _('Name') ]), inName ]),
						E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('Type') ]), selType ])
					]),
					E('div', { 'class': 'hc-row' }, [
						E('div', { 'class': 'hc-field wide' }, [
							E('label', {}, [ _('Targets') ]),
							inTargets,
							E('span', { 'class': 'hint' }, [ _('One entry per line. Domains are blocked via DNS; IPs/subnets via the firewall.') ])
						])
					]),
					E('div', { 'class': 'hc-row' }, [
						E('div', { 'class': 'hc-field wide' }, [
							E('label', {}, [ _('Apply to clients (optional — leave empty for the whole network)') ]),
							clientChecks
						])
					]),
					E('div', { 'class': 'hc-row' }, [
						E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('Active from (optional)') ]), inTimeStart ]),
						E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('Active until (optional)') ]), inTimeStop ]),
						E('div', { 'class': 'hc-field wide' }, [ E('label', {}, [ _('Days of week (optional)') ]), dayChecks ])
					]),
					E('div', { 'class': 'hc-row' }, [
						E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('Date from (optional)') ]), inDateStart ]),
						E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('Date until (optional)') ]), inDateStop ])
				]),
					E('div', { 'class': 'hc-row' }, [ E('div', { 'class': 'hc-field' }, [ addBtn ]) ])
				])
			])
		]);
	}
});
