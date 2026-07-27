'use strict';

const assert = require('node:assert/strict');
const modulePath = require.resolve('../bridge-monitor.js');
const STORAGE_KEY = 'etfDca.executionBridge.v1';

function storageWith(bridge) {
    const values = new Map([[STORAGE_KEY, JSON.stringify(bridge)]]);
    return {
        values,
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); }
    };
}

const bridge = {
    version: '1.0',
    bridgeId: 'boundary-001',
    ticker: '006208',
    createdAt: '2026-07-27T02:00:00.000Z',
    sourceApplication: 'ETF_DCA-plan',
    marketTimeframe: '1d',
    activeZone: { low: 235, high: 236 },
    lifecycle: {
        status: 'ACTIVE',
        updatedAt: '2026-07-27T02:00:00.000Z',
        expiresAt: '2099-07-27T05:30:00.000Z'
    },
    monitorResult: null,
    notificationState: {
        lastNotifiedState: null,
        lastNotifiedAt: null,
        futureNotificationField: 'preserve'
    },
    extensions: { future: 'preserve' }
};

const storage = storageWith(bridge);
global.localStorage = storage;
global.addEventListener = () => {};
delete global.Notification;
delete require.cache[modulePath];
const monitor = require(modulePath);
let linked = bridge;
monitor.mount({
    bridgeApi: {
        validateBridge(candidate) {
            return candidate?.version === '1.0' && candidate.bridgeId === 'boundary-001';
        },
        getLinkedBridge() { return linked; },
        refreshLinkedBridge() {
            linked = JSON.parse(storage.getItem(STORAGE_KEY));
            return linked;
        }
    }
});

const incomplete = {
    complete: false,
    ticker: '006208',
    evaluatedAt: '2026-07-27T02:01:00.000Z',
    assessment: { state: 'WAIT FOR CONFIRMATION' }
};
assert.equal(monitor.captureCompletedAssessment(incomplete).reason, 'incomplete-assessment');
assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).monitorResult, null);

function unavailable(time) {
    return {
        complete: true,
        ticker: '006208',
        evaluatedAt: time,
        currentPrice: null,
        assessment: {
            state: 'DATA UNAVAILABLE',
            lower: null,
            upper: null,
            maximum: null,
            invalidation: null,
            factors: ['Data unavailable'],
            blockingReason: 'Market data unavailable'
        },
        tarState: null,
        obiState: null,
        vwapState: null,
        spreadState: null,
        volumeQuality: null
    };
}

monitor.captureCompletedAssessment(unavailable('2026-07-27T02:02:00.000Z'));
monitor.captureCompletedAssessment(unavailable('2026-07-27T02:07:00.000Z'));
let updated = JSON.parse(storage.getItem(STORAGE_KEY));
assert.equal(updated.notificationState.futureNotificationField, 'preserve');
assert.equal(updated.notificationState.dataUnavailableSince, '2026-07-27T02:02:00.000Z');
assert.equal(updated.notificationState.lastDataUnavailableNotifiedAt, '2026-07-27T02:07:00.000Z');
assert.equal(updated.extensions.future, 'preserve');

console.log('bridge monitor completed-boundary tests passed');
