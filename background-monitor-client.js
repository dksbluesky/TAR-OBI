(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TarObiBackgroundMonitor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const URL_KEY = 'tarObi.backgroundMonitor.url.v1';
    const TOKEN_KEY = 'tarObi.backgroundMonitor.token.v1';

    const storage = () => root.localStorage;
    const read = key => storage()?.getItem(key) || '';
    const cleanUrl = value => String(value || '').trim().replace(/\/+$/, '');
    const configured = () => Boolean(cleanUrl(read(URL_KEY)) && read(TOKEN_KEY));
    const escapeHtml = value => String(value || '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);

    async function request(path, options = {}) {
        const response = await root.fetch(`${cleanUrl(read(URL_KEY))}${path}`, {
            ...options,
            headers: {
                Authorization: `Bearer ${read(TOKEN_KEY)}`,
                'Content-Type': 'application/json',
                ...(options.headers || {})
            },
            cache: 'no-store'
        });
        if (!response.ok) throw new Error(`Background monitor HTTP ${response.status}`);
        return response.status === 204 ? null : response.json();
    }

    async function syncMonitor(bridge) {
        if (!configured()) throw new Error('Background monitor URL and control token are required.');
        const payload = {
            ...bridge,
            settings: {
                entryBasis: read('tarObi.entryAssessment.entryBasis') || 'combined',
                invalidationBasis: read('tarObi.entryAssessment.invalidationBasis') || 'match'
            }
        };
        return request(`/api/monitors/${encodeURIComponent(bridge.bridgeId)}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
    }

    async function setLifecycle(bridgeId, action) {
        if (!configured()) return null;
        return request(`/api/monitors/${encodeURIComponent(bridgeId)}/${action}`, { method: 'POST' });
    }

    async function status(bridgeId) {
        if (!configured()) return null;
        try {
            return await request(`/api/monitors/${encodeURIComponent(bridgeId)}`);
        } catch (error) {
            if (error.message.endsWith('HTTP 404')) return null;
            throw error;
        }
    }

    function render(container, bridge) {
        if (!container || !bridge || !root.document) return;
        const wrapper = root.document.createElement('div');
        wrapper.className = 'mt-4 border-t border-blue-200 pt-4';
        wrapper.innerHTML = `
            <details data-background-monitor-details>
                <summary class="cursor-pointer text-xs font-black tracking-wider text-blue-600">ALWAYS-ON BACKGROUND MONITOR</summary>
                <div class="mt-3 grid gap-2 sm:grid-cols-2">
                    <label class="text-xs text-slate-600">Service URL<input data-background-url class="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5" placeholder="https://your-monitor.example" value="${escapeHtml(cleanUrl(read(URL_KEY)))}"></label>
                    <label class="text-xs text-slate-600 sm:col-span-2">Private control token<input data-background-token type="password" class="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5" value="${escapeHtml(read(TOKEN_KEY))}"></label>
                </div>
                <div class="mt-3 flex flex-wrap items-center gap-2">
                    <button data-background-connect class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white">Connect & Start Telegram Monitor</button>
                    <span data-background-status class="text-xs font-semibold text-slate-600">${configured() ? 'Configured — checking server…' : 'Not configured'}</span>
                </div>
                <p class="mt-2 text-xs text-slate-500">The Mac continues Fugle monitoring and sends meaningful transitions through Telegram after this page closes. It is assessment support only, not a buy signal or order instruction.</p>
            </details>`;
        container.appendChild(wrapper);
        const statusElement = wrapper.querySelector('[data-background-status]');
        const show = (message, error = false) => {
            statusElement.textContent = message;
            statusElement.className = `text-xs font-semibold ${error ? 'text-red-700' : 'text-emerald-700'}`;
        };
        wrapper.querySelector('[data-background-url]').addEventListener('input', event => storage()?.setItem(URL_KEY, cleanUrl(event.target.value)));
        wrapper.querySelector('[data-background-token]').addEventListener('input', event => storage()?.setItem(TOKEN_KEY, event.target.value));
        wrapper.querySelector('[data-background-connect]').addEventListener('click', async () => {
            storage()?.setItem(URL_KEY, cleanUrl(wrapper.querySelector('[data-background-url]').value));
            storage()?.setItem(TOKEN_KEY, wrapper.querySelector('[data-background-token]').value.trim());
            show('Connecting…');
            try {
                await syncMonitor(bridge);
                show('SERVER ACTIVE — Telegram monitoring enabled');
            } catch (error) {
                show(error.message, true);
            }
        });
        if (configured()) {
            syncMonitor(bridge).then(() => status(bridge.bridgeId)).then(remote => {
                show(remote ? `SERVER ${remote.lifecycle?.status || 'CONNECTED'} · ${remote.serverState?.confirmation?.status || 'NONE'}` : 'Configured — monitor not started on server', !remote);
            }).catch(error => show(error.message, true));
        }
    }

    return Object.freeze({ configured, syncMonitor, setLifecycle, status, render });
});
