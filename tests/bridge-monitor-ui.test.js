'use strict';

const assert = require('node:assert/strict');
const modulePath = require.resolve('../bridge-monitor.js');
const STORAGE_KEY = 'etfDca.executionBridge.v1';
const PREFERENCE_KEY = 'tarObi.executionBridge.notificationsEnabled.v1';

function bridge(overrides = {}) {
    return {
        version: '1.0',
        bridgeId: 'ui-bridge',
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
        notificationState: { lastNotifiedState: null, lastNotifiedAt: null },
        extensions: {},
        ...overrides
    };
}

function renderNotificationCase(permission, preferenceEnabled, supported = true, bridgeOverrides = {}) {
    const linkedBridge = bridge(bridgeOverrides);
    const values = new Map([
        [STORAGE_KEY, JSON.stringify(linkedBridge)],
        [PREFERENCE_KEY, preferenceEnabled ? 'true' : 'false']
    ]);
    global.localStorage = {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); }
    };
    global.addEventListener = () => {};
    const notifications = [];
    if (supported) {
        global.Notification = function Notification(title, options) {
            notifications.push({ title, options });
        };
        global.Notification.permission = permission;
        global.Notification.requestPermission = async () => permission;
    } else {
        delete global.Notification;
    }
    delete require.cache[modulePath];
    const monitor = require(modulePath);
    let linked = linkedBridge;
    monitor.mount({
        bridgeApi: {
            validateBridge(candidate) { return candidate?.bridgeId === 'ui-bridge'; },
            getLinkedBridge() { return linked; },
            refreshLinkedBridge() {
                linked = JSON.parse(values.get(STORAGE_KEY));
                return linked;
            }
        }
    });

    const fields = new Map();
    const container = {
        innerHTML: '',
        querySelector(selector) {
            const field = selector.match(/data-monitor-field="([^"]+)"/);
            if (field) {
                if (!fields.has(field[1])) fields.set(field[1], { textContent: '' });
                return fields.get(field[1]);
            }
            if (!this.innerHTML.includes(selector.slice(1, -1))) return null;
            return { addEventListener() {} };
        },
        querySelectorAll() {
            return [];
        }
    };
    monitor.renderControls(container);
    return { monitor, container, fields, notifications };
}

{
    const { monitor, container, fields } = renderNotificationCase('default', false);
    assert.deepEqual(monitor.notificationUiState('default', false), {
        status: 'Disabled',
        label: 'Enable Notifications',
        actionable: true
    });
    assert.match(container.innerHTML, /data-monitor-action="notify"[\s\S]*?>\s*Enable Notifications\s*<\/button>/);
    assert.equal(fields.get('notifications').textContent, 'Disabled');
}

{
    const { container, fields } = renderNotificationCase('granted', true);
    assert.match(container.innerHTML, /disabled[\s\S]*?>\s*Notifications Enabled ✓\s*<\/button>/);
    assert.doesNotMatch(container.innerHTML, /data-monitor-action="notify"/);
    assert.equal(fields.get('notifications').textContent, 'Enabled');
}

{
    const { container, fields } = renderNotificationCase('denied', false);
    assert.match(container.innerHTML, /disabled[\s\S]*?>\s*Notifications Denied\s*<\/button>/);
    assert.doesNotMatch(container.innerHTML, /data-monitor-action="notify"/);
    assert.equal(fields.get('notifications').textContent, 'Denied');
}

{
    const { container, fields } = renderNotificationCase('default', false, false);
    assert.match(container.innerHTML, /disabled[\s\S]*?>\s*Notifications Unsupported\s*<\/button>/);
    assert.doesNotMatch(container.innerHTML, /data-monitor-action="notify"/);
    assert.equal(fields.get('notifications').textContent, 'Unsupported');
}

{
    const { container, fields } = renderNotificationCase('default', false);
    assert.match(container.innerHTML, /Suggested Buy — LIVE requires the existing completed TAR-OBI conditions, a valid bullish ETF_DCA Zone, and uninterrupted validity for the selected duration\. Any failed or stale condition resets the timer\./);
    assert.match(container.innerHTML, /data-monitor-field="entry-confirmation"/);
    assert.match(container.innerHTML, /data-monitor-field="continuous-validity"/);
    assert.match(container.innerHTML, /data-monitor-continuity/);
    assert.equal(fields.get('entry-confirmation').textContent, 'Not pending');
}

{
    const { monitor, container, fields } = renderNotificationCase('default', false);
    const captured = monitor.captureCompletedAssessment({
        complete: true,
        ticker: '006208',
        evaluatedAt: '2026-07-27T02:00:00.000Z',
        currentPrice: 235.5,
        assessment: {
            state: 'DATA UNAVAILABLE',
            factors: ['Fugle quote unavailable'],
            blockingReason: null
        }
    });
    assert.equal(captured.written, true);
    monitor.renderControls(container);
    assert.equal(fields.get('assessment').textContent, 'DATA_UNAVAILABLE');
    assert.equal(
        fields.get('continuous-validity').textContent,
        'Unavailable ' + String.fromCharCode(8212) + ' Fugle quote unavailable'
    );
}
{
    const noZoneBridge = {
        activeZone: null,
        monitorResult: {
            assessmentState: 'ENTRY_CONDITIONS_MET',
            currentPrice: 235.5,
            evaluatedAt: '2026-07-27T02:00:00.000Z'
        },
        notificationState: {
            lastNotifiedState: null,
            lastNotifiedAt: null,
            entryConfirmation: { status: 'CONFIRMED', consecutiveCount: 2, confirmedAt: '2026-07-27T02:00:00.000Z' },
            continuousValidity: { status: 'LIVE', startedAt: '2026-07-27T01:59:00.000Z', durationSeconds: 30, elapsedSeconds: 60, liveAt: '2026-07-27T02:00:00.000Z' }
        },
        extensions: {
            marketContextV1: {
                context: 'range',
                automaticZoneEligible: false,
                invalidationLevel: null
            }
        }
    };
    const { monitor, container, fields, notifications } = renderNotificationCase('granted', true, true, noZoneBridge);
    const expiredLabel = 'EXPIRED — no valid ETF_DCA Active Long Zone';
    assert.equal(fields.get('lifecycle').textContent, 'ACTIVE');
    assert.equal(fields.get('assessment').textContent, 'ENTRY_CONDITIONS_MET');
    assert.equal(fields.get('entry-confirmation').textContent, expiredLabel);
    assert.equal(fields.get('continuous-validity').textContent, expiredLabel);
    assert.match(container.innerHTML, /Raw TAR-OBI Assessment is independent and is not an actionable linked signal while no valid ETF_DCA Active Long Zone is available\./);
    assert.doesNotMatch(fields.get('continuous-validity').textContent, /Suggested Buy — LIVE/);

    const captured = monitor.captureCompletedAssessment({
        complete: true,
        ticker: '006208',
        evaluatedAt: '2026-07-27T02:01:00.000Z',
        currentPrice: 235.5,
        assessment: {
            state: 'ENTRY CONDITIONS MET',
            lower: null,
            upper: null,
            maximum: null,
            invalidation: null,
            wideSpread: false,
            factors: ['Raw TAR-OBI entry conditions met'],
            blockingReason: null
        },
        tarState: 'Buyer Active',
        obiState: 'Bid Dominant',
        vwapState: 'Near VWAP',
        spreadState: 'ACCEPTABLE',
        volumeQuality: 'NORMAL'
    });
    assert.equal(captured.written, true);
    assert.equal(captured.notified, false);
    assert.equal(captured.result.assessmentState, 'ENTRY_CONDITIONS_MET');
    assert.equal(notifications.length, 0);
    monitor.renderControls(container);
    assert.equal(fields.get('lifecycle').textContent, 'ACTIVE');
    assert.equal(fields.get('assessment').textContent, 'ENTRY_CONDITIONS_MET');
    assert.equal(fields.get('entry-confirmation').textContent, expiredLabel);
    assert.equal(fields.get('continuous-validity').textContent, expiredLabel);
}
console.log('bridge monitor UI tests passed');
