(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TarObiBridge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const STORAGE_KEY = 'etfDca.executionBridge.v1';
    const DISMISSED_KEY = 'tarObi.executionBridge.dismissedBridgeId.v1';
    const CONTRACT_VERSION = '1.0';
    const ETF_DCA_URL = 'https://dksbluesky.github.io/ETF_DCA-plan/';
    const SOURCE_APPLICATION = 'ETF_DCA-plan';
    const MODE_STANDALONE = 'standalone';
    const MODE_LINKED = 'linked';

    let initialized = false;
    let linkedBridge = null;

    function storageGet(key) {
        try {
            return root.localStorage?.getItem(key) ?? null;
        } catch (error) {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            root.localStorage?.setItem(key, value);
        } catch (error) {
            // Storage failure must never prevent standalone TAR-OBI operation.
        }
    }

    function nonEmptyString(value) {
        return typeof value === 'string' && value.trim().length > 0;
    }

    function validOptionalNumber(value) {
        return value === null || value === undefined || Number.isFinite(Number(value));
    }

    function validActiveZone(activeZone) {
        if (activeZone === null || activeZone === undefined) return true;
        if (typeof activeZone !== 'object') return false;

        const low = Number(activeZone.low);
        const high = Number(activeZone.high);

        return Number.isFinite(low)
            && Number.isFinite(high)
            && low <= high;
    }

    function validEntryMode(value) {
        return value === undefined
            || value === null
            || value === 'confirmed'
            || value === 'left_side_starter';
    }

    function validOptionalBoolean(value) {
        return value === undefined
            || value === null
            || typeof value === 'boolean';
    }

    function validStarterAllocation(value) {
        if (value === undefined || value === null) return true;

        const number = Number(value);

        return Number.isFinite(number)
            && number >= 0
            && number <= 100;
    }

    function validStarterRisk(value) {
        return value === undefined
            || value === null
            || typeof value === 'object';
    }

    function modeSnapshot() {
        return Object.freeze({
            mode: linkedBridge ? MODE_LINKED : MODE_STANDALONE,
            bridge: linkedBridge
        });
    }

    function displayValue(value, fallback = 'Unavailable') {
        return nonEmptyString(value)
            ? value.trim()
            : fallback;
    }

    function displayCondition(condition) {
        if (condition === null || condition === undefined) {
            return 'Unavailable';
        }

        if (typeof condition === 'boolean') {
            return condition ? '✓' : 'Pending';
        }

        if (condition.met === true) return '✓';
        if (condition.met === false) return 'Pending';

        return displayValue(condition.status);
    }

    function displaySetupStatus(setupStatus) {
        if (nonEmptyString(setupStatus)) {
            return setupStatus.trim();
        }

        return displayValue(setupStatus?.label);
    }

    function displayZone(activeZone) {
        if (!validActiveZone(activeZone) || !activeZone) {
            return 'Unavailable';
        }

        return `${Number(activeZone.low).toLocaleString()} ~ ${Number(activeZone.high).toLocaleString()}`;
    }

    function displayC4(c4) {
        if (!c4) return 'Unavailable';

        return displayValue(
            c4.classification,
            c4.confirmed === true ? 'Qualified' : 'Pending'
        );
    }

    function displayEntryMode(entryMode) {
        return entryMode === 'left_side_starter'
            ? 'Left-Side Starter / 左側第一筆'
            : 'Confirmed / Right-Side / 右側確認';
    }

    function displayStarterStatus(bridge) {
        if (bridge?.starterExecuted === true) {
            return 'Executed / 已執行';
        }

        if (bridge?.starterEligible === true) {
            return 'Eligible / 可評估';
        }

        return 'Not Eligible / 不符合';
    }

    function displayStarterAllocation(value) {
        const number = Number(value);

        return Number.isFinite(number)
            ? `${number}%`
            : 'Unavailable';
    }

    function displayStarterRisk(risk) {
        if (!risk || typeof risk !== 'object') {
            return 'Unavailable';
        }

        const level = displayValue(risk.level);
        const reasons = Array.isArray(risk.reasons)
            ? risk.reasons.filter(Boolean)
            : [];

        return reasons.length
            ? `${level} — ${reasons.join('; ')}`
            : level;
    }

    function isMobileOrTablet() {
        const navigatorInfo = root.navigator || {};
        const userAgent = String(navigatorInfo.userAgent || '');

        return navigatorInfo.userAgentData?.mobile === true
            || /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle/i.test(userAgent)
            || (
                /Macintosh/i.test(userAgent)
                && Number(navigatorInfo.maxTouchPoints) > 1
            );
    }

    function hasSafeEtfHistory() {
        if (!root.history || Number(root.history.length) <= 1) {
            return false;
        }

        try {
            const referrer = new URL(
                String(root.document?.referrer || '')
            );

            const etfUrl = new URL(ETF_DCA_URL);

            return referrer.origin === etfUrl.origin
                && referrer.pathname.startsWith(etfUrl.pathname);
        } catch (error) {
            return false;
        }
    }

    function navigateToEtfFallback() {
        try {
            if (!root.location) return 'unavailable';

            if (typeof root.location.assign === 'function') {
                root.location.assign(ETF_DCA_URL);
            } else {
                root.location.href = ETF_DCA_URL;
            }

            return 'fallback';
        } catch (error) {
            return 'unavailable';
        }
    }

    /**
     * Returns from Linked Monitor Mode to the ETF_DCA-plan page that started it.
     * Desktop focuses a valid opener; mobile/tablet uses verified same-tab history.
     * Neither path opens a new ETF_DCA-plan tab.
     * @returns {'opener'|'history'|'fallback'|'unavailable'} Navigation path used.
     */
    function returnToEtfDca() {
        if (isMobileOrTablet()) {
            if (
                hasSafeEtfHistory()
                && typeof root.history.back === 'function'
            ) {
                try {
                    root.history.back();
                    return 'history';
                } catch (error) {
                    return navigateToEtfFallback();
                }
            }

            return navigateToEtfFallback();
        }

        try {
            const opener = root.opener;

            if (
                opener
                && opener.closed !== true
                && typeof opener.focus === 'function'
            ) {
                opener.focus();

                if (typeof root.close === 'function') {
                    try {
                        root.close();
                    } catch (error) {
                        // Browsers may refuse to close tabs they do not consider script-opened.
                    }
                }

                return 'opener';
            }
        } catch (error) {
            // Inaccessible opener falls through to same-tab fallback navigation.
        }

        return navigateToEtfFallback();
    }

    /**
     * Validates a Phase 1 Execution Bridge object without changing it.
     * @param {unknown} bridge Candidate bridge value.
     * @returns {boolean} True only when the supported contract and required fields are valid.
     */
    function validateBridge(bridge) {
        if (!bridge || typeof bridge !== 'object') return false;
        if (bridge.version !== CONTRACT_VERSION) return false;
        if (!nonEmptyString(bridge.bridgeId)) return false;

        if (
            !nonEmptyString(bridge.ticker)
            || /\s/.test(bridge.ticker.trim())
        ) {
            return false;
        }

        if (
            !nonEmptyString(bridge.createdAt)
            || !Number.isFinite(Date.parse(bridge.createdAt))
        ) {
            return false;
        }

        if (bridge.sourceApplication !== SOURCE_APPLICATION) {
            return false;
        }

        if (!nonEmptyString(bridge.marketTimeframe)) {
            return false;
        }

        if (!validActiveZone(bridge.activeZone)) {
            return false;
        }

        if (!validOptionalNumber(bridge.preferredEntry)) {
            return false;
        }

        if (!validOptionalNumber(bridge.maximumEntryPrice)) {
            return false;
        }

        if (!validOptionalNumber(bridge.invalidationLevel)) {
            return false;
        }

        if (!validEntryMode(bridge.entryMode)) {
            return false;
        }

        if (!validOptionalBoolean(bridge.starterEligible)) {
            return false;
        }

        if (!validStarterAllocation(bridge.starterAllocationPct)) {
            return false;
        }

        if (!validOptionalBoolean(bridge.starterExecuted)) {
            return false;
        }

        if (!validStarterRisk(bridge.starterRisk)) {
            return false;
        }

        return true;
    }

    /**
     * Reads and validates the current Phase 1 bridge object.
     * Invalid, inaccessible, or malformed storage always resolves to null.
     * @returns {object|null} A valid bridge object or null.
     */
    function readBridge() {
        const raw = storageGet(STORAGE_KEY);

        if (!raw) return null;

        try {
            const bridge = JSON.parse(raw);

            return validateBridge(bridge)
                ? bridge
                : null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Initializes bridge consumption once for the current page lifecycle.
     * Repeated calls never re-read bridge storage.
     * @returns {{mode: string, bridge: object|null}} Current operating mode.
     */
    function initialize() {
        if (initialized) {
            return modeSnapshot();
        }

        initialized = true;

        const bridge = readBridge();

        linkedBridge = bridge
            && storageGet(DISMISSED_KEY) !== bridge.bridgeId
            ? bridge
            : null;

        return modeSnapshot();
    }

    /**
     * Returns the bridge linked at page startup, or null in Standalone Mode.
     * @returns {object|null} Current linked bridge.
     */
    function getLinkedBridge() {
        initialize();
        return linkedBridge;
    }

    /**
     * Re-reads the shared bridge for the current linked session.
     * A replacement or removal ends only this TAR-OBI page's linked session.
     * @returns {object|null} Refreshed linked bridge, or null after replacement/removal.
     */
    function refreshLinkedBridge() {
        if (!initialized || !linkedBridge) {
            return linkedBridge;
        }

        const bridgeId = linkedBridge.bridgeId;
        const refreshed = readBridge();

        linkedBridge = refreshed
            && refreshed.bridgeId === bridgeId
            && storageGet(DISMISSED_KEY) !== bridgeId
            ? refreshed
            : null;

        return linkedBridge;
    }

    /**
     * Returns the current TAR-OBI operating mode.
     * @returns {'linked'|'standalone'} Current operating mode.
     */
    function getMode() {
        initialize();

        return linkedBridge
            ? MODE_LINKED
            : MODE_STANDALONE;
    }

    /**
     * Populates an existing ticker input from the linked bridge without fetching market data.
     * @param {HTMLInputElement|null} input Existing TAR-OBI ticker input.
     * @returns {object|null} Current linked bridge.
     */
    function populateLinkedTicker(input) {
        const bridge = getLinkedBridge();

        if (bridge && input) {
            input.value = bridge.ticker;
        }

        return bridge;
    }

    /**
     * Disconnects when a user-selected ticker differs from the linked ticker.
     * The supplied value is never changed.
     * @param {string} symbol Current user-entered ticker.
     * @returns {'linked'|'standalone'} Resulting operating mode.
     */
    function handleSymbolInput(symbol) {
        const bridge = getLinkedBridge();

        if (
            bridge
            && String(symbol || '').trim().toUpperCase()
                !== bridge.ticker.toUpperCase()
        ) {
            disconnectBridge();
        }

        return getMode();
    }

    /**
     * Disconnects TAR-OBI from the current bridge without modifying Phase 1 bridge storage.
     * @returns {{mode: string, bridge: object|null}} Standalone mode snapshot.
     */
    function disconnectBridge() {
        const bridge = getLinkedBridge();

        if (bridge) {
            storageSet(DISMISSED_KEY, bridge.bridgeId);
        }

        linkedBridge = null;

        return modeSnapshot();
    }

    /**
     * Renders the read-only Execution Context panel for Linked Monitor Mode.
     * The panel remains hidden in Standalone Mode.
     * @param {HTMLElement|null} container Context panel container.
     * @param {{onDisconnect?: Function}} [options] Optional host callback after disconnect.
     * @returns {void}
     */
    function renderContextPanel(container, options = {}) {
        if (!container) return;

        const bridge = refreshLinkedBridge()
            || getLinkedBridge();

        if (!bridge) {
            container.innerHTML = '';
            container.classList?.add('hidden');
            return;
        }

        container.classList?.remove('hidden');

        container.innerHTML = `
            <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <p class="text-xs font-black tracking-wider text-blue-600">
                        EXECUTION CONTEXT
                    </p>
                    <p class="mt-1 text-xs font-bold text-slate-500">
                        Linked Monitor Mode / 連結監控模式
                    </p>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        data-bridge-back
                        class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-500"
                    >
                        Back to ETF_DCA-plan
                    </button>

                    <button
                        type="button"
                        data-bridge-disconnect
                        class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
                    >
                        Disconnect Bridge
                    </button>
                </div>
            </div>

            <div class="mt-4 grid gap-4 lg:grid-cols-[minmax(0,35fr)_minmax(0,65fr)] lg:gap-5">
                <dl
                    data-bridge-section="metadata"
                    class="grid grid-cols-2 gap-3 rounded-lg border border-blue-100 bg-white/70 p-4 text-sm"
                >
                    <div class="col-span-2">
                        <dt class="text-xs text-slate-500">
                            Ticker
                        </dt>

                        <dd
                            data-bridge-field="ticker"
                            class="mt-1 font-mono text-lg font-black text-slate-900"
                        ></dd>
                    </div>

                    <div class="col-span-2">
                        <dt class="text-xs text-slate-500">
                            Source
                        </dt>

                        <dd
                            data-bridge-field="source"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>

                    <div>
                        <dt class="text-xs text-slate-500">
                            Market Timeframe
                        </dt>

                        <dd
                            data-bridge-field="timeframe"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>

                    <div>
                        <dt class="text-xs text-slate-500">
                            Zone Mode
                        </dt>

                        <dd
                            data-bridge-field="zone-mode"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>

                    <div class="col-span-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <dt class="text-xs font-bold text-amber-700">
                            Entry Mode
                        </dt>

                        <dd
                            data-bridge-field="entry-mode"
                            class="mt-1 font-black text-amber-900"
                        ></dd>

                        <dl
                            data-bridge-starter-details
                            class="mt-3 grid grid-cols-2 gap-2 text-xs"
                        >
                            <div>
                                <dt class="text-slate-500">
                                    Starter Status
                                </dt>

                                <dd
                                    data-bridge-field="starter-status"
                                    class="mt-1 font-bold text-slate-800"
                                ></dd>
                            </div>

                            <div>
                                <dt class="text-slate-500">
                                    Starter Allocation
                                </dt>

                                <dd
                                    data-bridge-field="starter-allocation"
                                    class="mt-1 font-bold text-slate-800"
                                ></dd>
                            </div>

                            <div class="col-span-2">
                                <dt class="text-slate-500">
                                    Starter Risk
                                </dt>

                                <dd
                                    data-bridge-field="starter-risk"
                                    class="mt-1 whitespace-normal break-words font-bold leading-5 text-slate-800"
                                ></dd>
                            </div>
                        </dl>
                    </div>

                    <div class="col-span-2 rounded-lg bg-blue-100/70 p-3">
                        <dt class="text-xs font-bold text-blue-700">
                            Active Zone
                        </dt>

                        <dd
                            data-bridge-field="active-zone"
                            class="mt-1 font-mono text-xl font-black text-blue-900"
                        ></dd>
                    </div>
                </dl>

                <div
                    data-bridge-section="setup-signals"
                    class="space-y-4 rounded-lg border border-blue-100 bg-white/70 p-4"
                >
                    <section>
                        <h3 class="text-xs font-bold text-slate-500">
                            Setup Status
                        </h3>

                        <p
                            data-bridge-field="setup"
                            class="mt-1 whitespace-normal break-words text-sm font-bold leading-6 text-slate-800"
                        ></p>
                    </section>

                    <section>
                        <h3 class="text-xs font-bold text-slate-500">
                            Signal Summary
                        </h3>

                        <dl
                            data-bridge-signal-summary
                            class="mt-2 flex flex-wrap gap-2 text-xs"
                        >
                            <div class="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5">
                                <dt class="inline text-slate-500">
                                    H
                                </dt>

                                <dd
                                    data-bridge-field="h-signal"
                                    class="inline font-black text-slate-800"
                                ></dd>
                            </div>

                            <div class="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5">
                                <dt class="inline text-slate-500">
                                    C1
                                </dt>

                                <dd
                                    data-bridge-field="c1"
                                    class="inline font-black text-slate-800"
                                ></dd>
                            </div>

                            <div class="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5">
                                <dt class="inline text-slate-500">
                                    C2
                                </dt>

                                <dd
                                    data-bridge-field="c2"
                                    class="inline font-black text-slate-800"
                                ></dd>
                            </div>

                            <div class="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5">
                                <dt class="inline text-slate-500">
                                    C3
                                </dt>

                                <dd
                                    data-bridge-field="c3"
                                    class="inline font-black text-slate-800"
                                ></dd>
                            </div>

                            <div class="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5">
                                <dt class="inline text-slate-500">
                                    C4
                                </dt>

                                <dd
                                    data-bridge-field="c4"
                                    class="inline font-black text-slate-800"
                                ></dd>
                            </div>
                        </dl>
                    </section>
                </div>
            </div>

            <div data-bridge-monitor-slot></div>
        `;

        const monitorSlot = container.querySelector(
            '[data-bridge-monitor-slot]'
        );

        const values = {
            source: bridge.sourceApplication,
            ticker: bridge.ticker,
            setup: displaySetupStatus(bridge.setupStatus),
            timeframe: displayValue(
                bridge.marketLevelTimeframe,
                bridge.marketTimeframe
            ),
            'zone-mode': displayValue(bridge.zoneMode),
            'entry-mode': displayEntryMode(bridge.entryMode),
            'starter-status': displayStarterStatus(bridge),
            'starter-allocation': displayStarterAllocation(
                bridge.starterAllocationPct
            ),
            'starter-risk': displayStarterRisk(
                bridge.starterRisk
            ),
            'active-zone': displayZone(
                bridge.activeZone
            ),
            'h-signal': displayValue(
                bridge.h1H2Status?.type,
                'Pending'
            ),
            c1: displayCondition(bridge.C1),
            c2: displayCondition(bridge.C2),
            c3: displayCondition(bridge.C3),
            c4: displayC4(bridge.C4)
        };

        Object.entries(values).forEach(([field, value]) => {
            const element = container.querySelector(
                `[data-bridge-field="${field}"]`
            );

            if (element) {
                element.textContent = value;
            }
        });

        const starterDetails = container.querySelector(
            '[data-bridge-starter-details]'
        );

        starterDetails?.classList.toggle(
            'hidden',
            bridge.entryMode !== 'left_side_starter'
        );

        if (typeof options.renderMonitor === 'function') {
            options.renderMonitor(monitorSlot);
        }

        container
            .querySelector('[data-bridge-back]')
            ?.addEventListener('click', event => {
                event?.preventDefault?.();
                returnToEtfDca();
            });

        container
            .querySelector('[data-bridge-disconnect]')
            ?.addEventListener('click', () => {
                disconnectBridge();
                renderContextPanel(container, options);

                if (typeof options.onDisconnect === 'function') {
                    options.onDisconnect();
                }
            });
    }

    return Object.freeze({
        STORAGE_KEY,
        DISMISSED_KEY,
        CONTRACT_VERSION,
        MODE_STANDALONE,
        MODE_LINKED,
        validateBridge,
        readBridge,
        initialize,
        getLinkedBridge,
        refreshLinkedBridge,
        returnToEtfDca,
        getMode,
        populateLinkedTicker,
        handleSymbolInput,
        disconnectBridge,
        renderContextPanel
    });
});