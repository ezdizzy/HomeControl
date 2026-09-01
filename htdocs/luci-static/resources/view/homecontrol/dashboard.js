/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * HomeControl - Dashboard: global status card, client grid with color-coded
 * state badges and quick actions, live-polled.
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

const callSetPaused = rpc.declare({
	object: 'luci.homecontrol',
	method: 'set_paused',
	expect: { '': {} }
});

const callApply = rpc.declare({
	object: 'luci.homecontrol',
	method: 'apply',
	expect: { '': {} }
});

const CSS = `
	.hc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin-top: 8px; }
	.hc-card { border: 1px solid rgba(128,128,128,.3); border-radius: 10px; padding: 10px 12px; background: rgba(127,127,127,.04); }
	.hc-card.hc-blocked { border-left: 5px solid #d9534f; }
	.hc-card.hc-allowed { border-left: 5px solid #5cb85c; }
	.hc-card.hc-offline { opacity: .65; }
	.hc-name { font-weight: 600; font-size: 1.05em; margin-bottom: 2px; display: flex; align-items: center; gap: 8px; }
	.hc-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
	.hc-dot.on { background: #5cb85c; box-shadow: 0 0 4px #5cb85c; }
	.hc-dot.off { background: #999; }
	.hc-meta { color: #888; font-size: .85em; margin-bottom: 8px; }
	.hc-badge { font-size: .75em; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
	.hc-badge.b-block { background: rgba(217,83,79,.15); color: #d9534f; }
	.hc-badge.b-allow { background: rgba(92,184,92,.15); color: #5cb85c; }
	.hc-badge.b-temp { background: rgba(240,173,78,.2); color: #c77c11; }
	.hc-badge.b-sched { background: rgba(91,140,255,.18); color: #4a7fe0; }
	.hc-actions { display: flex; gap: 6px; flex-wrap: wrap; }
	.hc-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap: 10px; margin: 8px 0 18px; }
	.hc-stat { border: 1px solid rgba(128,128,128,.3); border-radius: 10px; padding: 12px; text-align: center; }
	.hc-stat .n { font-size: 1.9em; font-weight: 700; line-height: 1.1; }
	.hc-stat .l { color: #888; font-size: .85em; }
	.hc-stat.green .n { color: #5cb85c; }
	.hc-stat.red .n { color: #d9534f; }
	.hc-stat.blue .n { color: #4a7fe0; }
	.hc-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
`;

function badge(state, reason) {
	if (state === 'block') {
		if (reason === 'temp')
			return E('span', { 'class': 'hc-badge b-temp' }, [_('Temp block')]);
		if (reason === 'schedule')
			return E('span', { 'class': 'hc-badge b-sched' }, [_('Schedule')]);
		return E('span', { 'class': 'hc-badge b-block' }, [_('Blocked')]);
	}
	return E('span', { 'class': 'hc-badge b-allow' }, [_('Allowed')]);
}

return view.extend({
	load: function() {
		return Promise.all([ uci.load('homecontrol') ]);
	},

	render: function() {
		const grid = E('div', { 'class': 'hc-grid' }, []);
		const statsEn = E('div', { 'class': 'n' }, '—');
		const statsBl = E('div', { 'class': 'n' }, '—');
		const statsAl = E('div', { 'class': 'n' }, '—');
		const statsSc = E('div', { 'class': 'n' }, '—');

		const pauseBtn = E('button', {
			'class': 'btn cbi-button',
			'click': ui.createHandlerFn(this, function(ev) {
				const cur = this.paused === true;
				return L.resolveDefault(callSetPaused({ paused: !cur }), {}).then(function() {
					return L.resolveDefault(callApply(), {});
				});
			})
		}, [ _('Pause all enforcement') ]);

		const toolbar = E('div', { 'class': 'hc-toolbar' }, [
			E('span', { 'id': 'hc-master-state' }, []),
			pauseBtn
		]);

		const stats = E('div', { 'class': 'hc-stats' }, [
			E('div', { 'class': 'hc-stat' }, [ statsEn, E('div', { 'class': 'l' }, [_('Managed clients')]) ]),
			E('div', { 'class': 'hc-stat red' }, [ statsBl, E('div', { 'class': 'l' }, [_('Blocked now')]) ]),
			E('div', { 'class': 'hc-stat green' }, [ statsAl, E('div', { 'class': 'l' }, [_('Allowed')]) ]),
			E('div', { 'class': 'hc-stat blue' }, [ statsSc, E('div', { 'class': 'l' }, [_('Active schedules')]) ])
		]);

		const view = this;

		function refresh() {
			return L.resolveDefault(callStatus(), {}).then(function(st) {
				if (!st || st.error) {
					grid.innerHTML = '';
					grid.appendChild(E('em', {}, [ _('Status unavailable — is the service running?') ]));
					return;
				}

				view.paused = st.paused;
				const ms = document.getElementById('hc-master-state');
				if (ms) {
					ms.innerHTML = '';
					ms.appendChild(E('span', {
						'style': 'font-weight:700; color:' + (st.enabled && !st.paused ? '#5cb85c' : '#d9534f')
					}, [
						st.paused ? _('PAUSED — everything allowed') :
							(st.enabled ? _('Active') : _('Disabled (enable in Settings)'))
					]));
				}

				statsEn.textContent = st.clients_total;
				statsBl.textContent = st.blocked;
				statsAl.textContent = st.allowed;
				statsSc.textContent = st.schedules;

				const sig = JSON.stringify(st.clients) + '|' + st.enabled + '|' + st.paused;
				if (sig === refresh._sig)
					return;
				refresh._sig = sig;

				grid.innerHTML = '';
				if (!st.clients.length) {
					grid.appendChild(E('em', {}, [ _('No clients yet — add them in the Clients tab.') ]));
					return;
				}

				for (let i = 0; i < st.clients.length; i++) {
					const c = st.clients[i];
					const blocked = (c.state === 'block');

					const card = E('div', { 'class': 'hc-card ' + (blocked ? 'hc-blocked' : 'hc-allowed') + (c.online ? '' : ' hc-offline') }, [
						E('div', { 'class': 'hc-name' }, [
							E('span', { 'class': 'hc-dot ' + (c.online ? 'on' : 'off'), 'title': c.online ? _('Online') : _('Offline') }),
							c.name,
							badge(c.state, c.reason)
						]),
						E('div', { 'class': 'hc-meta' }, [
							[c.ip, c.mac].filter(Boolean).join(' · ') || _('no address known')
						]),
						E('div', { 'class': 'hc-actions' }, [
							E('button', {
								'class': 'btn cbi-button ' + (blocked ? 'cbi-button-positive' : 'cbi-button-negative'),
								'click': ui.createHandlerFn(view, function() {
									return L.resolveDefault(callSetBlocked({ id: c.id, blocked: !blocked }), {})
										.then(function() { return L.resolveDefault(callApply(), {}); });
								})
							}, [ blocked ? _('Allow') : _('Block') ]),
							E('button', {
								'class': 'btn cbi-button',
								'title': _('Block for one hour'),
								'click': ui.createHandlerFn(view, function() {
									return L.resolveDefault(callTempBlock({ id: c.id, minutes: 60 }), {})
										.then(function() { return L.resolveDefault(callApply(), {}); });
								})
							}, [ _('Block 1h') ])
						])
					]);
					grid.appendChild(card);
				}
			});
		}

		poll.add(refresh, 5);
		refresh();

		return E([
			E('style', { 'type': 'text/css' }, [ CSS ]),
			E('h2', {}, [ _('HomeControl — Dashboard') ]),
			E('p', {}, [ _('Overview of managed clients and their current access state.') ]),
			toolbar,
			stats,
			grid
		]);
	}
});
