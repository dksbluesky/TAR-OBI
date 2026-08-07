'use strict';

const assert = require('node:assert/strict');
const modulePath = require.resolve('../bridge-monitor.js');
const STORAGE_KEY = 'etfDca.executionBridge.v1';
const PREFERENCE_KEY = 'tarObi.executionBridge.notificationsEnabled.v1';

function setGlobal(name, value) {
    Object.defineProperty(global, name, {
        value,
        configurable: true,
        writable: true
    });
}

(async () => {
    const bridge = {
        version: '1.0',
        bridgeId: 'android-bridge',
        ticker: '006208',
        createdAt: '2026-08-07T00:30:00.000Z',
        sourceApplication: 'ETF_DCA-plan',
        marketTimeframe: '1d',
        activeZone: { low: 230, high: 235 },
        lifecycle: {
            status: 'ACTIVE',
            updatedAt: '2026-08-07T00:30:00.000Z',
            expiresAt: '2099-08-07T05:30:00.000Z'
        },
        monitorResult: null,
        notificationState: {},
        extensions: {}
    };
    const values = new Map([
        [STORAGE_KEY, JSON.stringify(bridge)],
        [PREFERENCE_KEY, 'false']
    ]);
    setGlobal('localStorage', {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); }
    });
    setGlobal('document', {
        visibilityState: 'visible',
        addEventListener() {}
    });
    setGlobal('addEventListener', () => {});
    setGlobal('Notification', function Notification() {});
    global.Notification.permission = 'default';
    global.Notification.requestPermission = async () => {
        global.Notification.permission = 'granted';
        return 'granted';
    };

    let awake = false;
    let requests = 0;
    let releases = 0;
    const delivered = [];
    setGlobal('TarObiMobileSupport', {
        async prepareNotifications() { return {}; },
        async showNotification(title, options) {
            delivered.push({ title, options });
            return true;
        },
        async requestScreenWakeLock() {
            requests += 1;
            awake = true;
            return true;
        },
        async releaseScreenWakeLock() {
            releases += 1;
            awake = false;
            return true;
        },
        screenWakeLockStatus() {
            return awake ? 'Active' : 'Available';
        }
    });

    delete require.cache[modulePath];
    const monitor = require(modulePath);
    let linked = bridge;
    const bridgeApi = {
        validateBridge(candidate) { return candidate?.bridgeId === bridge.bridgeId; },
        getLinkedBridge() { return linked; },
        refreshLinkedBridge() {
            linked = JSON.parse(values.get(STORAGE_KEY));
            return linked;
        }
    };
    monitor.mount({ bridgeApi });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1, 'active visible monitor requests a wake lock');

    assert.equal(await monitor.enableNotifications(), 'granted');
    assert.equal(values.get(PREFERENCE_KEY), 'true');
    assert.equal(delivered[0].title, 'TAR-OBI Notifications Enabled');

    assert.equal(monitor.transitionLifecycle('PAUSED', '2026-08-07T01:00:00.000Z'), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases, 1, 'pausing the monitor releases the wake lock');

    console.log('bridge mobile support tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
