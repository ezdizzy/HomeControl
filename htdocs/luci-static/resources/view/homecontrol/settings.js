/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * HomeControl - Settings: master switch, default policy, logging options.
 */

'use strict';
'require rpc';
'require uci';
'require view';

const callApply = rpc.declare({
	object: 'luci.homecontrol',
	method: 'apply',
	expect: { '': {} }
});

return view.extend({
	load: function() {
		return uci.load('homecontrol');
	},

	render: function() {
		const view = this;

		const enCB = E('input', { 'type': 'checkbox' });
		enCB.checked = (uci.get('homecontrol', 'main', 'enabled') === '1');

		const logCB = E('input', { 'type': 'checkbox' });
		logCB.checked = (uci.get('homecontrol', 'main', 'log_enabled', '1') === '1');

		const inLogMax = E('input', {
			'type': 'number', 'class': 'cbi-input-text',
			'min': 50, 'max': 5000,
			'value': uci.get('homecontrol', 'main', 'log_max') || '500'
		});

		const saveBtn = E('button', {
			'class': 'btn cbi-button-positive important',
			'click': ui.createHandlerFn(view, function() {
				uci.set('homecontrol', 'main', 'enabled', enCB.checked ? '1' : '0');
				uci.set('homecontrol', 'main', 'log_enabled', logCB.checked ? '1' : '0');
				uci.set('homecontrol', 'main', 'log_max', String(inLogMax.value || 500));
				return uci.save().then(function() {
					return L.resolveDefault(callApply(), {});
				});
			})
		}, [ _('Save and apply') ]);

		return E([
			E('h2', {}, [ _('HomeControl — Settings') ]),
			E('p', {}, [ _('Global behaviour of HomeControl.') ]),

			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'style': 'display:flex; gap:8px; align-items:center' }, [
						enCB,
						E('strong', {}, [ _('Enable HomeControl enforcement') ])
					])
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'style': 'display:flex; gap:8px; align-items:center' }, [
						logCB,
						_('Record events to the journal')
					])
				]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', {}, [ _('Journal size (events)') ]),
					inLogMax
				]),
				E('div', { 'style': 'margin-top: 12px' }, [ saveBtn ])
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('How enforcement works') ]),
				E('ul', {}, [
					E('li', {}, [ _('Blocked clients: their IPv4 addresses and MACs are dropped in the firewall (forward + output chains).') ]),
					E('li', {}, [ _('Blocked domains: answered with NXDOMAIN by dnsmasq, so they fail fast without timeouts.') ]),
					E('li', {}, [ _('Schedules: checked every minute by the service; windows may cross midnight.') ]),
					E('li', {}, [ _('Pause switch (Dashboard): disables all temporary and scheduled blocks at once — useful for parents.') ])
				])
			])
		]);
	}
});
