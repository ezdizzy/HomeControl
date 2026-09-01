/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * HomeControl - Schedules: time-based rules. A schedule binds clients,
 * Wi-Fi interfaces and/or rule sets to a time window:
 *   daily  - time window each day (e.g. 07:00-21:00)
 *   weekly - time window on selected weekdays
 *   range  - whole-day block between two dates (e.g. vacation/punishment)
 *   timer  - one-shot absolute window (e.g. 2026-09-05 14:00 -> 16:00)
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
	.hc-badge { font-size: .75em; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
	.hc-badge.g { background: rgba(92,184,92,.15); color: #5cb85c; }
	.hc-badge.r { background: rgba(217,83,79,.15); color: #d9534f; }
`;

const DAYS = [ 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun' ];

function fmt_days(days) {
	if (!days || !days.length)
		return _('Every day');
	return days.join(', ');
}

function fmt_window(s) {
	if (s.type === 'range')
		return (s.date_start || '…') + ' → ' + (s.date_stop || '…');
	if (s.type === 'timer')
		return (s.date_start || '') + ' ' + (s.time_start || '') + ' → ' + (s.date_stop || '') + ' ' + (s.time_stop || '');
	return (s.time_start || '00:00') + ' – ' + (s.time_stop || '24:00');
}

return view.extend({
	load: function() {
		return uci.load('homecontrol');
	},

	render: function() {
		const mapWrap = E('div', {});
		const view = this;

		function targets_str(s) {
			const parts = [];
			if (s.client_ids && s.client_ids.length)
				parts.push(P_('%d client', '%d clients', s.client_ids.length).format(s.client_ids.length));
			if (s.wifi_ids && s.wifi_ids.length)
				parts.push(P_('%d Wi-Fi', '%d Wi-Fi', s.wifi_ids.length).format(s.wifi_ids.length));
			if (s.ruleset_ids && s.ruleset_ids.length)
				parts.push(P_('%d ruleset', '%d rulesets', s.ruleset_ids.length).format(s.ruleset_ids.length));
			return parts.length ? parts.join(', ') : _('(nothing bound)');
		}

		function renderSchedules() {
			mapWrap.innerHTML = '';
			const schs = [];
			uci.sections('homecontrol', 'schedule', function(s) { schs.push(s); });

			if (!schs.length) {
				mapWrap.appendChild(E('em', {}, [
					_('No schedules yet. Example: block kids\' tablets on school nights after 21:00, turn guest Wi-Fi off at night, pause the internet for an hour as a timeout.')
				]));
				return;
			}

			const tbl = E('table', { 'class': 'hc-tbl' }, [
				E('thead', {}, [ E('tr', {}, [
					E('th', {}, [ _('Name') ]),
					E('th', {}, [ _('Kind') ]),
					E('th', {}, [ _('Window') ]),
					E('th', {}, [ _('Bound to') ]),
					E('th', {}, [ _('Action') ]),
					E('th', {}, [ _('Enabled') ]),
					E('th', {}, [ '' ])
				]) ])
			]);

			for (let i = 0; i < schs.length; i++) {
				const s = schs[i];
				const deny = (s.action || 'deny') === 'deny';
				const tr = E('tr', {});
				tr.appendChild(E('td', {}, [ E('strong', {}, [ s.name || s['.name'] ]) ]));
				tr.appendChild(E('td', {}, [ (s.type || 'daily') ]));
				tr.appendChild(E('td', {}, [ fmt_window(s) ]));
				tr.appendChild(E('td', {}, [ targets_str(s) ]));
				tr.appendChild(E('td', {}, [
					E('span', { 'class': 'hc-badge ' + (deny ? 'r' : 'g') },
						[ deny ? _('Block') : _('Allow') ])
				]));

				const cb = E('input', { 'type': 'checkbox' });
				cb.checked = (s.enabled === '1');
				cb.addEventListener('change', function(ev) {
					uci.set('homecontrol', s['.name'], 'enabled', ev.target.checked ? '1' : '0');
					uci.save().then(function() { return L.resolveDefault(callApply(), {}); });
				});
				tr.appendChild(E('td', {}, [ cb ]));

				const actions = E('td', {});
				actions.appendChild(E('button', {
					'class': 'btn cbi-button-remove',
					'click': ui.createHandlerFn(view, function() {
						uci.remove('homecontrol', s['.name']);
						return uci.save().then(function() { return L.resolveDefault(callApply(), {}); });
					})
				}, [ '✕' ]));
				tr.appendChild(actions);
				tbl.appendChild(tr);
			}
			mapWrap.appendChild(tbl);
		}

		/* ── create form ─────────────────────────────────────────────── */

		const inName = E('input', { 'class': 'cbi-input-text', 'placeholder': _('e.g. School night lockout') });

		const selType = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'daily' }, [ _('Daily (same time each day)') ]),
			E('option', { 'value': 'weekly' }, [ _('Weekly (specific weekdays)') ]),
			E('option', { 'value': 'range' }, [ _('Date range (whole day, e.g. vacation)') ]),
			E('option', { 'value': 'timer' }, [ _('One-shot timer (exact date+time)') ])
		]);

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

		/* clients + wifi pickers from current sections */
		const clientChecks = E('div', { 'style': 'display:flex; gap:10px; flex-wrap:wrap' });
		uci.sections('homecontrol', 'client', function(c) {
			const lbl = E('label', { 'style': 'display:flex; align-items:center; gap:4px' }, [ c.name || c.ip || c['.name'] ]);
			const cb = E('input', { 'type': 'checkbox', 'value': c['.name'] });
			lbl.insertBefore(cb, lbl.firstChild);
			clientChecks.appendChild(lbl);
		});

		const wifiChecks = E('div', { 'style': 'display:flex; gap:10px; flex-wrap:wrap' });
		uci.sections('homecontrol', 'wifi', function(w) {
			const lbl = E('label', { 'style': 'display:flex; align-items:center; gap:4px' }, [ w.name || w.network || w['.name'] ]);
			const cb = E('input', { 'type': 'checkbox', 'value': w['.name'] });
			lbl.insertBefore(cb, lbl.firstChild);
			wifiChecks.appendChild(lbl);
		});

		const selAction = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'deny' }, [ _('Block during window') ]),
			E('option', { 'value': 'allow' }, [ _('Allow only during window') ])
		]);

		const addBtn = E('button', {
			'class': 'btn cbi-button-positive',
			'click': ui.createHandlerFn(this, function() {
				const name = inName.value.trim();
				if (!name) {
					ui.addNotification('error', _('Enter a schedule name'));
					return;
				}
				const type = selType.value;

				const sid = uci.add('homecontrol', 'schedule');
				uci.set('homecontrol', sid, 'name', name);
				uci.set('homecontrol', sid, 'type', type);
				uci.set('homecontrol', sid, 'enabled', '1');
				uci.set('homecontrol', sid, 'action', selAction.value);

				const days = [];
				dayChecks.querySelectorAll('input:checked').forEach(function(cb) {
					days.push(cb.value);
				});
				if (days.length)
					for (let i = 0; i < days.length; i++)
						uci.add_list('homecontrol', sid, 'days', days[i]);

				if (type === 'daily' || type === 'weekly') {
					if (inTimeStart.value) uci.set('homecontrol', sid, 'time_start', inTimeStart.value);
					if (inTimeStop.value) uci.set('homecontrol', sid, 'time_stop', inTimeStop.value);
				}
				if (type === 'range' || type === 'timer') {
					if (inDateStart.value) uci.set('homecontrol', sid, 'date_start', inDateStart.value);
					if (inDateStop.value) uci.set('homecontrol', sid, 'date_stop', inDateStop.value);
					if (type === 'timer') {
						if (inTimeStart.value) uci.set('homecontrol', sid, 'time_start', inTimeStart.value);
						if (inTimeStop.value) uci.set('homecontrol', sid, 'time_stop', inTimeStop.value);
					}
				}

				let bound = 0;
				clientChecks.querySelectorAll('input:checked').forEach(function(cb) {
					uci.add_list('homecontrol', sid, 'client_ids', cb.value);
					bound++;
				});
				wifiChecks.querySelectorAll('input:checked').forEach(function(cb) {
					uci.add_list('homecontrol', sid, 'wifi_ids', cb.value);
					bound++;
				});
				if (!bound) {
					ui.addNotification('error', _('Bind at least one client or Wi-Fi interface'));
					uci.remove('homecontrol', sid);
					return;
				}

				return uci.save().then(function() {
					ui.addNotification(null, _('Schedule created and applied'));
					inName.value = '';
					return L.resolveDefault(callApply(), {});
				});
			})
		}, [ _('Create schedule') ]);

		renderSchedules();

		return E([
			E('style', { 'type': 'text/css' }, [ CSS ]),
			E('h2', {}, [ _('HomeControl — Schedules') ]),
			E('p', {}, [ _('Plan when clients, Wi-Fi or rule sets are blocked or allowed. Windows may cross midnight (e.g. 21:00 → 07:00).') ]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Existing schedules') ]),
				mapWrap
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Create schedule') ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', {}, [ _('Name') ]), inName ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', {}, [ _('Kind') ]), selType ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', {}, [ _('Days of week (weekly)') ]), dayChecks ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', {}, [ _('Time from / to') ]), inTimeStart, ' — ', inTimeStop ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', {}, [ _('Dates (range/timer)') ]), inDateStart, ' — ', inDateStop ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', {}, [ _('Action') ]), selAction ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', {}, [ _('Bind clients') ]), clientChecks ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', {}, [ _('Bind Wi-Fi') ]), wifiChecks ]),
				E('div', { 'style': 'margin-top:8px' }, [ addBtn ])
			])
		]);
	}
});
