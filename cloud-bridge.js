(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TarObiCloudBridge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const URL_KEY = 'tarObi.cloudBridge.url.v1';
    const DEFAULT_URL = 'https://tar-obi-bridge-sync.dk0986.workers.dev';
    const KEY_KEY = 'tarObi.cloudBridge.pairingKey.v1';
    const ENABLED_KEY = 'tarObi.cloudBridge.enabled.v1';
    const DISMISSED_KEY = 'tarObi.executionBridge.dismissedBridgeId.v1';
    let lastSentMs = 0;
    let polling = false;
    let statusElement = null;
    let settingsStatus = null;
    let onUpdated = null;
    let lastStatus = 'Cloud Sync off';
    let verifiedBridgeId = null;

    function isIOS() {
        const navigatorInfo = root.navigator || {};
        return /iPhone|iPad|iPod/i.test(navigatorInfo.userAgent || '')
            || (/Macintosh/i.test(navigatorInfo.userAgent || '') && Number(navigatorInfo.maxTouchPoints) > 1);
    }
    function cleanUrl(value) {
        const url = String(value || '').trim().replace(/\/+$/, '');
        try { return new URL(url).protocol === 'https:' ? url : ''; } catch (_error) { return ''; }
    }
    function pairingKey() { return root.localStorage?.getItem(KEY_KEY) || ''; }
    function enabled() {
        return root.localStorage?.getItem(ENABLED_KEY) === 'true'
            && Boolean(cleanUrl(root.localStorage?.getItem(URL_KEY) || DEFAULT_URL))
            && /^[A-Za-z0-9_-]{43}$/.test(pairingKey());
    }
    function isVerified(bridgeId) { return enabled() && verifiedBridgeId === bridgeId; }
    function status(message, error = false) {
        lastStatus = message;
        if (settingsStatus) settingsStatus.textContent = message;
        if (statusElement) {
            statusElement.hidden = !enabled();
            statusElement.textContent = message;
            statusElement.style.color = error ? '#b91c1c' : '#475569';
        }
    }
    function nextSentAt() {
        lastSentMs = Math.max(Date.now(), lastSentMs + 1);
        return new Date(lastSentMs).toISOString();
    }
    async function request(path, method = 'GET', body) {
        const controller = new AbortController();
        const timeout = root.setTimeout(() => controller.abort(), 7000);
        let response;
        try {
            response = await root.fetch(`${cleanUrl(root.localStorage.getItem(URL_KEY) || DEFAULT_URL)}${path}`, {
                method, cache: 'no-store', signal: controller.signal, headers: {
                    Authorization: `Bearer ${pairingKey()}`,
                    ...(body ? { 'Content-Type': 'application/json' } : {})
                }, ...(body ? { body: JSON.stringify(body) } : {})
            });
        } finally { root.clearTimeout(timeout); }
        if (!response.ok) throw new Error(`Cloud HTTP ${response.status}`);
        return response.json();
    }
    function moreRecent(left, right) {
        return (Date.parse(left || '') || 0) > (Date.parse(right || '') || 0);
    }
    function keepLocalLifecycle(local, cloud) {
        if (!local) return false;
        if (!cloud) return true;
        const terminal = ['COMPLETED', 'EXPIRED', 'INVALIDATED'];
        if (terminal.includes(local.status) !== terminal.includes(cloud.status)) {
            return terminal.includes(local.status);
        }
        return moreRecent(local.updatedAt, cloud.updatedAt);
    }
    async function pull() {
        if (!enabled()) return false;
        try {
            const remote = (await request('/v1/bridge')).bridge;
            if (!root.TarObiBridge?.validateBridge?.(remote)) throw new Error('Invalid cloud Bridge');
            const current = root.TarObiBridge.readBridge();
            if (root.localStorage.getItem(DISMISSED_KEY) === remote.bridgeId) {
                status('Cloud Bridge is locally disconnected; no change made');
                return false;
            }
            if (!current || current.bridgeId !== remote.bridgeId) {
                if (current && !moreRecent(remote.createdAt, current.createdAt)) {
                    status('Cloud Bridge is older than this app; local Bridge kept', true);
                    return false;
                }
                root.TarObiBridge.linkBridge(remote);
                verifiedBridgeId = remote.bridgeId;
                status(`New cloud Bridge linked · ${remote.ticker} · ${new Date().toLocaleString()}`);
                root.location?.reload?.();
                return true;
            }
            const merged = { ...remote, notificationState: current.notificationState || remote.notificationState };
            if (moreRecent(current.monitorResult?.evaluatedAt, remote.monitorResult?.evaluatedAt)) {
                merged.monitorResult = current.monitorResult;
            }
            if (keepLocalLifecycle(current.lifecycle, remote.lifecycle)) {
                merged.lifecycle = current.lifecycle;
            }
            const firstVerified = verifiedBridgeId !== remote.bridgeId;
            verifiedBridgeId = remote.bridgeId;
            if (JSON.stringify(current) !== JSON.stringify(merged)) {
                root.TarObiBridge.linkBridge(merged);
                onUpdated?.(merged);
            } else if (firstVerified) {
                onUpdated?.(merged);
            }
            status(`Cloud checked · ${remote.ticker} · ${new Date().toLocaleString()}`);
            return true;
        } catch (error) {
            verifiedBridgeId = null;
            status(error.message === 'Cloud HTTP 404' ? 'Cloud Sync ready; no monitor has been published yet.'
                : `Cloud unavailable: ${error.message}; local Bridge may be older`, error.message !== 'Cloud HTTP 404');
            return false;
        }
    }
    async function publishResult(bridge) {
        if (!enabled() || !bridge?.bridgeId || (!bridge.monitorResult && !bridge.lifecycle)) return false;
        try {
            await request('/v1/result', 'PUT', { bridge, sentAt: nextSentAt() });
            status(`Assessment synced · ${bridge.ticker} · ${new Date().toLocaleString()}`);
            return true;
        } catch (error) {
            status(`Cloud assessment not synced: ${error.message}; local assessment kept`, true);
            return false;
        }
    }
    function start(options = {}) {
        if (options.statusElement) statusElement = options.statusElement;
        if (options.onUpdated) onUpdated = options.onUpdated;
        status(lastStatus);
        if (!enabled()) return;
        if (polling) { void pull(); return; }
        polling = true;
        root.setInterval?.(() => { if (!root.document?.hidden) void pull(); }, 30000);
        root.document?.addEventListener?.('visibilitychange', () => {
            if (!root.document.hidden) void pull();
        });
        root.addEventListener?.('focus', () => void pull());
        void pull();
    }
    function mountSettings(container) {
        if (!container || !root.document || !isIOS()) return;
        const panel = root.document.createElement('div');
        panel.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px solid #dce5ef;font-size:12px';
        panel.innerHTML = '<strong>iPhone Cloud Bridge Sync</strong>'
            + '<p style="color:#64748b;margin:6px 0">Optional. Existing local monitoring stays available.</p>'
            + '<label>Cloud Worker URL <input data-cloud-url type="url" placeholder="https://...workers.dev" autocomplete="off" style="width:100%;margin:5px 0;padding:7px"></label>'
            + '<label>Pairing key from ETF_DCA <input data-cloud-key type="password" autocomplete="off" style="width:100%;margin:5px 0;padding:7px"></label>'
            + '<label><input data-cloud-enable type="checkbox" style="width:auto;min-height:0"> Enable Cloud Sync on this device</label>'
            + '<p data-cloud-status role="status" style="color:#64748b;margin:7px 0"></p>';
        container.appendChild(panel);
        const urlInput = panel.querySelector('[data-cloud-url]');
        const keyInput = panel.querySelector('[data-cloud-key]');
        const enableInput = panel.querySelector('[data-cloud-enable]');
        settingsStatus = panel.querySelector('[data-cloud-status]');
        urlInput.value = root.localStorage?.getItem(URL_KEY) || DEFAULT_URL;
        keyInput.value = pairingKey();
        enableInput.checked = root.localStorage?.getItem(ENABLED_KEY) === 'true';
        status(lastStatus);
        const save = () => {
            root.localStorage.setItem(URL_KEY, urlInput.value.trim());
            root.localStorage.setItem(KEY_KEY, keyInput.value.trim());
            root.localStorage.setItem(ENABLED_KEY, String(enableInput.checked));
            if (enableInput.checked && !enabled()) status('Enter a valid HTTPS URL and pairing key.', true);
            else if (enabled()) { status('Cloud Sync enabled on this device.'); start(); }
            else status('Cloud Sync off');
        };
        urlInput.addEventListener('change', save);
        keyInput.addEventListener('change', save);
        enableInput.addEventListener('change', save);
    }
    return Object.freeze({ URL_KEY, KEY_KEY, ENABLED_KEY, enabled, isVerified, pull, publishResult, start, mountSettings });
});
