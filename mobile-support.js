(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TarObiMobileSupport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const SERVICE_WORKER_URL = './notification-service-worker.js';
    let serviceWorkerRegistration = null;
    let serviceWorkerRequest = null;
    let wakeLockSentinel = null;
    let wakeLockRequest = null;

    /**
     * Registers the notification service worker when the browser supports it.
     * Registration failure is isolated from monitoring and assessment behavior.
     * @returns {Promise<object|null>} Active registration, or null when unavailable.
     */
    async function prepareNotifications() {
        if (serviceWorkerRegistration) return serviceWorkerRegistration;
        if (serviceWorkerRequest) return serviceWorkerRequest;

        const serviceWorker = root.navigator?.serviceWorker;
        if (!serviceWorker || typeof serviceWorker.register !== 'function') return null;

        serviceWorkerRequest = Promise.resolve()
            .then(() => serviceWorker.register(SERVICE_WORKER_URL))
            .then(async registration => {
                if (serviceWorker.ready) {
                    try {
                        serviceWorkerRegistration = await serviceWorker.ready;
                    } catch (error) {
                        serviceWorkerRegistration = registration || null;
                    }
                } else {
                    serviceWorkerRegistration = registration || null;
                }

                return serviceWorkerRegistration;
            })
            .catch(() => null)
            .finally(() => {
                serviceWorkerRequest = null;
            });

        return serviceWorkerRequest;
    }

    /**
     * Displays a browser notification using the Android-compatible service-worker
     * path first, with the existing desktop constructor retained as a fallback.
     * @param {string} title Notification title.
     * @param {object} [options] Standard Notification options.
     * @returns {Promise<boolean>} Whether a notification request was delivered.
     */
    async function showNotification(title, options = {}) {
        if (root.Notification?.permission !== 'granted') return false;

        const registration = await prepareNotifications();
        if (typeof registration?.showNotification === 'function') {
            try {
                await registration.showNotification(title, options);
                return true;
            } catch (error) {
                // Fall through to the desktop-compatible constructor.
            }
        }

        try {
            if (typeof root.Notification !== 'function') return false;
            new root.Notification(title, options);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Requests a screen wake lock while the linked monitor page is visible.
     * @returns {Promise<boolean>} Whether the screen wake lock is currently held.
     */
    async function requestScreenWakeLock() {
        if (wakeLockSentinel && !wakeLockSentinel.released) return true;
        if (wakeLockRequest) return wakeLockRequest;
        if (root.document?.visibilityState === 'hidden') return false;

        const wakeLock = root.navigator?.wakeLock;
        if (!wakeLock || typeof wakeLock.request !== 'function') return false;

        wakeLockRequest = Promise.resolve()
            .then(() => wakeLock.request('screen'))
            .then(sentinel => {
                wakeLockSentinel = sentinel || null;
                wakeLockSentinel?.addEventListener?.('release', () => {
                    wakeLockSentinel = null;
                }, { once: true });
                return Boolean(wakeLockSentinel && !wakeLockSentinel.released);
            })
            .catch(() => false)
            .finally(() => {
                wakeLockRequest = null;
            });

        return wakeLockRequest;
    }

    /**
     * Releases the current screen wake lock without affecting monitor lifecycle.
     * @returns {Promise<boolean>} Whether no active wake lock remains.
     */
    async function releaseScreenWakeLock() {
        const sentinel = wakeLockSentinel;
        wakeLockSentinel = null;
        if (!sentinel || sentinel.released) return true;

        try {
            await sentinel.release();
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Returns a read-only screen wake-lock status for the Linked Monitor UI.
     * @returns {'Active'|'Available'|'Unsupported'} Current capability/status.
     */
    function screenWakeLockStatus() {
        if (wakeLockSentinel && !wakeLockSentinel.released) return 'Active';
        return typeof root.navigator?.wakeLock?.request === 'function'
            ? 'Available'
            : 'Unsupported';
    }

    return Object.freeze({
        SERVICE_WORKER_URL,
        prepareNotifications,
        showNotification,
        requestScreenWakeLock,
        releaseScreenWakeLock,
        screenWakeLockStatus
    });
});
