(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TarObiBridgeMonitor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const STORAGE_KEY = 'etfDca.executionBridge.v1';
    const NOTIFICATION_PREFERENCE_KEY = 'tarObi.executionBridge.notificationsEnabled.v1';
    const CONTRACT_VERSION = '1.0';
    const NOTIFICATION_COOLDOWN_MS = 10 * 60 * 1000;
    const DATA_UNAVAILABLE_SUSTAINED_MS = 5 * 60 * 1000;
    const ENTRY_STATE = 'ENTRY_CONDITIONS_MET';
    const MARKET_CLOSE_HOUR = 13;
    const MARKET_CLOSE_MINUTE = 30;
    const ACTIVE_STATUS = 'ACTIVE';
    const TERMINAL_STATUSES = Object.freeze(['COMPLETED', 'EXPIRED', 'INVALIDATED']);
    const STATE_MAP = Object.freeze({
        'DATA UNAVAILABLE': 'DATA_UNAVAILABLE',
        'WAIT FOR CONFIRMATION': 'WAIT_FOR_CONFIRMATION',
        'WAIT FOR PULLBACK': 'WAIT_FOR_PULLBACK',
        'ENTRY CONDITIONS MET': ENTRY_STATE,
        'DO NOT ENTER': 'DO_NOT_ENTER'
    });
    const MONITOR_SESSION_ID = root.crypto?.randomUUID?.()
        || `monitor-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let bridgeApi = null;
    let alertContainer = null;
    let onUiRefresh = null;
    let controlsContainer = null;
    let storageListenerBound = false;
    let observedLifecycle = null;

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
            return true;
        } catch (error) {
            return false;
        }
    }

    function parseBridge(raw) {
        if (!raw) return null;
        try {
            const bridge = JSON.parse(raw);
            return bridgeApi?.validateBridge?.(bridge) ? bridge : null;
        } catch (error) {
            return null;
        }
    }

    function isoNow(now) {
        const date = now instanceof Date ? now : new Date(now ?? Date.now());
        return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
    }

    function taipeiParts(value) {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Taipei',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        }).formatToParts(new Date(value));
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return {
            year: Number(values.year),
            month: Number(values.month),
            day: Number(values.day),
            hour: Number(values.hour),
            minute: Number(values.minute)
        };
    }

    function addCalendarDay(parts) {
        const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
        return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    }

    function weekday(parts) {
        return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    }

    /**
     * Calculates 13:30 Asia/Taipei expiration, skipping weekends but not holidays.
     * @param {string|number|Date} createdAt Bridge creation time.
     * @returns {string} Explicit expiration timestamp.
     */
    function calculateExpiresAt(createdAt) {
        const created = new Date(createdAt);
        const safeCreated = Number.isFinite(created.getTime()) ? created : new Date();
        const time = taipeiParts(safeCreated);
        let day = { year: time.year, month: time.month, day: time.day };
        const afterClose = time.hour > MARKET_CLOSE_HOUR
            || (time.hour === MARKET_CLOSE_HOUR && time.minute >= MARKET_CLOSE_MINUTE);
        if ([0, 6].includes(weekday(day)) || afterClose) day = addCalendarDay(day);
        while ([0, 6].includes(weekday(day))) day = addCalendarDay(day);
        return new Date(Date.UTC(
            day.year,
            day.month - 1,
            day.day,
            MARKET_CLOSE_HOUR - 8,
            MARKET_CLOSE_MINUTE
        )).toISOString();
    }

    function normalizeState(state) {
        const value = String(state || '').trim().toUpperCase();
        return STATE_MAP[value] || (Object.values(STATE_MAP).includes(value) ? value : 'DATA_UNAVAILABLE');
    }

    function optionalNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function firstSummary(assessment) {
        if (typeof assessment?.blockingReason === 'string' && assessment.blockingReason.trim()) {
            return assessment.blockingReason.trim();
        }
        const firstFactor = Array.isArray(assessment?.factors)
            ? assessment.factors.find(factor => typeof factor === 'string' && factor.trim())
            : null;
        return firstFactor?.trim() || String(assessment?.state || 'Data unavailable');
    }

    /**
     * Maps an already-calculated TAR-OBI assessment snapshot to the shared monitor result.
     * This adapter performs no trading calculation.
     * @param {object} snapshot Completed render snapshot.
     * @param {string|null} previousState Previously stored normalized assessment state.
     * @returns {object|null} Normalized monitor result, or null for an incomplete snapshot.
     */
    function normalizeCompletedAssessment(snapshot, previousState = null) {
        if (!snapshot?.complete || !snapshot.assessment || !snapshot.evaluatedAt) return null;
        const assessment = snapshot.assessment;
        return {
            assessmentState: normalizeState(assessment.state),
            previousAssessmentState: previousState || null,
            evaluatedAt: isoNow(snapshot.evaluatedAt),
            currentPrice: optionalNumber(snapshot.currentPrice),
            preferredEntryLow: optionalNumber(assessment.lower),
            preferredEntryHigh: optionalNumber(assessment.upper),
            maximumEntryPrice: optionalNumber(assessment.maximum),
            invalidationLevel: optionalNumber(assessment.invalidation),
            tarState: snapshot.tarState || null,
            obiState: snapshot.obiState || null,
            vwapState: snapshot.vwapState || null,
            spreadState: snapshot.spreadState || null,
            volumeQuality: snapshot.volumeQuality || null,
            summary: firstSummary(assessment),
            blockingReason: assessment.blockingReason || null
        };
    }

    function notificationsEnabled() {
        return storageGet(NOTIFICATION_PREFERENCE_KEY) === 'true';
    }

    function notificationPermission() {
        if (!('Notification' in root)) return 'unsupported';
        return root.Notification.permission || 'default';
    }

    /**
     * Maps notification permission and the existing saved preference to presentation text.
     * This helper does not request permission or change notification behavior.
     * @param {string} permission Browser Notification permission state.
     * @param {boolean} preferenceEnabled Existing local notification preference.
     * @returns {{status: string, label: string, actionable: boolean}} Read-only UI state.
     */
    function notificationUiState(permission, preferenceEnabled) {
        if (permission === 'granted' && preferenceEnabled) {
            return { status: 'Enabled', label: 'Notifications Enabled ✓', actionable: false };
        }
        if (permission === 'denied') {
            return { status: 'Denied', label: 'Notifications Denied', actionable: false };
        }
        if (permission === 'unsupported') {
            return { status: 'Unsupported', label: 'Notifications Unsupported', actionable: false };
        }
        return { status: 'Disabled', label: 'Enable Notifications', actionable: true };
    }

    function notificationAllowed(previousState, currentState, notificationState, evaluatedAt) {
        if (currentState !== ENTRY_STATE || previousState === ENTRY_STATE) return false;
        const lastAt = Date.parse(notificationState?.lastNotifiedAt || '');
        const evaluatedMs = Date.parse(evaluatedAt);
        return !Number.isFinite(lastAt)
            || !Number.isFinite(evaluatedMs)
            || evaluatedMs - lastAt >= NOTIFICATION_COOLDOWN_MS;
    }

    function showInPageAlert(result, message = 'Entry conditions are currently met.') {
        if (!alertContainer) return;
        const time = new Date(result.evaluatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
        alertContainer.classList?.remove('hidden');
        alertContainer.innerHTML = `
            <div class="flex items-start justify-between gap-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-emerald-900 shadow-sm">
                <div>
                    <p class="font-black" data-monitor-alert-title></p>
                    <p class="mt-1 text-sm" data-monitor-alert-message></p>
                    <p class="mt-1 text-xs text-emerald-700" data-monitor-alert-detail></p>
                </div>
                <button type="button" data-monitor-alert-dismiss class="rounded px-2 py-1 text-sm font-black hover:bg-emerald-100" aria-label="Dismiss notification">×</button>
            </div>`;
        alertContainer.querySelector('[data-monitor-alert-title]').textContent = `${bridgeApi?.getLinkedBridge?.()?.ticker || ''} — ${result.assessmentState}`;
        alertContainer.querySelector('[data-monitor-alert-message]').textContent = message;
        alertContainer.querySelector('[data-monitor-alert-detail]').textContent = `Current price: ${result.currentPrice ?? 'Unavailable'} · Evaluated: ${time}`;
        alertContainer.querySelector('[data-monitor-alert-dismiss]')?.addEventListener('click', () => {
            alertContainer.innerHTML = '';
            alertContainer.classList?.add('hidden');
        });
    }

    function issueStatusNotification(title, body, tag) {
        if (!notificationsEnabled() || notificationPermission() !== 'granted') return;
        try {
            new root.Notification(title, { body, tag });
        } catch (error) {
            // Notification failure must never affect assessment rendering.
        }
    }

    function issueBrowserNotification(bridge, result) {
        if (!notificationsEnabled() || notificationPermission() !== 'granted') return;
        try {
            const preferred = result.preferredEntryLow !== null && result.preferredEntryHigh !== null
                ? `${result.preferredEntryLow}–${result.preferredEntryHigh}`
                : 'Unavailable';
            new root.Notification(`${bridge.ticker} Entry Conditions Met`, {
                body: `Entry conditions are currently met.\nCurrent Price: ${result.currentPrice ?? 'Unavailable'}\nPreferred Entry: ${preferred}\nTAR: ${result.tarState || 'Unavailable'}\nOBI: ${result.obiState || 'Unavailable'}\nVWAP: ${result.vwapState || 'Unavailable'}`,
                tag: `tar-obi-entry-${bridge.bridgeId}`
            });
        } catch (error) {
            // Notification failure must never affect assessment rendering.
        }
    }

    function lifecycleFor(bridge, now) {
        const lifecycle = bridge.lifecycle && typeof bridge.lifecycle === 'object'
            ? { ...bridge.lifecycle }
            : {
                status: ACTIVE_STATUS,
                updatedAt: bridge.createdAt,
                expiresAt: calculateExpiresAt(bridge.createdAt),
                reason: null
            };
        if (!lifecycle.expiresAt) lifecycle.expiresAt = calculateExpiresAt(bridge.createdAt);
        return lifecycle;
    }

    function isExpired(lifecycle, now) {
        const expires = Date.parse(lifecycle?.expiresAt || '');
        return Number.isFinite(expires) && now.getTime() >= expires;
    }

    function commitIfUnchanged(raw, bridge) {
        if (storageGet(STORAGE_KEY) !== raw) return false;
        return storageSet(STORAGE_KEY, JSON.stringify(bridge));
    }

    /**
     * Appends optional lifecycle data to a legacy linked bridge and applies expiration.
     * @param {Date|number|string} [now] Injectable clock for tests.
     * @returns {object|null} Reconciled linked bridge.
     */
    function reconcileLinkedLifecycle(now = new Date()) {
        const linked = bridgeApi?.getLinkedBridge?.();
        if (!linked) return null;
        const raw = storageGet(STORAGE_KEY);
        const current = parseBridge(raw);
        if (!current || current.bridgeId !== linked.bridgeId) return null;
        const clock = now instanceof Date ? now : new Date(now);
        let lifecycle = lifecycleFor(current, clock);
        if (['ACTIVE', 'PAUSED'].includes(lifecycle.status) && isExpired(lifecycle, clock)) {
            lifecycle = {
                ...lifecycle,
                status: 'EXPIRED',
                updatedAt: isoNow(clock),
                reason: lifecycle.reason || 'Monitoring period ended at the Taiwan market close.'
            };
        }
        const updated = {
            ...current,
            lifecycle: ['ACTIVE', 'PAUSED'].includes(lifecycle.status)
                ? { ...lifecycle, monitorSessionId: MONITOR_SESSION_ID }
                : lifecycle,
            monitorResult: current.monitorResult || null,
            notificationState: {
                lastNotifiedState: null,
                lastNotifiedAt: null,
                ...(current.notificationState || {})
            },
            extensions: { ...(current.extensions || {}) }
        };
        if (JSON.stringify(updated) !== raw) commitIfUnchanged(raw, updated);
        bridgeApi?.refreshLinkedBridge?.();
        return bridgeApi?.getLinkedBridge?.() || null;
    }

    /**
     * Writes one completed, normalized result to the active linked bridge.
     * The method revalidates bridge identity and lifecycle immediately before writing.
     * @param {object} snapshot Completed render snapshot from the existing refresh.
     * @param {Date|number|string} [now] Injectable clock for tests.
     * @returns {{written: boolean, notified: boolean, reason?: string, result?: object}}
     */
    function captureCompletedAssessment(snapshot, now = new Date()) {
        const linked = bridgeApi?.getLinkedBridge?.();
        if (!linked) return { written: false, notified: false, reason: 'standalone' };
        const raw = storageGet(STORAGE_KEY);
        const current = parseBridge(raw);
        if (!current) return { written: false, notified: false, reason: 'invalid-bridge' };
        if (current.bridgeId !== linked.bridgeId) return { written: false, notified: false, reason: 'bridge-replaced' };
        if (String(current.ticker).toUpperCase() !== String(snapshot?.ticker || '').toUpperCase()) {
            return { written: false, notified: false, reason: 'ticker-mismatch' };
        }

        const clock = now instanceof Date ? now : new Date(now);
        const lifecycle = lifecycleFor(current, clock);
        if (lifecycle.monitorSessionId && lifecycle.monitorSessionId !== MONITOR_SESSION_ID) {
            return { written: false, notified: false, reason: 'inactive-linked-session' };
        }
        if (isExpired(lifecycle, clock)) {
            const expired = {
                ...current,
                lifecycle: {
                    ...lifecycle,
                    status: 'EXPIRED',
                    updatedAt: isoNow(clock),
                    reason: lifecycle.reason || 'Monitoring period ended at the Taiwan market close.'
                }
            };
            const expiredStored = commitIfUnchanged(raw, expired);
            bridgeApi?.refreshLinkedBridge?.();
            if (expiredStored) {
                const result = expired.monitorResult || {
                    assessmentState: 'EXPIRED',
                    currentPrice: null,
                    evaluatedAt: expired.lifecycle.updatedAt
                };
                showInPageAlert(result, 'The linked monitor has expired.');
                issueStatusNotification(
                    `${expired.ticker} Monitor Expired`,
                    'The linked monitor reached its Taiwan trading-day expiration.',
                    `tar-obi-expired-${expired.bridgeId}`
                );
            }
            refreshUi();
            return { written: false, notified: false, reason: 'expired' };
        }
        if (lifecycle.status !== ACTIVE_STATUS) {
            return { written: false, notified: false, reason: String(lifecycle.status || 'inactive').toLowerCase() };
        }

        const previousState = current.monitorResult?.assessmentState || null;
        const result = normalizeCompletedAssessment(snapshot, previousState);
        if (!result) return { written: false, notified: false, reason: 'incomplete-assessment' };
        const storedEvaluation = Date.parse(current.monitorResult?.evaluatedAt || '');
        const nextEvaluation = Date.parse(result.evaluatedAt);
        if (Number.isFinite(storedEvaluation) && Number.isFinite(nextEvaluation) && nextEvaluation <= storedEvaluation) {
            return { written: false, notified: false, reason: 'stale-assessment' };
        }

        const shouldNotify = notificationAllowed(previousState, result.assessmentState, current.notificationState, result.evaluatedAt);
        const notificationState = {
            ...(current.notificationState || {}),
            lastNotifiedState: current.notificationState?.lastNotifiedState || null,
            lastNotifiedAt: current.notificationState?.lastNotifiedAt || null,
            dataUnavailableSince: current.notificationState?.dataUnavailableSince || null,
            lastDataUnavailableNotifiedAt: current.notificationState?.lastDataUnavailableNotifiedAt || null
        };
        let sustainedUnavailable = false;
        if (result.assessmentState === 'DATA_UNAVAILABLE') {
            notificationState.dataUnavailableSince ||= result.evaluatedAt;
            const unavailableSince = Date.parse(notificationState.dataUnavailableSince);
            sustainedUnavailable = !notificationState.lastDataUnavailableNotifiedAt
                && Number.isFinite(unavailableSince)
                && Date.parse(result.evaluatedAt) - unavailableSince >= DATA_UNAVAILABLE_SUSTAINED_MS;
            if (sustainedUnavailable) notificationState.lastDataUnavailableNotifiedAt = result.evaluatedAt;
        } else {
            notificationState.dataUnavailableSince = null;
            notificationState.lastDataUnavailableNotifiedAt = null;
        }
        if (shouldNotify) {
            notificationState.lastNotifiedState = result.assessmentState;
            notificationState.lastNotifiedAt = result.evaluatedAt;
        }
        const updated = {
            ...current,
            lifecycle: {
                ...lifecycle,
                status: ACTIVE_STATUS,
                updatedAt: isoNow(clock)
            },
            monitorResult: result,
            notificationState
        };
        if (!commitIfUnchanged(raw, updated)) {
            return { written: false, notified: false, reason: 'concurrent-update' };
        }

        bridgeApi?.refreshLinkedBridge?.();
        if (shouldNotify) {
            showInPageAlert(result);
            issueBrowserNotification(updated, result);
        } else if (sustainedUnavailable) {
            showInPageAlert(result, 'Market data has remained unavailable for at least five minutes.');
            issueStatusNotification(
                `${updated.ticker} Data Unavailable`,
                'TAR-OBI market data has remained unavailable for at least five minutes.',
                `tar-obi-data-${updated.bridgeId}`
            );
        }
        refreshUi();
        return { written: true, notified: shouldNotify, result };
    }

    /**
     * Changes the lifecycle of the currently linked bridge without changing setup context.
     * @param {'ACTIVE'|'PAUSED'|'COMPLETED'} nextStatus User-selected status.
     * @param {Date|number|string} [now] Injectable clock for tests.
     * @returns {boolean} True when the transition was stored.
     */
    function transitionLifecycle(nextStatus, now = new Date()) {
        if (!['ACTIVE', 'PAUSED', 'COMPLETED'].includes(nextStatus)) return false;
        const linked = bridgeApi?.getLinkedBridge?.();
        const raw = storageGet(STORAGE_KEY);
        const current = parseBridge(raw);
        if (!linked || !current || current.bridgeId !== linked.bridgeId) return false;
        const lifecycle = lifecycleFor(current, now instanceof Date ? now : new Date(now));
        const allowed = (nextStatus === 'PAUSED' && lifecycle.status === 'ACTIVE')
            || (nextStatus === 'ACTIVE' && lifecycle.status === 'PAUSED')
            || (nextStatus === 'COMPLETED' && ['ACTIVE', 'PAUSED'].includes(lifecycle.status));
        if (!allowed) return false;
        const timestamp = isoNow(now);
        const updated = {
            ...current,
            lifecycle: {
                ...lifecycle,
                status: nextStatus,
                updatedAt: timestamp,
                completedAt: nextStatus === 'COMPLETED' ? timestamp : lifecycle.completedAt || null,
                reason: nextStatus === 'COMPLETED' ? 'Monitoring ended by user.' : null
            }
        };
        const stored = commitIfUnchanged(raw, updated);
        if (stored) {
            bridgeApi?.refreshLinkedBridge?.();
            refreshUi();
        }
        return stored;
    }

    /**
     * Requests Browser Notification permission after an explicit user action.
     * @returns {Promise<string>} Resulting permission or unsupported.
     */
    async function enableNotifications() {
        if (!('Notification' in root) || typeof root.Notification.requestPermission !== 'function') {
            storageSet(NOTIFICATION_PREFERENCE_KEY, 'false');
            refreshUi();
            return 'unsupported';
        }
        try {
            const permission = await root.Notification.requestPermission();
            storageSet(NOTIFICATION_PREFERENCE_KEY, permission === 'granted' ? 'true' : 'false');
            refreshUi();
            return permission;
        } catch (error) {
            storageSet(NOTIFICATION_PREFERENCE_KEY, 'false');
            refreshUi();
            return 'denied';
        }
    }

    function formatTime(value) {
        if (!value || !Number.isFinite(Date.parse(value))) return 'Unavailable';
        return new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    }

    function refreshUi() {
        if (typeof onUiRefresh === 'function') onUiRefresh();
        else if (controlsContainer) renderControls(controlsContainer);
    }

    /**
     * Renders the compact Linked Monitor status and controls.
     * @param {HTMLElement|null} container Monitor slot in the Execution Context panel.
     * @returns {void}
     */
    function renderControls(container) {
        if (!container) return;
        controlsContainer = container;
        const bridge = bridgeApi?.getLinkedBridge?.();
        if (!bridge) {
            container.innerHTML = '';
            return;
        }
        const lifecycle = lifecycleFor(bridge, new Date());
        const result = bridge.monitorResult || null;
        const permission = notificationPermission();
        const notificationUi = notificationUiState(permission, notificationsEnabled());
        const notificationControl = notificationUi.actionable
            ? `<button type="button" data-monitor-action="notify" class="rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-bold text-blue-700 hover:bg-blue-50">${notificationUi.label}</button>`
            : `<button type="button" disabled aria-disabled="true" data-monitor-notification-status class="cursor-default rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600">${notificationUi.label}</button>`;
        const pauseAction = lifecycle.status === 'PAUSED' ? 'resume' : 'pause';
        const activeControl = ['ACTIVE', 'PAUSED'].includes(lifecycle.status);
        container.innerHTML = `
            <div class="mt-4 border-t border-blue-200 pt-4">
                <p class="text-xs font-black tracking-wider text-blue-600">LINKED MONITOR</p>
                <dl class="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-3">
                    <div><dt class="text-xs text-slate-500">Lifecycle</dt><dd data-monitor-field="lifecycle" class="mt-1 font-bold"></dd></div>
                    <div><dt class="text-xs text-slate-500">Assessment</dt><dd data-monitor-field="assessment" class="mt-1 font-bold"></dd></div>
                    <div><dt class="text-xs text-slate-500">Current Price</dt><dd data-monitor-field="price" class="mt-1 font-mono font-bold"></dd></div>
                    <div><dt class="text-xs text-slate-500">Last Evaluated</dt><dd data-monitor-field="evaluated" class="mt-1 font-bold"></dd></div>
                    <div><dt class="text-xs text-slate-500">Notifications</dt><dd data-monitor-field="notifications" class="mt-1 font-bold"></dd></div>
                    <div><dt class="text-xs text-slate-500">Last Notification</dt><dd data-monitor-field="last-notification" class="mt-1 font-bold"></dd></div>
                </dl>
                <div class="mt-3">
                    <div class="flex flex-wrap gap-2">
                        ${notificationControl}
                        ${activeControl ? `<button type="button" data-monitor-action="${pauseAction}" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">${pauseAction === 'pause' ? 'Pause Monitor' : 'Resume Monitor'}</button>` : ''}
                        ${activeControl ? '<button type="button" data-monitor-action="complete" class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">End Monitor</button>' : ''}
                    </div>
                    <p class="mt-2 text-xs text-slate-500">Notifies you when the assessment changes to ENTRY CONDITIONS MET.</p>
                </div>
                <p class="mt-3 text-xs text-slate-500">Monitoring requires this page to remain open. Mobile operating systems may suspend background pages.</p>
            </div>`;
        const values = {
            lifecycle: lifecycle.status || 'ACTIVE',
            assessment: result?.assessmentState || 'Not evaluated',
            price: result?.currentPrice ?? 'Unavailable',
            evaluated: formatTime(result?.evaluatedAt),
            notifications: notificationUi.status,
            'last-notification': formatTime(bridge.notificationState?.lastNotifiedAt)
        };
        Object.entries(values).forEach(([field, value]) => {
            const element = container.querySelector(`[data-monitor-field="${field}"]`);
            if (element) element.textContent = value;
        });
        container.querySelector('[data-monitor-action="notify"]')?.addEventListener('click', enableNotifications);
        container.querySelector('[data-monitor-action="pause"]')?.addEventListener('click', () => transitionLifecycle('PAUSED'));
        container.querySelector('[data-monitor-action="resume"]')?.addEventListener('click', () => transitionLifecycle('ACTIVE'));
        container.querySelector('[data-monitor-action="complete"]')?.addEventListener('click', () => transitionLifecycle('COMPLETED'));
    }

    function handleStorageEvent(event) {
        if (event.key !== STORAGE_KEY) return;
        const before = bridgeApi?.getLinkedBridge?.();
        bridgeApi?.refreshLinkedBridge?.();
        const after = bridgeApi?.getLinkedBridge?.();
        if (before && after && before.bridgeId === after.bridgeId) {
            const nextStatus = after.lifecycle?.status || ACTIVE_STATUS;
            if (observedLifecycle && nextStatus !== observedLifecycle && TERMINAL_STATUSES.includes(nextStatus)) {
                const result = after.monitorResult || {
                    assessmentState: nextStatus,
                    currentPrice: null,
                    evaluatedAt: after.lifecycle?.updatedAt || isoNow()
                };
                showInPageAlert(result, `Bridge lifecycle changed to ${nextStatus.toLowerCase()}.`);
                issueStatusNotification(
                    `${after.ticker} Monitor ${nextStatus}`,
                    `The linked monitor lifecycle changed to ${nextStatus.toLowerCase()}.`,
                    `tar-obi-lifecycle-${after.bridgeId}-${nextStatus}`
                );
            }
            observedLifecycle = nextStatus;
        }
        refreshUi();
    }

    /**
     * Connects the monitor adapter to the existing Phase 2 loader and UI containers.
     * @param {{bridgeApi: object, alertContainer?: HTMLElement, onUiRefresh?: Function}} options Host dependencies.
     * @returns {void}
     */
    function mount(options = {}) {
        bridgeApi = options.bridgeApi || root.TarObiBridge || bridgeApi;
        alertContainer = options.alertContainer || alertContainer;
        onUiRefresh = options.onUiRefresh || onUiRefresh;
        reconcileLinkedLifecycle();
        observedLifecycle = bridgeApi?.getLinkedBridge?.()?.lifecycle?.status || ACTIVE_STATUS;
        if (!storageListenerBound && typeof root.addEventListener === 'function') {
            storageListenerBound = true;
            root.addEventListener('storage', handleStorageEvent);
        }
    }

    return Object.freeze({
        STORAGE_KEY,
        NOTIFICATION_PREFERENCE_KEY,
        CONTRACT_VERSION,
        NOTIFICATION_COOLDOWN_MS,
        DATA_UNAVAILABLE_SUSTAINED_MS,
        ENTRY_STATE,
        calculateExpiresAt,
        notificationUiState,
        normalizeCompletedAssessment,
        reconcileLinkedLifecycle,
        captureCompletedAssessment,
        transitionLifecycle,
        enableNotifications,
        renderControls,
        mount
    });
});
