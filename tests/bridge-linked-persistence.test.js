'use strict';

const assert = require('node:assert/strict');
const loaderPath = require.resolve('../bridge-loader.js');
const monitorPath = require.resolve('../bridge-monitor.js');
const STORAGE_KEY = 'etfDca.executionBridge.v1';

function createStorage(bridge) {
    const values = new Map([[STORAGE_KEY, JSON.stringify(bridge)]]);
    return {
        values,
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); }
    };
}

function bridge(overrides = {}) {
    return {
        version: '1.0',
        bridgeId: 'pending-bridge',
        ticker: '006208',
        createdAt: '2026-08-03T01:00:00.000Z',
        sourceApplication: 'ETF_DCA-plan',
        marketTimeframe: '1d',
        marketLevelTimeframe: 'daily',
        zoneMode: 'manual',
        activeZone: { low: 218, high: 222 },
        preferredEntry: null,
        maximumEntryPrice: null,
        invalidationLevel: 217,
        entryMode: 'pending',
        starterEligible: false,
        starterAllocationPct: null,
        starterExecuted: false,
        starterRisk: null,
        lifecycle: {
            status: 'ACTIVE',
            updatedAt: '2026-08-03T01:00:00.000Z',
            expiresAt: '2099-08-03T05:30:00.000Z',
            reason: null
        },
        monitorResult: null,
        notificationState: { lastNotifiedState: null, lastNotifiedAt: null },
        extensions: {},
        ...overrides
    };
}

function completedSnapshot(overrides = {}) {
    return {
        complete: true,
        ticker: '006208',
        evaluatedAt: '2026-08-03T01:01:00.000Z',
        currentPrice: 220.2,
        entryMode: 'pending',
        assessment: {
            state: 'WAIT FOR CONFIRMATION',
            lower: 220,
            upper: 220.3,
            maximum: 220.4,
            invalidation: 219.5,
            factors: ['Waiting for confirmation'],
            blockingReason: null
        },
        tarState: 'Balanced',
        obiState: 'Neutral',
        vwapState: 'Near VWAP',
        spreadState: 'ACCEPTABLE',
        volumeQuality: 'NORMAL',
        ...overrides
    };
}

const storage = createStorage(bridge());
global.localStorage = storage;
global.addEventListener = () => {};
delete global.Notification;
delete require.cache[loaderPath];
delete require.cache[monitorPath];
const loader = require(loaderPath);
const monitor = require(monitorPath);

assert.equal(loader.initialize().mode, 'linked');
assert.equal(loader.getLinkedBridge().entryMode, 'pending');

let uiRefreshes = 0;
monitor.mount({
    bridgeApi: loader,
    onUiRefresh() { uiRefreshes += 1; }
});
assert.equal(loader.getLinkedBridge().bridgeId, 'pending-bridge');

const capture = monitor.captureCompletedAssessment(
    completedSnapshot(),
    '2026-08-03T01:01:01.000Z'
);
assert.equal(capture.written, true);
assert.equal(loader.refreshLinkedBridge().bridgeId, 'pending-bridge');
assert.equal(loader.getLinkedBridge().entryMode, 'pending');
assert.equal(loader.getLinkedBridge().monitorResult.entryMode, 'pending');
assert.equal(loader.getLinkedBridge().monitorResult.assessmentState, 'WAIT_FOR_CONFIRMATION');
assert.equal(uiRefreshes, 1, 'one completed assessment triggers one UI refresh');

const fields = new Map();
const monitorSlot = {};
const panel = {
    innerHTML: '',
    hidden: true,
    classList: {
        add(name) { if (name === 'hidden') panel.hidden = true; },
        remove(name) { if (name === 'hidden') panel.hidden = false; }
    },
    querySelector(selector) {
        if (selector === '[data-bridge-monitor-slot]') return monitorSlot;
        if (selector === '[data-bridge-back]' || selector === '[data-bridge-disconnect]') {
            return { addEventListener() {} };
        }
        if (selector === '[data-bridge-starter-details]') {
            return { classList: { toggle() {} } };
        }
        const match = selector.match(/data-bridge-field="([^"]+)"/);
        if (!match) return null;
        if (!fields.has(match[1])) fields.set(match[1], { textContent: '' });
        return fields.get(match[1]);
    }
};
let monitorRenders = 0;
loader.renderContextPanel(panel, {
    renderMonitor(container) {
        assert.equal(container, monitorSlot, 'monitor renders into the current panel slot');
        monitorRenders += 1;
    }
});
assert.equal(panel.hidden, false);
assert.equal(monitorRenders, 1, 'one context render creates one attached monitor slot');
assert.equal(fields.get('entry-mode').textContent, 'Pending / Intraday Monitoring / 盤中監控');

assert.equal(monitor.transitionLifecycle('COMPLETED', '2026-08-03T01:02:00.000Z'), true);
assert.equal(loader.refreshLinkedBridge().lifecycle.status, 'COMPLETED');
assert.equal(loader.getMode(), 'linked', 'completed context remains linked and visible');
assert.equal(uiRefreshes, 2, 'the lifecycle transition triggers one additional UI refresh');
loader.renderContextPanel(panel, {
    renderMonitor(container) { assert.equal(container, monitorSlot); }
});
assert.equal(panel.hidden, false, 'completed context panel remains visible');
assert.equal(fields.get('entry-mode').textContent, 'Pending / Intraday Monitoring / 盤中監控');

console.log('linked bridge persistence tests passed');
