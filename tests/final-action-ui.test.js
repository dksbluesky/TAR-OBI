'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const monitor = require('../bridge-monitor.js');
const repoZone = require('../repo-zone-link.js');

function bridge(overrides = {}) {
    return {
        activeZone: { low: 28.8, high: 29.5 },
        invalidationLevel: 28.6,
        zoneMode: 'automatic',
        extensions: { marketContextV1: { context: 'bullish', automaticZoneEligible: true } },
        notificationState: { continuousValidity: { status: 'LIVE' } },
        ...overrides
    };
}

assert.equal(
    monitor.finalActionContext(bridge(), 'ENTRY CONDITIONS MET', 29.1).action,
    'BUY_NOW',
    'a valid AUTO zone with the existing LIVE confirmation presents BUY NOW'
);
assert.equal(
    monitor.finalActionContext(bridge({ extensions: { sourceContextUpdatedAt: '2000-01-01T00:00:00.000Z', marketContextV1: { context: 'bullish', automaticZoneEligible: true } } }), 'ENTRY CONDITIONS MET', 29.1).action,
    'BUY_NOW',
    'an old transport heartbeat does not make valid ETF context stale'
);
assert.equal(
    monitor.finalActionContext(bridge({ zoneMode: 'manual', extensions: { marketContextV1: { manualOverride: true } } }), 'ENTRY CONDITIONS MET', 29.1).action,
    'BUY_NOW',
    'a valid MANUAL zone uses the same existing LIVE confirmation result'
);
const reassessed = bridge({
    zoneMode: 'manual',
    extensions: {
        sourceContextUpdatedAt: '2026-07-27T02:00:00.000Z',
        marketContextV1: { context: 'unclear', automaticZoneEligible: false, manualOverride: true }
    }
});
const originalNow = Date.now;
try {
    for (const elapsedMs of [91_000, 24 * 60 * 60 * 1000]) {
        Date.now = () => Date.parse('2026-07-27T02:00:00.000Z') + elapsedMs;
        assert.equal(monitor.sourceContextHeartbeatStale(reassessed), true);
        const action = monitor.finalActionContext(reassessed, 'ENTRY CONDITIONS MET', 29.1, 'live');
        assert.equal(action.action, 'BUY_NOW', `a valid reassessed context remains usable after ${elapsedMs} ms without an ETF heartbeat`);
        assert.notEqual(action.reason, 'ETF CONTEXT STALE');
    }
} finally {
    Date.now = originalNow;
}
assert.equal(
    monitor.finalActionContext(bridge({ notificationState: { continuousValidity: { status: 'PENDING' } } }), 'ENTRY CONDITIONS MET', 29.1).action,
    'WAIT',
    'raw ENTRY CONDITIONS MET remains WAIT until the existing linked confirmation is LIVE'
);

assert.equal(
    monitor.finalActionContext(bridge(), 'WAIT FOR PULLBACK', 29.1).action,
    'WAIT',
    'the existing pullback state remains WAIT'
);
assert.equal(
    monitor.finalActionContext(bridge(), 'WAIT FOR CONFIRMATION', 29.1).action,
    'WAIT',
    'the existing confirmation state remains WAIT'
);
assert.equal(
    monitor.finalActionContext(bridge(), 'DO NOT ENTER', 29.1).action,
    'DO_NOT_ENTER',
    'the existing blocking state remains DO NOT ENTER'
);
assert.equal(monitor.signalModeLabel('ENTRY CONDITIONS MET'), 'RIGHT — CONFIRMED');
assert.equal(monitor.signalModeLabel('LEFT-SIDE STARTER ELIGIBLE'), 'LEFT — STARTER');
assert.equal(monitor.signalModeLabel('LEFT-SIDE EXECUTION ACCEPTABLE'), 'LEFT — STARTER');
assert.equal(monitor.signalModeLabel('HIGH-RISK LEFT-SIDE ENTRY'), 'LEFT — STARTER');
assert.equal(monitor.signalModeLabel('WAIT FOR CONFIRMATION'), 'NO ENTRY MODE');
assert.equal(monitor.signalModeLabel('DO NOT ENTER'), 'NO ENTRY MODE');
const noLinkedZone = monitor.finalActionContext(null, 'ENTRY CONDITIONS MET', 29.1, 'closed');
assert.equal(noLinkedZone.action, 'DO_NOT_ENTER');
assert.equal(noLinkedZone.reason, 'No valid Active Zone');
assert.equal(noLinkedZone.zoneInvalid, false, 'an absent linked zone is not invalidation');
const repoLink = { version: 1, source: 'ETF_DCA-plan GitHub', ticker: '006208',
    activeZone: { low: 203, high: 209 }, zoneMode: 'manual_reassessment',
    appliedAt: '2026-11-18T08:00:00.000Z', portfolioUpdatedAt: '2026-11-18T08:30:00.000Z',
    syncedAt: '2026-11-18T09:00:00.000Z' };
assert.equal(repoZone.isLink(repoLink), true);
assert.equal(monitor.finalActionContext(repoLink, 'ENTRY CONDITIONS MET', 205, 'live').action, 'WAIT',
    'a saved GitHub zone cannot create a live monitor BUY NOW confirmation');

const closedSession = monitor.finalActionContext(bridge(), 'ENTRY CONDITIONS MET', 29.1, 'closed');
assert.equal(closedSession.action, 'WAIT');
assert.match(closedSession.reason, /Closed-session result/);
const noZone = monitor.finalActionContext(bridge({ activeZone: null }), 'ENTRY CONDITIONS MET', 29.1);
assert.equal(noZone.action, 'DO_NOT_ENTER');
assert.equal(noZone.reason, 'No valid Active Zone');
assert.equal(noZone.zoneInvalid, false, 'no valid zone is not presented as invalidation');

const invalidated = monitor.finalActionContext(bridge(), 'ENTRY CONDITIONS MET', 28.4);
assert.equal(invalidated.action, 'DO_NOT_ENTER');
assert.equal(invalidated.zoneInvalid, true, 'only the linked ETF_DCA invalidation produces ZONE INVALID');

const html = fs.readFileSync(path.join(__dirname, '..', 'entry-assessment.html'), 'utf8');
assert.match(html, /id="final-action"/);
assert.match(html, /id="final-action-zone-warning"/);
assert.match(html, /SIGNAL MODE/);
assert.match(html, /id="signal-mode"/);
assert.match(html, /TarObiBridgeMonitor\?\.signalModeLabel\?\.\(assessment\.state\)/);
assert.match(html, /TarObiBridgeMonitor\?\.finalActionContext\?\.\(linkedBridge, assessment\.state, price, session\)/);
assert.doesNotMatch(html, /TAR-OBI Assessment Invalidation/);
assert.match(html, /ETF_DCA Manual \/ Trailing Invalidation/);
assert.match(html, /automatic_context: 'AUTO \/ CONTEXT'/);
assert.match(html, /manual: 'MANUAL'/);
assert.match(html, /aggressive_override: 'SUGGESTED \/ AGGRESSIVE'/);
assert.match(html, /conservative_override: 'SUGGESTED \/ CONSERVATIVE'/);
assert.match(html, /id="shadow-rr-summary"/);
assert.match(html, /<details class="mt-4 rounded-lg border border-indigo-100 p-3 text-sm text-slate-600">/);
assert.ok(html.indexOf('id="bid"') < html.indexOf('id="entry-basis"'));
assert.ok(html.indexOf('id="entry-basis"') < html.indexOf('id="market-card"'));
assert.ok(html.indexOf('id="market-card"') < html.indexOf('id="final-action"'));
assert.ok(html.indexOf('id="factor-list"') < html.indexOf('id="shadow-rr-summary"'));
assert.ok(html.indexOf('id="shadow-rr-summary"') < html.indexOf('id="shadow-rr-details"'));
assert.ok(html.indexOf('id="entry-basis"') < html.indexOf('id="shadow-rr-details"'));
assert.ok(html.indexOf('id="shadow-rr-details"') < html.indexOf('id="restore-linked-monitor"'));
assert.match(html, /renderRestorePanel\(restorePanel,/);
assert.match(html, /executionContext\.classList\.add\('hidden'\)/);
assert.doesNotMatch(html, /Entry Structural Stop \/ 進場結構停損/);
assert.doesNotMatch(html, /Entry Stop Basis \/ 進場停損依據/);
assert.doesNotMatch(html, /Gross R&R \(ETF broad risk\)/);
assert.match(html, /id="planned-buy"/);
assert.match(html, /R&R unavailable \/ 暫無風險報酬比/);
assert.match(html, /Risk per unit \/ 每單位風險/);
assert.doesNotMatch(html, /Entry: \$\{money\(calculation\.entry\)\}/);
assert.match(html, /id="planned-stop"/);
assert.match(html, /id="clear-trade-plan"/);
assert.match(html, /tarObi\.shadowRr\.tradePlan\.v1/);
assert.match(html, /id="trade-plan-warning" role="status"/);
assert.match(html, /Stop must be below entry; Planned Buy must be above Planned Stop/);
assert.match(html, /PREVIOUS-SESSION REFERENCE/);
assert.match(html, /CLOSED-SESSION REFERENCE/);
assert.match(html, /evidenceValid: shadow\.candleQuality\?\.status === 'OK'/);
assert.match(html, /askValid: askIsLive/);
assert.match(html, /Last known Ask 1 — stale/);
assert.match(html, /REFERENCE ONLY — ETF broad invalidation; not used in Planned or Executable R&R/);
assert.doesNotMatch(html, /\['Shadow Assessment \/ 模擬評估', shadow\.rrAssessment\]/);
assert.doesNotMatch(html, /Net R&R \/ 淨風險報酬比/);
assert.match(html, /Candles analysed \/ 已分析五分K/);
assert.match(html, /completedFiveMinuteBars\(null, intradayCandles, shadow\.asOf\)\.length/);
const elements = new Map();
const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', className: '', children: [],
        classList: { toggle() {} }, replaceChildren(...children) { this.children = children; } });
    return elements.get(id);
};
const context = { document: {
    getElementById: element,
    createElement: () => ({ textContent: '', children: [], append(...children) { this.children = children; } })
}, window: { addEventListener() {}, TarObiRepoZone: repoZone, TarObiBridgeMonitor: monitor } };
vm.createContext(context);
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
vm.runInContext(inline, context);
const assessment = { state: 'ENTRY CONDITIONS MET', factors: [] };
context.renderFinalAction(assessment, repoLink, 205, 0.05, true, 'live');
assert.match(element('final-action-title').textContent, /WAIT/);
assert.match(element('final-action-reason').textContent, /GitHub Active Zone 已同步/);
assert.match(element('signal-mode').textContent, /NO LIVE ETF MONITOR/);
assert.deepEqual(element('final-action-details').children.map(item => [item.children[0].textContent, item.children[1].textContent])
    .filter(([label]) => ['Active Zone', 'Zone Source'].includes(label)),
    [['Active Zone', '203.00–209.00'], ['Zone Source', 'ETF_DCA GitHub / MANUAL']]);
context.renderFinalAction(assessment, repoLink, 210, 0.05, true, 'live');
assert.match(element('final-action-title').textContent, /DO NOT ENTER/);
assert.match(element('final-action-reason').textContent, /現價不在 ETF_DCA GitHub Active Zone/);
context.renderFinalAction(assessment, null, 205, 0.05, true, 'live');
assert.match(element('final-action-title').textContent, /DO NOT ENTER/);
context.renderFinalAction(assessment, bridge({ activeZone: { low: 203, high: 209 }, invalidationLevel: 200 }), 205, 0.05, true, 'live');
assert.match(element('final-action-title').textContent, /BUY NOW/, 'existing live Bridge behavior remains available');
console.log('final action UI tests passed');
