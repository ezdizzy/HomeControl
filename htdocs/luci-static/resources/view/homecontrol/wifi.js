/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * HomeControl - Wi-Fi tab: permanent on/off toggle plus temporary off
 * (1h/2h/custom) with automatic re-enable, live status.
 */

'use strict';
'require poll';
'require rpc';
'require uci';
'require ui';
'require view';

const callWifiStatus = rpc.declare({
	object: 'luci.homecontrol',
	method: 'wifi_status',
	expect: { '': {} }
});

const callWifiSet = rpc.declare({
	object: 'luci.homecontrol',
	method: 'wifi_set',
	expect: { '': {} }
});

const callWifiTempOff = rpc.declare({
	object: 'luci.homecontrol',
	method: 'wifi_temp_off',
	expect: { '': {} }
});

const callWifiTempOn = rpc.declare({
	object: 'luci.homecontrol',
	method: 'wifi_temp_on',
	expect: { '': {} }
});

const CSS = `
	.hc-wifi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 12px; margin-top: 10px; }
	.hc-wifi-card { border: 1px solid rgba(128,128,128,.3); border-radius: 10px; padding: 12px 14px; }
	.hc-wifi-card.hc-off { border-left: 5px solid #d9534f; }
	.hc-wifi-card.hc-on { border-left: 5px solid #5cb85c; }
	.hc-ssid { font-weight: 700; font-size: 1.05em; margin-bottom: 2px; display: flex; align-items: center; gap: 8px; }
	.hc-radio { color: #888; font-size: .82em; margin-bottom: 10px; }
	.hc-wifi-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
	.hc-tempnote { color: #c77c11; font-size: .82em; margin-top: 6px; }
`;

function fmt_until(until) {
	const d = new Date(until * 1000);
	return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
		E('p', {}, [ _('Wi-Fi will turn back on automatically when the time is up.') ]),
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
		return Promise.all([ uci.load('wireless'), uci.load('homecontrol') ]);
	},

	render: function() {
		const grid = E('div', { 'class': 'hc-wifi-grid' }, []);
		const view = this;

		function render(st) {
			const radios = (st && st.radios) || [];
			const temps = (st && st.temps) || {};

			grid.innerHTML = '';
			if (!radios.length) {
				grid.appendChild(E('em', {}, [ _('No Wi-Fi radios detected.') ]));
				return;
			}

			for (let r = 0; r < radios.length; r++) {
				const radio = radios[r];
				const ifaces = radio.ifaces || [];

				if (!ifaces.length) {
					const card = E('div', { 'class': 'hc-wifi-card ' + (radio.up ? 'hc-on' : 'hc-off') }, [
						E('div', { 'class': 'hc-ssid' }, [
							E('span', {}, [ radio.radio ]),
							E('span', { 'class': 'hc-badge', 'style': 'font-size:.75em; padding:2px 8px; border-radius:10px; font-weight:600;' + (radio.up ? 'color:#5cb85c' : 'color:#d9534f') },
								[ radio.up ? _('enabled') : _('disabled') ])
						]),
						E('div', { 'class': 'hc-radio' }, [ radio.radio ]),
						E('div', { 'class': 'hc-wifi-actions' }, [
							E('button', {
								'class': 'btn cbi-button ' + (radio.up ? 'cbi-button-negative' : 'cbi-button-positive'),
								'click': ui.createHandlerFn(view, function() {
									return L.resolveDefault(callWifiSet({ iface: radio.radio, disabled: radio.up }), {});
								})
							}, [ radio.up ? _('Turn off') : _('Turn on') ]),
							E('button', {
								'class': 'btn cbi-button',
								'title': _('Turn off for a custom time'),
								'click': function() {
									customTimeModal(_('Turn off %s for...').format(radio.radio), 2, function(minutes) {
										L.resolveDefault(callWifiTempOff({ iface: radio.radio, minutes: minutes }), {});
									});
								}
							}, [ '⏱' ])
						])
					]);
					grid.appendChild(card);
					continue;
				}

				for (let i = 0; i < ifaces.length; i++) {
					const w = ifaces[i];
					const on = w.up && !w.disabled;
					const tempUntil = temps[w.id] || 0;
					const tempActive = tempUntil * 1000 > Date.now();

					const card = E('div', { 'class': 'hc-wifi-card ' + (on ? 'hc-on' : 'hc-off') }, [
						E('div', { 'class': 'hc-ssid' }, [
							E('span', { 'style': 'flex:none' }, [ on ? '📶' : '⛔' ]),
							E('span', {}, [ w.ssid || w.id ])
						]),
						E('div', { 'class': 'hc-radio' }, [ radio.radio + ' · ' + w.id ]),
						tempActive ? E('div', { 'class': 'hc-tempnote' },
							[ _('Off until') + ' ' + fmt_until(tempUntil) + ' · ' + _('then auto-on') ]) : '',
						E('div', { 'class': 'hc-wifi-actions' }, [
							E('button', {
								'class': 'btn cbi-button ' + (on ? 'cbi-button-negative' : 'cbi-button-positive'),
								'click': ui.createHandlerFn(view, function() {
									return L.resolveDefault(callWifiSet({ iface: w.id, disabled: on }), {});
								})
							}, [ on ? _('Turn off') : _('Turn on') ]),
							on ? E('button', {
								'class': 'btn cbi-button',
								'title': _('Turn off for a custom time'),
								'click': function() {
									customTimeModal(_('Turn off %s for...').format(w.ssid || w.id), 2, function(minutes) {
										L.resolveDefault(callWifiTempOff({ iface: w.id, minutes: minutes }), {});
									});
								}
							}, [ '⏱' ]) : '',
							tempActive ? E('button', {
								'class': 'btn cbi-button',
								'title': _('Cancel the temporary off'),
								'click': ui.createHandlerFn(view, function() {
									return L.resolveDefault(callWifiTempOn({ iface: w.id }), {});
								})
							}, [ _('On now') ]) : ''
						])
					]);
					grid.appendChild(card);
				}
			}
		}

		function refresh() {
			return L.resolveDefault(callWifiStatus(), {}).then(function(st) {
				render(st || {});
			});
		}

		poll.add(refresh, 6);
		refresh();

		return E([
			E('style', { 'type': 'text/css' }, [ CSS ]),
			E('h2', {}, [ _('HomeControl — Wi-Fi') ]),
			E('p', {}, [ _('Turn wireless on/off, or off for a while — it comes back automatically. Schedules (Schedules tab) can turn Wi-Fi off and on on a recurring pattern.') ]),
			grid
		]);
	}
});
