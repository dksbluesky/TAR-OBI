'use strict';

const assert = require('node:assert/strict');
const modulePath = require.resolve('../bridge-loader.js');
const STORAGE_KEY = 'etfDca.executionBridge.v1';

function storageFor(bridge) {
    const values = new Map([[STORAGE_KEY, JSON.stringify(bridge)]]);
    return {
        values,
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); }
    };
}

function bridge(overrides = {}) {
    return {
        version: '1.0',
        bridgeId: 'phase3-001',
        ticker: '006208',
        createdAt: '2026-07-27T02:00:00.000Z',
        sourceApplication: 'ETF_DCA-plan',
        marketTimeframe: '1d',
        activeZone: { low: 235.25, high: 235.6 },
        preferredEntry: null,
        maximumEntryPrice: null,
        invalidationLevel: null,
        lifecycle: {
            status: 'ACTIVE',
            updatedAt: '2026-07-27T02:00:00.000Z',
            expiresAt: '2026-07-27T05:30:00.000Z',
            reason: null
        },
        monitorResult: {
            assessmentState: 'WAIT_FOR_CONFIRMATION',
            evaluatedAt: '2026-07-27T02:01:00.000Z'
        },
        notificationState: { lastNotifiedState: null, lastNotifiedAt: null },
        extensions: { future: true },
        ...overrides
    };
}

const storage = storageFor(bridge());
global.localStorage = storage;
delete require.cache[modulePath];
const loader = require(modulePath);

assert.equal(loader.validateBridge(bridge()), true);
assert.equal(loader.initialize().mode, 'linked');

storage.setItem(STORAGE_KEY, JSON.stringify(bridge({
    lifecycle: { ...bridge().lifecycle, status: 'PAUSED' },
    monitorResult: { assessmentState: 'WAIT_FOR_PULLBACK', evaluatedAt: '2026-07-27T02:02:00.000Z' }
})));
assert.equal(loader.refreshLinkedBridge().lifecycle.status, 'PAUSED');
assert.equal(loader.getLinkedBridge().monitorResult.assessmentState, 'WAIT_FOR_PULLBACK');

storage.setItem(STORAGE_KEY, JSON.stringify(bridge({ bridgeId: 'phase3-replacement' })));
assert.equal(loader.refreshLinkedBridge(), null);
assert.equal(loader.getMode(), 'standalone');

console.log('bridge Phase 3 contract tests passed');
