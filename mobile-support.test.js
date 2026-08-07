'use strict';

const assert = require('node:assert/strict');
const modulePath = require.resolve('../mobile-support.js');

function setGlobal(name, value) {
    Object.defineProperty(global, name, {
        value,
        configurable: true,
        writable: true
    });
}

function loadSupport() {
    delete global.TarObiMobileSupport;
    delete require.cache[modulePath];
    return require(modulePath);
}

(async () => {
    {
        const delivered = [];
        const registration = {
            async showNotification(title, options) {
                delivered.push({ title, options });
            }
        };
        let registeredUrl = null;
        setGlobal('navigator', {
            serviceWorker: {
                async register(url) {
                    registeredUrl = url;
                    return registration;
                },
                ready: Promise.resolve(registration)
            }
        });
        setGlobal('Notification', function Notification() {
            throw new Error('legacy constructor must not run');
        });
        global.Notification.permission = 'granted';
        const support = loadSupport();
        assert.equal(await support.showNotification('Android test', { tag: 'test' }), true);
        assert.equal(registeredUrl, './notification-service-worker.js');
        assert.deepEqual(delivered, [{ title: 'Android test', options: { tag: 'test' } }]);
    }

    {
        const delivered = [];
        setGlobal('navigator', {});
        setGlobal('Notification', function Notification(title, options) {
            delivered.push({ title, options });
        });
        global.Notification.permission = 'granted';
        const support = loadSupport();
        assert.equal(await support.showNotification('Desktop test', { body: 'ready' }), true);
        assert.equal(delivered.length, 1);
    }

    {
        let released = false;
        let releaseHandler = null;
        const sentinel = {
            released: false,
            addEventListener(type, handler) {
                if (type === 'release') releaseHandler = handler;
            },
            async release() {
                this.released = true;
                released = true;
                releaseHandler?.();
            }
        };
        setGlobal('document', { visibilityState: 'visible' });
        setGlobal('navigator', {
            wakeLock: {
                async request(type) {
                    assert.equal(type, 'screen');
                    return sentinel;
                }
            }
        });
        delete global.Notification;
        const support = loadSupport();
        assert.equal(await support.requestScreenWakeLock(), true);
        assert.equal(support.screenWakeLockStatus(), 'Active');
        assert.equal(await support.releaseScreenWakeLock(), true);
        assert.equal(released, true);
        assert.equal(support.screenWakeLockStatus(), 'Available');
    }

    {
        let requests = 0;
        setGlobal('document', { visibilityState: 'hidden' });
        setGlobal('navigator', {
            wakeLock: { async request() { requests += 1; } }
        });
        const support = loadSupport();
        assert.equal(await support.requestScreenWakeLock(), false);
        assert.equal(requests, 0);
    }

    console.log('mobile support tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
