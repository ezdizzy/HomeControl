/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * HomeControl - Wi-Fi tab: toggle radios/interfaces, manage per-iface
 * overrides handled by HomeControl schedules.
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

const callApply = rpc.declare({
	object: 'luci.homecontrol',
	method: 'apply',
	expect: { '': {} }
});

const CSS = `
	.hc-wifi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-top: 10px; }
	.hc-wifi-card { border: 1px solid rgba(128,128,128,.3); border-radius: 10px; padding: 12px 14px; }
	.hc-wifi-card.hc-off { border-left: 5px solid #d9534f; }
	.hc-wifi-card.hc-on { border-left: 5px solid #5cb85c; }
	.hc-ssid { font-weight: 700; font-size: 1.05em; margin-bottom: 4px; }
	.hc-radio { color: #888; font-size: .82em; margin-bottom: 10px; }
`;

return view.extend({
	load: function() {
		return Promise.all([ uci.load('wireless'), uci.load('homecontrol') ]);
	},

	render: function() {
		const grid = E('div', { 'class': 'hc-wifi-grid' }, []);
		const view = this;

		function refresh() {
			return L.resolveDefault(callWifiStatus(), {}).then(function(st) {
				const radios = (st && st.radios) || [];
				const sig = JSON.stringify(radios);
				if (sig === refresh._sig)
					return;
				refresh._sig = sig;

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
							E('div', { 'class': 'hc-ssid' }, [ radio.radio ]),
							E('div', { 'class': 'hc-radio' }, [ radio.up ? _('enabled') : _('disabled') ]),
							E('button', {
								'class': 'btn cbi-button ' + (radio.up ? 'cbi-button-negative' : 'cbi-button-positive'),
								'click': ui.createHandlerFn(view, function() {
									return L.resolveDefault(callWifiSet({ iface: radio.radio, disabled: radio.up }), {})
										.then(function() { return L.resolveDefault(callApply(), {}); });
								})
							}, [ radio.up ? _('Turn off radio') : _('Turn on radio') ])
						]);
						grid.appendChild(card);
						continue;
					}

					for (let i = 0; i < ifaces.length; i++) {
						const w = ifaces[i];
						const on = w.up && !w.disabled;
						const card = E('div', { 'class': 'hc-wifi-card ' + (on ? 'hc-on' : 'hc-off') }, [
							E('div', { 'class': 'hc-ssid' }, [
								E('span', { 'style': 'margin-right:6px' }, [ on ? '📶' : '⛔' ]),
								w.ssid || w.id
							]),
							E('div', { 'class': 'hc-radio' }, [ radio.radio + ' · ' + w.id ]),
							E('button', {
								'class': 'btn cbi-button ' + (on ? 'cbi-button-negative' : 'cbi-button-positive'),
								'click': ui.createHandlerFn(view, function() {
									return L.resolveDefault(callWifiSet({ iface: w.id, disabled: on }), {})
										.then(function() { return L.resolveDefault(callApply(), {}); });
								})
							}, [ on ? _('Turn off') : _('Turn on') ])
						]);
						grid.appendChild(card);
					}
				}
			});
		}

		poll.add(refresh, 8);
		refresh();

		return E([
			E('style', { 'type': 'text/css' }, [ CSS ]),
			E('h2', {}, [ _('HomeControl — Wi-Fi') ]),
			E('p', {}, [ _('Turn wireless interfaces on or off. Schedules can also disable them automatically at night or during study hours.') ]),
			grid
		]);
	}
});
