/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * HomeControl - Settings: master switch, logging options, app version and
 * self-update (GitHub releases).
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

const callUpdateCheck = rpc.declare({
	object: 'luci.homecontrol',
	method: 'update_check',
	expect: { '': {} }
});

const callUpdatePerform = rpc.declare({
	object: 'luci.homecontrol',
	method: 'update_perform',
	expect: { '': {} }
});

const callStatus = rpc.declare({
	object: 'luci.homecontrol',
	method: 'status',
	expect: { '': {} }
});

const CSS = `
	.hc-form { display: flex; flex-direction: column; gap: 12px; margin-top: 8px; }
	.hc-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
	.hc-field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 160px; }
	.hc-field > label { font-size: .85em; font-weight: 600; color: #777; }
	.hc-field > input { width: 100%; box-sizing: border-box; }
	.hc-check { display: flex; gap: 8px; align-items: center; font-weight: 600; }
	.hc-version { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
	.hc-verbadge { padding: 2px 12px; border-radius: 10px; font-weight: 700; background: rgba(128,128,128,.12); }
	.hc-updbadge { padding: 2px 12px; border-radius: 10px; font-weight: 700; }
	.hc-upbadge.g { background: rgba(92,184,92,.15); color: #5cb85c; }
	.hc-upbadge.o { background: rgba(240,173,78,.2); color: #c77c11; }
	.hc-pre { background: rgba(128,128,128,.08); border: 1px solid rgba(128,128,128,.2); border-radius: 8px; padding: 8px; max-height: 160px; overflow: auto; font-size: .82em; white-space: pre-wrap; }
`;

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('homecontrol'),
			L.resolveDefault(callStatus(), {})
		]);
	},

	render: function(data) {
		const view = this;
		const st = (data[1] || {});

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

		/* ── update section ─────────────────────────────────────────── */

		const checkBtn = E('button', { 'class': 'btn' }, [ _('Check for updates') ]);
		const installBtn = E('button', {
			'class': 'btn cbi-button-positive important', 'style': 'display:none'
		}, [ _('Download and install') ]);
		const verSpan = E('span', {
			'style': 'padding:2px 12px; border-radius:10px; font-weight:700; background:rgba(128,128,128,.12)'
		}, [ _('Version') + ': ' + (st.version || '—') ]);
		const upBadge = E('span', {
			'style': 'padding:2px 12px; border-radius:10px; font-weight:700; background:rgba(92,184,92,.15); color:#5cb85c'
		}, [ _('Up to date') ]);

		checkBtn.addEventListener('click', ui.createHandlerFn(view, function() {
			checkBtn.disabled = true;
			upBadge.style.background = 'rgba(240,173,78,.2)';
			upBadge.style.color = '#c77c11';
			upBadge.textContent = _('Checking…');
			return L.resolveDefault(callUpdateCheck(), {}).then(function(r) {
				checkBtn.disabled = false;
				if (!r || r.result === false) {
					upBadge.textContent = _('Check failed (no internet?)');
					return;
				}
				if (r.update_available) {
					upBadge.textContent = _('Update available') + ': ' + r.latest;
					installBtn.style.display = '';
				} else {
					upBadge.textContent = _('Up to date') + ' (' + r.latest + ')';
					installBtn.style.display = 'none';
				}
			});
		}));

		installBtn.addEventListener('click', ui.createHandlerFn(view, function() {
			ui.showModal(_('Install update'), [
				E('p', {}, [ _('The new version will be downloaded and installed now. This may take a minute; the page will need a refresh afterwards.') ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]),
					E('button', {
						'class': 'btn cbi-button-positive important',
						'click': ui.createHandlerFn(view, function() {
							ui.hideModal();
							installBtn.disabled = true;
							return L.resolveDefault(callUpdatePerform(), {}).then(function(r) {
								if (r && r.started)
									ui.addNotification(null, _('Update started — wait about a minute, then reload this page.'));
								else
									ui.addNotification('error', _('Update failed') + (r && r.error ? (': ' + r.error) : ''));
							});
						})
					}, [ _('Install') ])
				])
			]);
		}));

		return E([
			E('style', { 'type': 'text/css' }, [ CSS ]),
			E('h2', {}, [ _('HomeControl — Settings') ]),
			E('p', {}, [ _('Global behaviour of HomeControl.') ]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('General') ]),
				E('div', { 'class': 'hc-form' }, [
					E('div', { 'class': 'hc-row' }, [
						E('label', { 'class': 'hc-check' }, [
							enCB,
							_('Enable HomeControl enforcement')
						])
					]),
					E('div', { 'class': 'hc-row' }, [
						E('label', { 'class': 'hc-check' }, [
							logCB,
							_('Record events to the journal')
						]),
						E('div', { 'class': 'hc-field' }, [
							E('label', {}, [ _('Journal size (events)') ]),
							inLogMax
						])
					]),
					E('div', { 'class': 'hc-row' }, [ saveBtn ])
				])
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Application') ]),
				E('div', { 'class': 'hc-form' }, [
					E('div', { 'class': 'hc-row' }, [
						verSpan,
						upBadge,
						checkBtn,
						installBtn
					])
				])
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('How enforcement works') ]),
				E('ul', {}, [
					E('li', {}, [ _('Blocked clients: their IPv4 addresses and MACs are dropped in the firewall (forward + output chains).') ]),
					E('li', {}, [ _('Blocked domains: answered with NXDOMAIN by dnsmasq, so they fail fast without timeouts. A rule without clients applies to the whole network; a rule bound to specific clients is enforced only on them.') ]),
					E('li', {}, [ _('Rule time windows: outside the window the rule is skipped — sites are reachable again automatically.') ]),
					E('li', {}, [ _('Schedules: checked every minute by the service; windows may cross midnight.') ]),
					E('li', {}, [ _('Pause switch (Dashboard): disables all temporary and scheduled blocks at once — useful for parents.') ])
				])
			])
		]);
	}
});
