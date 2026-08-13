'use strict';

const assert = require('node:assert/strict');
const modulePath = require.resolve('../bridge-monitor.js');
const STORAGE_KEY = 'etfDca.executionBridge.v1';
const PREFERENCE_KEY = 'tarObi.executionBridge.notificationsEnabled.v1';

function bridge() {
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
        extensions: {}
    };
}

function renderNotificationCase(permission, preferenceEnabled, supported = true) {
    const values = new Map([
        [STORAGE_KEY, JSON.stringify(bridge())],
        [PREFERENCE_KEY, preferenceEnabled ? 'true' : 'false']
    ]);
    global.localStorage = {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); }
    };
    global.addEventListener = () => {};
    if (supported) {
        global.Notification = function Notification() {};
        global.Notification.permission = permission;
        global.Notification.requestPermission = async () => permission;
    } else {
        delete global.Notification;
    }
    delete require.cache[modulePath];
    const monitor = require(modulePath);
    let linked = bridge();
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
    return { monitor, container, fields };
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
console.log('bridge monitor UI tests passed');
