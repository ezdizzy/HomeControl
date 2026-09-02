/*
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * HomeControl - Journal: event log (blocks, unblocks, Wi-Fi changes,
 * schedule activity) with live polling, a scrollable list, a clear
 * button, and the service log tail.
 */

'use strict';
'require poll';
'require rpc';
'require ui';
'require view';

const callEvents = rpc.declare({
	object: 'luci.homecontrol',
	method: 'events',
	expect: { '': {} }
});

const callEventsClear = rpc.declare({
	object: 'luci.homecontrol',
	method: 'events_clear',
	expect: { '': {} }
});

const callLogTail = rpc.declare({
	object: 'luci.homecontrol',
	method: 'log_tail',
	expect: { '': {} }
});

const CSS = `
	.hc-tbl { width: 100%; border-collapse: collapse; }
	.hc-tbl th { text-align: left; padding: 6px 8px; border-bottom: 2px solid rgba(128,128,128,.35); }
	.hc-tbl td { padding: 5px 8px; border-bottom: 1px solid rgba(128,128,128,.12); font-size: .93em; }
	.hc-ev { font-size: .75em; padding: 2px 8px; border-radius: 10px; font-weight: 600; white-space: nowrap; }
	.hc-ev.block { background: rgba(217,83,79,.15); color: #d9534f; }
	.hc-ev.allow { background: rgba(92,184,92,.15); color: #5cb85c; }
	.hc-ev.temp { background: rgba(240,173,78,.2); color: #c77c11; }
	.hc-ev.wifi { background: rgba(91,140,255,.15); color: #4a7fe0; }
	.hc-ev.system, .hc-ev.schedule { background: rgba(128,128,128,.15); color: #888; }
	.hc-pre { background: rgba(128,128,128,.08); border: 1px solid rgba(128,128,128,.2); border-radius: 8px; padding: 8px; max-height: 300px; overflow: auto; font-size: .85em; }
	.hc-ts { color: #888; white-space: nowrap; }
	.hc-scroll { max-height: 420px; overflow-y: auto; border: 1px solid rgba(128,128,128,.2); border-radius: 8px; padding: 0 8px; }
	.hc-headrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
`;

function fmt_ts(unix) {
	const d = new Date(unix * 1000);
	return d.toLocaleString();
}

return view.extend({
	render: function() {
		const view = this;
		const evWrap = E('div', { 'class': 'hc-scroll' }, [ E('em', {}, [ _('No events yet.') ]) ]);
		const logWrap = E('pre', { 'class': 'hc-pre' }, [ '—' ]);

		function refreshEvents() {
			return L.resolveDefault(callEvents({ limit: 100 }), {}).then(function(r) {
				const events = (r && r.events) || [];
				const sig = JSON.stringify(events);
				if (sig === refreshEvents._sig)
					return;
				refreshEvents._sig = sig;

				evWrap.innerHTML = '';
				if (!events.length) {
					evWrap.appendChild(E('em', { 'style': 'display:block; padding:8px 0' }, [ _('No events yet.') ]));
					return;
				}

				const tbl = E('table', { 'class': 'hc-tbl' }, [
					E('thead', {}, [ E('tr', {}, [
						E('th', {}, [ _('Time') ]),
						E('th', {}, [ _('Event') ]),
						E('th', {}, [ _('Who') ]),
						E('th', {}, [ _('Details') ])
					]) ])
				]);
				const tbody = E('tbody', {});

				for (let i = events.length - 1; i >= 0 && i >= events.length - 100; i--) {
					const e = events[i];
					const tr = E('tr', {});
					tr.appendChild(E('td', { 'class': 'hc-ts' }, [ fmt_ts(e.ts) ]));
					tr.appendChild(E('td', {}, [
						E('span', { 'class': 'hc-ev ' + (e.type || 'system') }, [ e.type || '?' ])
					]));
					tr.appendChild(E('td', {}, [ e.who || '—' ]));
					tr.appendChild(E('td', {}, [ e.detail || '' ]));
					tbody.appendChild(tr);
				}
				tbl.appendChild(tbody);
				evWrap.appendChild(tbl);
			});
		}

		function refreshLog() {
			return L.resolveDefault(callLogTail({ lines: 40 }), {}).then(function(r) {
				logWrap.textContent = (r && r.content) || '—';
			});
		}

		const clearBtn = E('button', {
			'class': 'btn cbi-button-negative',
			'click': ui.createHandlerFn(view, function() {
				ui.showModal(_('Clear events'), [
					E('p', {}, [ _('All recorded events will be deleted. The service log is not affected.') ]),
					E('div', { 'class': 'right' }, [
						E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]),
						E('button', {
							'class': 'btn cbi-button-negative important',
							'click': ui.createHandlerFn(view, function() {
								ui.hideModal();
								return L.resolveDefault(callEventsClear(), {}).then(function() {
									refreshEvents._sig = null;
									return refreshEvents();
								});
							})
						}, [ _('Clear') ])
					])
				]);
			})
		}, [ _('Clear events') ]);

		poll.add(refreshEvents, 6);
		poll.add(refreshLog, 15);
		refreshEvents();
		refreshLog();

		return E([
			E('style', { 'type': 'text/css' }, [ CSS ]),
			E('h2', {}, [ _('HomeControl — Journal') ]),
			E('p', {}, [ _('What happened and when: blocks, unblocks, Wi-Fi toggles, schedule activity.') ]),

			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'hc-headrow' }, [
					E('h3', { 'style': 'margin:0' }, [ _('Events') ]),
					clearBtn
				]),
				evWrap
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Service log') ]),
				logWrap
			])
		]);
	}
});
