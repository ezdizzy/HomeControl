/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * HomeControl - Schedules: time-based automation.
 * A schedule binds clients and/or Wi-Fi interfaces to a time window:
 *   daily  - time window each day (e.g. 07:00-21:00), may cross midnight
 *   weekly - time window on selected weekdays
 *   range  - whole-day block between two dates (e.g. vacation/punishment)
 *   timer  - one-shot absolute window (date+time .. date+time)
 * Action "Block" applies during the window; action "Allow only" inverts it
 * (Wi-Fi is OFF outside the window — "Wi-Fi only 16:00-18:00").
 */

'use strict';
'require poll';
'require rpc';
'require uci';
'require ui';
'require view';

const callApply = rpc.declare({
	object: 'luci.homecontrol',
	method: 'apply',
	expect: { '': {} }
});

const callStatus = rpc.declare({
	object: 'luci.homecontrol',
	method: 'status',
	expect: { '': {} }
});

const callWifiStatus = rpc.declare({
	object: 'luci.homecontrol',
	method: 'wifi_status',
	expect: { '': {} }
});

const CSS = `
	.hc-form { display: flex; flex-direction: column; gap: 12px; margin-top: 8px; }
	.hc-row { display: flex; gap: 10px; flex-wrap: wrap; }
	.hc-field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 160px; }
	.hc-field.wide { flex: 1 1 100%; }
	.hc-field > label { font-size: .85em; font-weight: 600; color: #777; }
	.hc-field > input, .hc-field > select { width: 100%; box-sizing: border-box; }
	.hc-checks { display: flex; gap: 12px; flex-wrap: wrap; }
	.hc-checks label { display: flex; align-items: center; gap: 4px; }
	.hc-tbl { width: 100%; border-collapse: collapse; margin-top: 10px; }
	.hc-tbl th { text-align: left; padding: 6px 8px; border-bottom: 2px solid rgba(128,128,128,.35); white-space: nowrap; }
	.hc-tbl td { padding: 6px 8px; border-bottom: 1px solid rgba(128,128,128,.15); }
	.hc-badge { font-size: .75em; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
	.hc-badge.g { background: rgba(92,184,92,.15); color: #5cb85c; }
	.hc-badge.r { background: rgba(217,83,79,.15); color: #d9534f; }
	.hc-tbl .btn { padding: 2px 10px; }
`;

const DAYS = [ 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun' ];
/* Display-only labels; UCI values stay 'Mon'..'Sun' (matched by the backend). */
const DAY_LABELS = {};
for (let d = 0; d < DAYS.length; d++)
	DAY_LABELS[DAYS[d]] = _(DAYS[d]);

function day_labels(days) {
	const lbls = [];
	for (let i = 0; i < days.length; i++)
		lbls.push(DAY_LABELS[days[i]] || days[i]);
	return lbls;
}

const TYPE_LABELS = {
	daily: _('Daily'),
	weekly: _('Weekly'),
	range: _('Date range'),
	timer: _('One-shot timer')
};

function fmt_days(days) {
	if (!days || !days.length)
		return _('Every day');
	return day_labels(days).join(', ');
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
		return Promise.all([
			uci.load('homecontrol'),
			L.resolveDefault(callStatus(), {}),
			L.resolveDefault(callWifiStatus(), {})
		]);
	},

	render: function(data) {
		const mapWrap = E('div', {});
		const view = this;
		const wifiIfaces = [];

		/* flatten live wireless ifaces for the bind list */
		const radios = ((data[2] || {}).radios) || [];
		for (let r = 0; r < radios.length; r++)
			for (let i = 0; i < (radios[r].ifaces || []).length; i++)
				wifiIfaces.push(radios[r].ifaces[i]);

		const clients = ((data[1] || {}).clients) || [];
		const clientName = {};
		for (let i = 0; i < clients.length; i++)
			clientName[clients[i].id] = clients[i].name || clients[i].id;

		const wifiName = {};
		for (let i = 0; i < wifiIfaces.length; i++)
			wifiName[wifiIfaces[i].id] = wifiIfaces[i].ssid || wifiIfaces[i].id;

		function targets_str(s) {
			const cn = [], wn = [];
			const cids = s.client_ids || [];
			for (let i = 0; i < cids.length; i++)
				cn.push(clientName[cids[i]] || cids[i]);
			const wids = s.wifi_ids || [];
			for (let i = 0; i < wids.length; i++)
				wn.push(wifiName[wids[i]] || wids[i]);
			const parts = [];
			if (cn.length)
				parts.push(_('Clients') + ': ' + cn.join(', '));
			if (wn.length)
				parts.push('Wi-Fi: ' + wn.join(', '));
			return parts.length ? parts.join(' · ') : _('(nothing bound)');
		}

		function renderSchedules() {
			mapWrap.innerHTML = '';
			const schs = [];
			uci.sections('homecontrol', 'schedule', function(s) { schs.push(s); });

			if (!schs.length) {
				mapWrap.appendChild(E('em', {}, [
					_('No schedules yet. Example: block kids\' tablets on school nights after 21:00, turn guest Wi-Fi off at night, allow internet only during homework hours.')
				]));
				return;
			}

			const tbl = E('table', { 'class': 'hc-tbl' }, [
				E('thead', {}, [ E('tr', {}, [
					E('th', {}, [ _('Name') ]),
					E('th', {}, [ _('Schedule type') ]),
					E('th', {}, [ _('Window') ]),
					E('th', {}, [ _('Bound to') ]),
					E('th', {}, [ _('Action') ]),
					E('th', {}, [ _('Enabled') ]),
					E('th', {}, [ '' ])
				]) ])
			]);

			for (let i = 0; i < schs.length; i++) {
				const s = schs[i];
				const sid = s['.name'];
				const deny = (s.action || 'deny') === 'deny';
				const tr = E('tr', {});
				tr.appendChild(E('td', {}, [ E('strong', {}, [ s.name || sid ]) ]));
				tr.appendChild(E('td', {}, [ TYPE_LABELS[s.type || 'daily'] || (s.type || 'daily') ]));
				tr.appendChild(E('td', {}, [ fmt_window(s) ]));
				tr.appendChild(E('td', {}, [ targets_str(s) ]));
				tr.appendChild(E('td', {}, [
					E('span', { 'class': 'hc-badge ' + (deny ? 'r' : 'g') },
						[ deny ? _('Block during the window (allowed outside)') : _('Allow only during the window (blocked outside)') ])
				]));

				const cb = E('input', { 'type': 'checkbox' });
				cb.checked = (s.enabled === '1');
				cb.addEventListener('change', function(ev) {
					uci.set('homecontrol', sid, 'enabled', ev.target.checked ? '1' : '0');
					uci.save().then(function() { return L.resolveDefault(callApply(), {}); });
				});
				tr.appendChild(E('td', {}, [ cb ]));

				const actions = E('td', {});
				actions.appendChild(E('button', {
					'class': 'btn cbi-button-remove',
					'click': ui.createHandlerFn(view, function() {
						uci.remove('homecontrol', sid);
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

		const dayChecks = E('div', { 'class': 'hc-checks' });
		for (let d = 0; d < DAYS.length; d++) {
			const lbl = E('label', {}, [ _(DAYS[d]) ]);
			const cb = E('input', { 'type': 'checkbox', 'value': DAYS[d] });
			lbl.insertBefore(cb, lbl.firstChild);
			dayChecks.appendChild(lbl);
		}

		const clientChecks = E('div', { 'class': 'hc-checks' });
		for (let i = 0; i < clients.length; i++) {
			const c = clients[i];
			const lbl = E('label', {}, [ c.name ]);
			const cb = E('input', { 'type': 'checkbox', 'value': c.id });
			lbl.insertBefore(cb, lbl.firstChild);
			clientChecks.appendChild(lbl);
		}

		const wifiChecks = E('div', { 'class': 'hc-checks' });
		for (let i = 0; i < wifiIfaces.length; i++) {
			const w = wifiIfaces[i];
			const lbl = E('label', {}, [ (w.ssid || w.id) ]);
			const cb = E('input', { 'type': 'checkbox', 'value': w.id });
			lbl.insertBefore(cb, lbl.firstChild);
			wifiChecks.appendChild(lbl);
		}

		const selAction = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'deny' }, [ _('Block during the window (allowed outside)') ]),
			E('option', { 'value': 'allow' }, [ _('Allow only during the window (blocked outside)') ])
		]);

		const actionHint = E('p', { 'style': 'color:#888; font-size:.85em; margin:4px 0 0' }, []);

		const HINT_DENY = _('While the window is active: bound clients have no internet and bound Wi-Fi networks are turned off. Outside the window everything works as usual.');
		const HINT_ALLOW = _('Access is granted ONLY while the window is active: bound clients have internet and bound Wi-Fi networks are on. Outside the window clients are blocked and Wi-Fi is turned off.');

		const rowTime = E('div', { 'class': 'hc-row' }, [
			E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('Time from') ]), inTimeStart ]),
			E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('Time to') ]), inTimeStop ]),
			E('div', { 'class': 'hc-field wide' }, [
				E('span', { 'class': 'hint', 'style': 'color:#999; font-size:.8em' },
					[ _('The window may cross midnight (e.g. 21:00 → 07:00).') ])
			])
		]);

		const rowDays = E('div', { 'class': 'hc-row' }, [
			E('div', { 'class': 'hc-field wide' }, [ E('label', {}, [ _('Days of week (weekly)') ]), dayChecks ])
		]);

		const rowDates = E('div', { 'class': 'hc-row' }, [
			E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('Date from') ]), inDateStart ]),
			E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('Date to') ]), inDateStop ])
		]);

		function updateTypeVis() {
			const t = selType.value;
			rowTime.style.display = (t === 'range') ? 'none' : '';
			rowDays.style.display = (t === 'weekly') ? '' : 'none';
			rowDates.style.display = (t === 'range' || t === 'timer') ? '' : 'none';
			actionHint.textContent = (selAction.value === 'deny') ? HINT_DENY : HINT_ALLOW;
		}

		selType.addEventListener('change', updateTypeVis);
		selAction.addEventListener('change', updateTypeVis);

		const addBtn = E('button', {
			'class': 'btn cbi-button-positive',
			'click': ui.createHandlerFn(this, function() {
				const name = inName.value.trim();
				if (!name) {
					ui.addNotification('error', _('Enter a schedule name'));
					return;
				}
				const type = selType.value;

				if ((type === 'daily' || type === 'weekly') && (!inTimeStart.value || !inTimeStop.value)) {
					ui.addNotification('error', _('For daily and weekly schedules, set the time window (from and to)'));
					return;
				}
				if (type === 'range' && (!inDateStart.value || !inDateStop.value)) {
					ui.addNotification('error', _('For a date range, set both dates'));
					return;
				}
				if (type === 'timer' && (!inDateStart.value || !inDateStop.value)) {
					ui.addNotification('error', _('For a one-shot timer, set both dates'));
					return;
				}

				const bound = [];
				clientChecks.querySelectorAll('input:checked').forEach(function(cb) { bound.push(cb.value); });
				const wifiBound = [];
				wifiChecks.querySelectorAll('input:checked').forEach(function(cb) { wifiBound.push(cb.value); });
				if (!bound.length && !wifiBound.length) {
					ui.addNotification('error', _('Bind at least one client or Wi-Fi interface'));
					return;
				}

				const sid = uci.add('homecontrol', 'schedule');
				uci.set('homecontrol', sid, 'name', name);
				uci.set('homecontrol', sid, 'type', type);
				uci.set('homecontrol', sid, 'enabled', '1');
				uci.set('homecontrol', sid, 'action', selAction.value);

				if (type === 'weekly') {
					const days = [];
					dayChecks.querySelectorAll('input:checked').forEach(function(cb) { days.push(cb.value); });
					for (let i = 0; i < days.length; i++)
						uci.add_list('homecontrol', sid, 'days', days[i]);
				}

				if (type === 'daily' || type === 'weekly') {
					uci.set('homecontrol', sid, 'time_start', inTimeStart.value);
					uci.set('homecontrol', sid, 'time_stop', inTimeStop.value);
				}
				if (type === 'range' || type === 'timer') {
					uci.set('homecontrol', sid, 'date_start', inDateStart.value);
					uci.set('homecontrol', sid, 'date_stop', inDateStop.value);
					if (type === 'timer') {
						if (inTimeStart.value) uci.set('homecontrol', sid, 'time_start', inTimeStart.value);
						if (inTimeStop.value) uci.set('homecontrol', sid, 'time_stop', inTimeStop.value);
					}
				}

				for (let i = 0; i < bound.length; i++)
					uci.add_list('homecontrol', sid, 'client_ids', bound[i]);
				for (let i = 0; i < wifiBound.length; i++)
					uci.add_list('homecontrol', sid, 'wifi_ids', wifiBound[i]);

				return uci.save().then(function() {
					ui.addNotification(null, _('Schedule created and applied'));
					inName.value = '';
					return L.resolveDefault(callApply(), {});
				});
			})
		}, [ _('Create schedule') ]);

		renderSchedules();
		updateTypeVis();

		return E([
			E('style', { 'type': 'text/css' }, [ CSS ]),
			E('h2', {}, [ _('HomeControl — Schedules') ]),
			E('p', {}, [ _('A schedule follows the clock: pick a time window (e.g. 21:00 → 07:00), bind clients or Wi-Fi networks, and choose what happens during the window — block it (allowed outside), or allow it (blocked outside). Windows may cross midnight.') ]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Existing schedules') ]),
				mapWrap
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Create schedule') ]),
				E('div', { 'class': 'hc-form' }, [
					E('div', { 'class': 'hc-row' }, [
						E('div', { 'class': 'hc-field wide' }, [ E('label', {}, [ _('Name') ]), inName ]),
						E('div', { 'class': 'hc-field' }, [ E('label', {}, [ _('Schedule type') ]), selType ])
					]),
					rowTime,
					rowDays,
					rowDates,
					E('div', { 'class': 'hc-row' }, [
						E('div', { 'class': 'hc-field wide' }, [
							E('label', {}, [ _('Action') ]),
							selAction,
							actionHint
						])
					]),
					E('div', { 'class': 'hc-row' }, [
						E('div', { 'class': 'hc-field wide' }, [ E('label', {}, [ _('Bind clients') ]), clientChecks ]),
						E('div', { 'class': 'hc-field wide' }, [ E('label', {}, [ _('Bind Wi-Fi') ]), wifiChecks ])
					]),
					E('div', { 'class': 'hc-row' }, [ E('div', { 'class': 'hc-field' }, [ addBtn ]) ])
				])
			])
		]);
	}
});
