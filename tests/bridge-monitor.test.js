'use strict';

const assert = require('node:assert/strict');
const modulePath = require.resolve('../bridge-monitor.js');
const STORAGE_KEY = 'etfDca.executionBridge.v1';
const PREFERENCE_KEY = 'tarObi.executionBridge.notificationsEnabled.v1';

function createStorage(entries = {}) {
    const values = new Map(Object.entries(entries));
    return {
        values,
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); }
    };
}

function validBridge(overrides = {}) {
    return {
        version: '1.0',
        bridgeId: 'bridge-001',
        ticker: '006208',
        createdAt: '2026-07-27T02:00:00.000Z',
        sourceApplication: 'ETF_DCA-plan',
        marketTimeframe: '1d',
        marketLevelTimeframe: '60m',
        zoneMode: 'aggressive',
        activeZone: { low: 235.25, high: 235.6 },
        setupStatus: { label: 'Ready' },
        lifecycle: {
            status: 'ACTIVE',
            updatedAt: '2026-07-27T02:00:00.000Z',
            expiresAt: '2099-07-27T05:30:00.000Z',
            reason: null
        },
        monitorResult: null,
        notificationState: { lastNotifiedState: null, lastNotifiedAt: null },
        extensions: { futureField: { preserved: true } },
        unknownTopLevel: 'preserve-me',
        ...overrides
    };
}

function validSnapshot(overrides = {}) {
    return {
        complete: true,
        ticker: '006208',
        evaluatedAt: '2026-07-27T02:10:00.000Z',
        currentPrice: 235.5,
        assessment: {
            state: 'WAIT FOR CONFIRMATION',
            lower: 235.25,
            upper: 235.6,
            maximum: 235.65,
            invalidation: 234.8,
            wideSpread: false,
            factors: ['Waiting for confirmation'],
            blockingReason: null
        },
        tarState: 'Buyer Active',
        obiState: 'Bid Dominant',
        vwapState: 'Near VWAP',
        spreadState: 'ACCEPTABLE',
        volumeQuality: 'NORMAL',
        ...overrides
    };
}

function loadMonitor(bridge, options = {}) {
    const storage = createStorage({
        [STORAGE_KEY]: JSON.stringify(bridge),
        [PREFERENCE_KEY]: options.notificationsEnabled ? 'true' : 'false'
    });
    const notifications = [];
    global.localStorage = storage;
    global.addEventListener = () => {};
    if (options.notificationsEnabled) {
        global.Notification = function Notification(title, notificationOptions) {
            notifications.push({ title, options: notificationOptions });
        };
        global.Notification.permission = 'granted';
    } else {
        delete global.Notification;
    }
    delete require.cache[modulePath];
    const monitor = require(modulePath);
    let linked = bridge;
    const bridgeApi = {
        validateBridge(candidate) {
            return candidate?.version === '1.0' && Boolean(candidate.bridgeId && candidate.ticker);
        },
        getLinkedBridge() { return linked; },
        refreshLinkedBridge() {
            const next = JSON.parse(storage.getItem(STORAGE_KEY));
            linked = next.bridgeId === linked.bridgeId ? next : null;
            return linked;
        }
    };
    monitor.mount({ bridgeApi, alertContainer: options.alertContainer });
    return { monitor, storage, bridgeApi, notifications };
}

function stored(storage) {
    return JSON.parse(storage.getItem(STORAGE_KEY));
}

{
    const bridge = validBridge();
    const { monitor, storage } = loadMonitor(bridge);
    const result = monitor.captureCompletedAssessment(validSnapshot(), '2026-07-27T02:10:01.000Z');
    assert.equal(result.written, true);
    assert.equal(result.notified, false);
    const updated = stored(storage);
    assert.equal(updated.activeZone.low, 235.25);
    assert.deepEqual(updated.extensions.futureField, { preserved: true });
    assert.equal(updated.unknownTopLevel, 'preserve-me');
    assert.equal(updated.monitorResult.assessmentState, 'WAIT_FOR_CONFIRMATION');
    assert.equal(updated.monitorResult.previousAssessmentState, null);
    assert.equal(updated.monitorResult.currentPrice, 235.5);
}

{
    const { monitor, storage } = loadMonitor(validBridge());
    storage.setItem(STORAGE_KEY, JSON.stringify(validBridge({ bridgeId: 'bridge-new' })));
    assert.equal(monitor.captureCompletedAssessment(validSnapshot()).reason, 'bridge-replaced');
    assert.equal(stored(storage).bridgeId, 'bridge-new');
}

{
    const { monitor, storage } = loadMonitor(validBridge());
    assert.equal(monitor.captureCompletedAssessment(validSnapshot({ ticker: '0050' })).reason, 'ticker-mismatch');
    assert.equal(stored(storage).monitorResult, null);
}

for (const status of ['PAUSED', 'COMPLETED', 'INVALIDATED']) {
    const { monitor, storage } = loadMonitor(validBridge({
        lifecycle: { ...validBridge().lifecycle, status }
    }));
    assert.equal(monitor.captureCompletedAssessment(validSnapshot()).written, false);
    assert.equal(stored(storage).monitorResult, null);
}

{
    const { monitor, storage } = loadMonitor(validBridge({
        lifecycle: { ...validBridge().lifecycle, expiresAt: '2026-07-27T02:05:00.000Z' }
    }));
    const result = monitor.captureCompletedAssessment(validSnapshot(), '2026-07-27T02:10:00.000Z');
    assert.equal(result.reason, 'expired');
    assert.equal(stored(storage).lifecycle.status, 'EXPIRED');
    assert.equal(stored(storage).monitorResult, null);
}

{
    const existing = validSnapshot();
    const bridge = validBridge({
        monitorResult: {
            ...existing,
            assessmentState: 'WAIT_FOR_CONFIRMATION',
            evaluatedAt: '2026-07-27T02:20:00.000Z'
        }
    });
    const { monitor, storage } = loadMonitor(bridge);
    assert.equal(monitor.captureCompletedAssessment(validSnapshot()).reason, 'stale-assessment');
    assert.equal(stored(storage).monitorResult.evaluatedAt, '2026-07-27T02:20:00.000Z');
}

{
    const { monitor } = loadMonitor(validBridge());
    let confirmation = monitor.advanceEntryConfirmation(null, 'WAIT_FOR_CONFIRMATION', '2026-07-27T02:01:00.000Z');
    assert.deepEqual(confirmation, { status: 'NONE', consecutiveCount: 0, confirmedAt: null });
    confirmation = monitor.advanceEntryConfirmation(confirmation, 'ENTRY_CONDITIONS_MET', '2026-07-27T02:02:00.000Z');
    assert.deepEqual(confirmation, { status: 'PENDING', consecutiveCount: 1, confirmedAt: null });
    confirmation = monitor.advanceEntryConfirmation(confirmation, 'ENTRY_CONDITIONS_MET', '2026-07-27T02:03:00.000Z');
    assert.deepEqual(confirmation, {
        status: 'CONFIRMED',
        consecutiveCount: 2,
        confirmedAt: '2026-07-27T02:03:00.000Z'
    });
    confirmation = monitor.advanceEntryConfirmation(confirmation, 'WAIT_FOR_PULLBACK', '2026-07-27T02:04:00.000Z');
    assert.deepEqual(confirmation, { status: 'NONE', consecutiveCount: 0, confirmedAt: null });
}

{
    const evaluatedAt = '2026-07-27T02:01:00.000Z';
    const legacyEntryResult = {
        assessmentState: 'ENTRY_CONDITIONS_MET',
        evaluatedAt,
        currentPrice: 235.5
    };
    const { storage } = loadMonitor(validBridge({
        monitorResult: legacyEntryResult,
        notificationState: {
            lastNotifiedState: 'ENTRY_CONDITIONS_MET',
            lastNotifiedAt: evaluatedAt
        }
    }));
    assert.deepEqual(stored(storage).notificationState.entryConfirmation, {
        status: 'CONFIRMED',
        consecutiveCount: 2,
        confirmedAt: evaluatedAt
    });
}

{
    const { storage } = loadMonitor(validBridge({
        monitorResult: { assessmentState: 'ENTRY_CONDITIONS_MET', evaluatedAt: '2026-07-27T02:01:00.000Z' }
    }));
    assert.equal(stored(storage).notificationState.entryConfirmation.status, 'PENDING');
    assert.equal(stored(storage).notificationState.entryConfirmation.consecutiveCount, 1);
}

{
    const { monitor, storage } = loadMonitor(validBridge());
    const wait = validSnapshot({ evaluatedAt: '2026-07-27T02:01:00.000Z' });
    assert.equal(monitor.captureCompletedAssessment(wait).notified, false);
    const entry = time => validSnapshot({
        evaluatedAt: time,
        assessment: { ...wait.assessment, state: 'ENTRY CONDITIONS MET', factors: ['Entry conditions met'] }
    });
    const firstEntry = monitor.captureCompletedAssessment(entry('2026-07-27T02:02:00.000Z'));
    assert.equal(firstEntry.notified, false);
    assert.equal(firstEntry.confirmed, false);
    assert.deepEqual(firstEntry.confirmation, { status: 'PENDING', consecutiveCount: 1, confirmedAt: null });
    assert.equal(stored(storage).notificationState.lastNotifiedAt, null);

    assert.equal(monitor.captureCompletedAssessment(entry('2026-07-27T02:02:00.000Z')).reason, 'stale-assessment');
    assert.equal(stored(storage).notificationState.entryConfirmation.consecutiveCount, 1);
    assert.equal(monitor.captureCompletedAssessment({ ...entry('2026-07-27T02:02:30.000Z'), complete: false }).reason, 'incomplete-assessment');
    assert.equal(stored(storage).notificationState.entryConfirmation.consecutiveCount, 1);

    const confirmed = monitor.captureCompletedAssessment(entry('2026-07-27T02:03:00.000Z'));
    assert.equal(confirmed.notified, true);
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.confirmation.status, 'CONFIRMED');
    assert.equal(monitor.captureCompletedAssessment(entry('2026-07-27T02:04:00.000Z')).notified, false);

    assert.equal(monitor.captureCompletedAssessment(validSnapshot({ evaluatedAt: '2026-07-27T02:05:00.000Z' })).notified, false);
    assert.equal(stored(storage).notificationState.entryConfirmation.status, 'NONE');
    assert.equal(monitor.captureCompletedAssessment(entry('2026-07-27T02:06:00.000Z')).notified, false);
    assert.equal(stored(storage).notificationState.entryConfirmation.status, 'PENDING');
    assert.equal(monitor.captureCompletedAssessment(entry('2026-07-27T02:07:00.000Z')).notified, false);
    assert.equal(stored(storage).notificationState.entryConfirmation.status, 'CONFIRMED');

    assert.equal(monitor.captureCompletedAssessment(validSnapshot({ evaluatedAt: '2026-07-27T02:13:01.000Z' })).notified, false);
    assert.equal(monitor.captureCompletedAssessment(entry('2026-07-27T02:13:02.000Z')).notified, false);
    assert.equal(monitor.captureCompletedAssessment(entry('2026-07-27T02:13:03.000Z')).notified, true);
    assert.equal(stored(storage).notificationState.lastNotifiedState, 'ENTRY_CONDITIONS_MET');
}

{
    const alertFields = new Map();
    const fieldFor = selector => {
        if (!alertFields.has(selector)) {
            alertFields.set(selector, { textContent: '', innerHTML: '', addEventListener() {} });
        }
        return alertFields.get(selector);
    };
    const detailsContainer = {
        innerHTML: '',
        querySelector(selector) {
            return fieldFor(selector);
        }
    };
    const alertContainer = {
        innerHTML: '',
        classList: { add() {}, remove() {} },
        querySelector(selector) {
            return selector === '[data-monitor-alert-details]' ? detailsContainer : fieldFor(selector);
        }
    };
    const { monitor, notifications } = loadMonitor(validBridge(), {
        notificationsEnabled: true,
        alertContainer
    });
    const entry = time => validSnapshot({
        evaluatedAt: time,
        assessment: { ...validSnapshot().assessment, state: 'ENTRY CONDITIONS MET' }
    });
    assert.equal(monitor.captureCompletedAssessment(entry('2026-07-27T02:01:00.000Z')).notified, false);
    assert.equal(notifications.length, 0);
    assert.equal(alertContainer.innerHTML, '');
    assert.equal(monitor.captureCompletedAssessment(entry('2026-07-27T02:02:00.000Z')).notified, true);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].title, /Entry Conditions Met/);
    assert.equal(alertFields.get('[data-monitor-alert-title]').textContent, '006208 — ENTRY CONDITIONS CONFIRMED');
    assert.equal(
        alertFields.get('[data-monitor-alert-message]').textContent,
        'Entry conditions were confirmed across 2 consecutive assessments.'
    );
    const detailLines = [...alertFields.entries()]
        .filter(([selector]) => selector.startsWith('[data-monitor-alert-detail-line='))
        .map(([, field]) => field.textContent);
    assert.deepEqual(detailLines.slice(0, 6), [
        'Current Price: 235.50',
        'Preferred Entry: 235.25–235.60',
        'TAR: Buyer Active',
        'OBI: Bid Dominant',
        'VWAP: Near VWAP',
        'Confirmation: 2/2 consecutive assessments'
    ]);
    assert.match(detailLines[6], /^Evaluated: /);
    assert.doesNotMatch(alertFields.get('[data-monitor-alert-title]').textContent, /ENTRY_CONDITIONS_MET/);
}

{
    const { monitor, storage } = loadMonitor(validBridge());
    assert.equal(monitor.transitionLifecycle('PAUSED', '2026-07-27T02:03:00.000Z'), true);
    assert.equal(stored(storage).lifecycle.status, 'PAUSED');
    assert.equal(monitor.transitionLifecycle('ACTIVE', '2026-07-27T02:04:00.000Z'), true);
    assert.equal(stored(storage).lifecycle.status, 'ACTIVE');
    assert.equal(monitor.transitionLifecycle('COMPLETED', '2026-07-27T02:05:00.000Z'), true);
    assert.equal(stored(storage).lifecycle.status, 'COMPLETED');
    assert.equal(stored(storage).lifecycle.completedAt, '2026-07-27T02:05:00.000Z');
}

{
    const { monitor } = loadMonitor(validBridge());
    assert.equal(monitor.calculateExpiresAt('2026-07-24T06:00:00.000Z'), '2026-07-27T05:30:00.000Z');
}

console.log('bridge monitor tests passed');
