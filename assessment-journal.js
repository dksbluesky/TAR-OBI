(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TarObiAssessmentJournal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const STORAGE_KEY = 'tarObi.assessmentJournal.v1';
    const VERSION = 1;
    const MAX_ENTRIES = 1500;
    const HEARTBEAT_MS = 15 * 60 * 1000;

    function storageGet(key) {
        try { return root.localStorage?.getItem(key) ?? null; } catch (error) { return null; }
    }

    function storageSet(key, value) {
        try { root.localStorage?.setItem(key, value); return true; } catch (error) { return false; }
    }

    function readStore() {
        try {
            const parsed = JSON.parse(storageGet(STORAGE_KEY) || 'null');
            return parsed?.version === VERSION && Array.isArray(parsed.entries)
                ? parsed
                : { version: VERSION, entries: [] };
        } catch (error) {
            return { version: VERSION, entries: [] };
        }
    }

    function meaningfulSignature(entry) {
        return JSON.stringify({
            assessmentState: entry.assessmentState,
            confidence: entry.confidence,
            tarState: entry.tarState,
            obiState: entry.obiState,
            vwapState: entry.vwapState,
            spreadState: entry.spreadState,
            volumeQuality: entry.volumeQuality,
            marketSession: entry.marketSession
        });
    }

    function finiteNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    /**
     * Records one completed linked-monitor assessment without changing the assessment result.
     * Duplicate evaluation timestamps for the same bridge are ignored.
     * @param {object} snapshot Completed raw TAR-OBI assessment snapshot.
     * @param {object} bridge Current linked bridge.
     * @returns {object|null} New journal entry, or null when standalone/incomplete/duplicate.
     */
    function recordCompletedAssessment(snapshot, bridge) {
        if (!snapshot?.complete || !snapshot.evaluatedAt || !bridge?.bridgeId) return null;
        const store = readStore();
        const duplicate = store.entries.some(entry =>
            entry.bridgeId === bridge.bridgeId
            && entry.evaluatedAt === snapshot.evaluatedAt
        );
        if (duplicate) return null;

        const entry = {
            ticker: String(snapshot.ticker || bridge.ticker || '').trim().toUpperCase(),
            bridgeId: bridge.bridgeId,
            recordedAt: new Date().toISOString(),
            evaluatedAt: snapshot.evaluatedAt,
            assessmentState: snapshot.assessment?.state || null,
            confidence: snapshot.assessment?.confidence || null,
            currentPrice: finiteNumber(snapshot.currentPrice),
            preferredEntry: {
                low: finiteNumber(snapshot.preferredEntry?.low),
                high: finiteNumber(snapshot.preferredEntry?.high)
            },
            maximumEntryPrice: finiteNumber(snapshot.maximumEntryPrice),
            invalidationLevel: finiteNumber(snapshot.invalidationLevel),
            tarState: snapshot.tarState || null,
            obiState: snapshot.obiState || null,
            vwapState: snapshot.vwapState || null,
            spreadState: snapshot.spreadState || null,
            volumeQuality: snapshot.volumeQuality || null,
            marketSession: snapshot.marketSession || null,
            setupContext: {
                activeZone: bridge.activeZone || null,
                zoneMode: bridge.zoneMode || null,
                h1H2Status: bridge.h1H2Status || null,
                C1: bridge.C1 || null,
                C2: bridge.C2 || null,
                C3: bridge.C3 || null,
                C4: bridge.C4 || null,
                setupStatus: bridge.setupStatus || null
            }
        };
        const previous = [...store.entries].reverse().find(item => item.bridgeId === bridge.bridgeId) || null;
        if (previous && meaningfulSignature(previous) === meaningfulSignature(entry)) {
            const elapsed = Date.parse(entry.evaluatedAt) - Date.parse(previous.evaluatedAt);
            if (Number.isFinite(elapsed) && elapsed < HEARTBEAT_MS) return null;
        }
        store.entries.push(entry);
        const saved = storageSet(STORAGE_KEY, JSON.stringify({
            version: VERSION,
            entries: store.entries.slice(-MAX_ENTRIES)
        }));
        return saved ? entry : null;
    }

    /**
     * Returns newest completed linked-monitor assessments.
     * @param {object} [options] Optional ticker/bridge/limit filters.
     * @returns {object[]} Newest-first assessment entries.
     */
    function listEntries(options = {}) {
        const ticker = String(options.ticker || '').trim().toUpperCase();
        const bridgeId = String(options.bridgeId || '');
        const limit = Math.max(1, Math.min(100, Number(options.limit) || 10));
        return readStore().entries
            .filter(entry => (!ticker || entry.ticker === ticker) && (!bridgeId || entry.bridgeId === bridgeId))
            .slice(-limit)
            .reverse();
    }

    /**
     * Renders a compact read-only list of completed linked-monitor assessments.
     * @param {HTMLElement} container Target element.
     * @param {object} bridge Current linked bridge.
     * @returns {void}
     */
    function renderPanel(container, bridge) {
        if (!container || !root.document || !bridge?.bridgeId) return;
        const entries = listEntries({ bridgeId: bridge.bridgeId, limit: 5 });
        container.innerHTML = `
            <details class="mt-3 rounded-lg border border-blue-200 bg-white/60 p-3">
                <summary class="cursor-pointer text-xs font-black tracking-wide text-blue-700">AUTOMATIC ASSESSMENT JOURNAL</summary>
                <p class="mt-2 text-xs text-slate-500">Completed raw assessments only. This history does not change TAR-OBI decisions.</p>
                <div data-assessment-journal-list class="mt-2 grid gap-2"></div>
            </details>`;
        const list = container.querySelector('[data-assessment-journal-list]');
        if (!entries.length) {
            list.textContent = 'No completed linked assessments yet.';
            return;
        }
        entries.forEach(entry => {
            const row = root.document.createElement('div');
            row.className = 'border-t border-blue-100 pt-2 text-xs text-slate-700';
            const time = new Date(entry.evaluatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
            row.textContent = `${time} — ${String(entry.assessmentState || 'DATA_UNAVAILABLE').replaceAll('_', ' ')} · Price ${entry.currentPrice ?? 'Unavailable'} · TAR ${entry.tarState || 'Unavailable'} · OBI ${entry.obiState || 'Unavailable'}`;
            list.appendChild(row);
        });
    }

    return Object.freeze({
        STORAGE_KEY,
        VERSION,
        HEARTBEAT_MS,
        recordCompletedAssessment,
        listEntries,
        renderPanel
    });
});
