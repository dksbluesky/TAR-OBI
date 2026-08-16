(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TarObiBridgeMonitor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const STORAGE_KEY = 'etfDca.executionBridge.v1';
    const NOTIFICATION_PREFERENCE_KEY = 'tarObi.executionBridge.notificationsEnabled.v1';
    const CONTINUITY_DURATION_KEY = 'tarObi.executionBridge.continuousValiditySeconds.v1';
    const DEFAULT_CONTINUITY_SECONDS = 90;
    const CONTRACT_VERSION = '1.0';
    const NOTIFICATION_COOLDOWN_MS = 10 * 60 * 1000;
    const DATA_UNAVAILABLE_SUSTAINED_MS = 5 * 60 * 1000;
    const ENTRY_STATE = 'ENTRY_CONDITIONS_MET';
    const ENTRY_CONFIRMATION_REQUIRED = 2;
    const ENTRY_CONFIRMATION_STATUS = Object.freeze({
        NONE: 'NONE',
        PENDING: 'PENDING',
        CONFIRMED: 'CONFIRMED'
    });
    const MARKET_CLOSE_HOUR = 13;
    const MARKET_CLOSE_MINUTE = 30;
    const ACTIVE_STATUS = 'ACTIVE';
    const TERMINAL_STATUSES = Object.freeze([
        'COMPLETED',
        'EXPIRED',
        'INVALIDATED'
    ]);

    const STATE_MAP = Object.freeze({
        'DATA UNAVAILABLE': 'DATA_UNAVAILABLE',
        'WAIT FOR CONFIRMATION': 'WAIT_FOR_CONFIRMATION',
        'WAIT FOR PULLBACK': 'WAIT_FOR_PULLBACK',
        'ENTRY CONDITIONS MET': ENTRY_STATE,
        'LEFT-SIDE STARTER ELIGIBLE': 'LEFT_SIDE_STARTER_ELIGIBLE',
        'LEFT-SIDE EXECUTION ACCEPTABLE': 'LEFT_SIDE_EXECUTION_ACCEPTABLE',
        'HIGH-RISK LEFT-SIDE ENTRY': 'HIGH_RISK_LEFT_SIDE_ENTRY',
        'DO NOT ENTER': 'DO_NOT_ENTER'
    });

    const MONITOR_SESSION_ID = root.crypto?.randomUUID?.()
        || `monitor-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let bridgeApi = null;
    let alertContainer = null;
    let onUiRefresh = null;
    let controlsContainer = null;
    let storageListenerBound = false;
    let mobileListenerBound = false;
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

            return bridgeApi?.validateBridge?.(bridge)
                ? bridge
                : null;
        } catch (error) {
            return null;
        }
    }

    function isoNow(now) {
        const date = now instanceof Date
            ? now
            : new Date(now ?? Date.now());

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
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

        const values = Object.fromEntries(
            parts.map(part => [part.type, part.value])
        );

        return {
            year: Number(values.year),
            month: Number(values.month),
            day: Number(values.day),
            hour: Number(values.hour),
            minute: Number(values.minute)
        };
    }

    function addCalendarDay(parts) {
        const date = new Date(Date.UTC(
            parts.year,
            parts.month - 1,
            parts.day + 1
        ));

        return {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate()
        };
    }

    function weekday(parts) {
        return new Date(Date.UTC(
            parts.year,
            parts.month - 1,
            parts.day
        )).getUTCDay();
    }

    /**
     * Calculates 13:30 Asia/Taipei expiration,
     * skipping weekends but not holidays.
     *
     * @param {string|number|Date} createdAt Bridge creation time.
     * @returns {string} Explicit expiration timestamp.
     */
    function calculateExpiresAt(createdAt) {
        const created = new Date(createdAt);

        const safeCreated = Number.isFinite(created.getTime())
            ? created
            : new Date();

        const time = taipeiParts(safeCreated);

        let day = {
            year: time.year,
            month: time.month,
            day: time.day
        };

        const afterClose = time.hour > MARKET_CLOSE_HOUR
            || (
                time.hour === MARKET_CLOSE_HOUR
                && time.minute >= MARKET_CLOSE_MINUTE
            );

        if ([0, 6].includes(weekday(day)) || afterClose) {
            day = addCalendarDay(day);
        }

        while ([0, 6].includes(weekday(day))) {
            day = addCalendarDay(day);
        }

        return new Date(Date.UTC(
            day.year,
            day.month - 1,
            day.day,
            MARKET_CLOSE_HOUR - 8,
            MARKET_CLOSE_MINUTE
        )).toISOString();
    }

    function normalizeState(state) {
        const value = String(state || '')
            .trim()
            .toUpperCase();

        return STATE_MAP[value]
            || (
                Object.values(STATE_MAP).includes(value)
                    ? value
                    : 'DATA_UNAVAILABLE'
            );
    }

    function optionalNumber(value) {
        if (
            value === null
            || value === undefined
            || value === ''
        ) {
            return null;
        }

        const number = Number(value);

        return Number.isFinite(number)
            ? number
            : null;
    }

    function firstSummary(assessment) {
        if (
            typeof assessment?.blockingReason === 'string'
            && assessment.blockingReason.trim()
        ) {
            return assessment.blockingReason.trim();
        }

        const firstFactor = Array.isArray(assessment?.factors)
            ? assessment.factors.find(
                factor => typeof factor === 'string'
                    && factor.trim()
            )
            : null;

        return firstFactor?.trim()
            || String(assessment?.state || 'Data unavailable');
    }

    /**
     * Maps an already-calculated TAR-OBI assessment snapshot
     * to the shared monitor result.
     *
     * This adapter performs no trading calculation.
     *
     * @param {object} snapshot Completed render snapshot.
     * @param {string|null} previousState Previously stored normalized state.
     * @returns {object|null} Normalized result, or null.
     */
    function normalizeCompletedAssessment(
        snapshot,
        previousState = null
    ) {
        if (
            !snapshot?.complete
            || !snapshot.assessment
            || !snapshot.evaluatedAt
        ) {
            return null;
        }

        const assessment = snapshot.assessment;

        return {
            assessmentState: normalizeState(assessment.state),

            previousAssessmentState: previousState || null,

            evaluatedAt: isoNow(snapshot.evaluatedAt),

            currentPrice: optionalNumber(snapshot.currentPrice),

            preferredEntryLow: optionalNumber(
                assessment.lower
            ),

            preferredEntryHigh: optionalNumber(
                assessment.upper
            ),

            maximumEntryPrice: optionalNumber(
                assessment.maximum
            ),

            invalidationLevel: optionalNumber(
                assessment.invalidation
            ),

            entryMode:
               snapshot.entryMode === 'left_side_starter'
                       ? 'left_side_starter'
                        : snapshot.entryMode === 'confirmed'
                              ? 'confirmed'
                              : 'pending',

            starterEligible:
                snapshot.starterEligible === true,

            starterAllocationPct: optionalNumber(
                snapshot.starterAllocationPct
            ),

            starterExecuted:
                snapshot.starterExecuted === true,

            starterRisk:
                snapshot.starterRisk
                && typeof snapshot.starterRisk === 'object'
                    ? JSON.parse(
                        JSON.stringify(snapshot.starterRisk)
                    )
                    : null,

            rawAssessmentState: String(
                assessment.rawState
                || assessment.state
                || ''
            ),

            tarState: snapshot.tarState || null,
            obiState: snapshot.obiState || null,
            vwapState: snapshot.vwapState || null,
            spreadState: snapshot.spreadState || null,
            volumeQuality: snapshot.volumeQuality || null,

            summary: firstSummary(assessment),

            blockingReason:
                assessment.blockingReason || null
        };
    }

    function notificationsEnabled() {
        return storageGet(
            NOTIFICATION_PREFERENCE_KEY
        ) === 'true';
    }

    function notificationPermission() {
        if (!('Notification' in root)) {
            return 'unsupported';
        }

        return root.Notification.permission || 'default';
    }

    function deliverNotification(title, options) {
        const mobileSupport = root.TarObiMobileSupport;
        if (typeof mobileSupport?.showNotification === 'function') {
            return Promise.resolve(
                mobileSupport.showNotification(title, options)
            ).catch(() => false);
        }

        try {
            new root.Notification(title, options);
            return Promise.resolve(true);
        } catch (error) {
            return Promise.resolve(false);
        }
    }

    function screenWakeLockUiStatus(lifecycle) {
        const mobileSupport = root.TarObiMobileSupport;
        if (!mobileSupport) return 'Unsupported';
        if (lifecycle?.status !== ACTIVE_STATUS) return 'Inactive';
        if (root.document?.visibilityState === 'hidden') return 'Waiting for visible page';
        return mobileSupport.screenWakeLockStatus?.() || 'Unsupported';
    }

    /**
     * Synchronizes Android screen-awake support with the existing linked lifecycle.
     * This helper does not change bridge state or assessment calculations.
     * @returns {Promise<boolean>} Whether the requested platform state was applied.
     */
    async function syncMobileSupport() {
        const mobileSupport = root.TarObiMobileSupport;
        if (!mobileSupport) return false;

        const bridge = bridgeApi?.getLinkedBridge?.();
        const lifecycle = bridge ? lifecycleFor(bridge, new Date()) : null;
        const shouldStayAwake = lifecycle?.status === ACTIVE_STATUS
            && root.document?.visibilityState !== 'hidden';
        const before = mobileSupport.screenWakeLockStatus?.();
        const applied = shouldStayAwake
            ? await mobileSupport.requestScreenWakeLock?.()
            : await mobileSupport.releaseScreenWakeLock?.();
        const after = mobileSupport.screenWakeLockStatus?.();

        if (before !== after && controlsContainer) refreshUi();
        return Boolean(applied);
    }
    /**
     * Maps notification permission and the existing saved preference
     * to presentation text.
     *
     * This helper does not request permission
     * or change notification behavior.
     *
     * @param {string} permission Browser Notification permission state.
     * @param {boolean} preferenceEnabled Existing local notification preference.
     * @returns {{status: string, label: string, actionable: boolean}}
     */
    function notificationUiState(
        permission,
        preferenceEnabled
    ) {
        if (
            permission === 'granted'
            && preferenceEnabled
        ) {
            return {
                status: 'Enabled',
                label: 'Notifications Enabled ✓',
                actionable: false
            };
        }

        if (permission === 'denied') {
            return {
                status: 'Denied',
                label: 'Notifications Denied',
                actionable: false
            };
        }

        if (permission === 'unsupported') {
            return {
                status: 'Unsupported',
                label: 'Notifications Unsupported',
                actionable: false
            };
        }

        return {
            status: 'Disabled',
            label: 'Enable Notifications',
            actionable: true
        };
    }

    function linkedZoneUnavailable(bridge) {
        const zone = bridge?.activeZone;
        const lowValue = zone?.low;
        const highValue = zone?.high;
        if (lowValue === null || lowValue === undefined || lowValue === '' || highValue === null || highValue === undefined || highValue === '') return true;
        const low = Number(lowValue);
        const high = Number(highValue);
        if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0 || low > high) return true;
        const context = bridge?.extensions?.marketContextV1;
        if (!context) return false;
        const manualOverride = bridge?.zoneMode === 'manual_override' && context.manualOverride === true;
        return !manualOverride && (context.context !== 'bullish' || context.automaticZoneEligible !== true);
    }
    // Linked-zone gate only controls monitor confirmation. It never changes the raw TAR-OBI assessment.
    function linkedZoneGateEligible(bridge, result) {
        if (linkedZoneUnavailable(bridge)) return false;
        const context = bridge?.extensions?.marketContextV1;
        // Legacy bridge v1 objects with a valid zone preserve prior behavior.
        if (!context) return true;
        const zone = bridge?.activeZone;
        const price = Number(result?.currentPrice);
        const invalidation = Number(context?.invalidationLevel);
        const manualOverride = bridge?.zoneMode === 'manual_override' && context?.manualOverride === true;
        return (manualOverride || (context?.context === 'bullish' && context?.automaticZoneEligible === true))
            && Number.isFinite(price)
            && Number.isFinite(Number(zone?.low))
            && Number.isFinite(Number(zone?.high))
            && price >= Number(zone.low) - 1e-9
            && price <= Number(zone.high) + 1e-9
            && (!Number.isFinite(invalidation) || price >= invalidation - 1e-9);
    }
    // A temporary price exit pauses Suggested Buy confirmation only. It does
    // not alter the linked bridge lifecycle or the raw TAR-OBI assessment.
    function priceOutsideBridgedZone(bridge, result) {
        const context = bridge?.extensions?.marketContextV1;
        if (!context) return false;
        const zone = bridge?.activeZone;
        const price = Number(result?.currentPrice);
        const low = Number(zone?.low);
        const high = Number(zone?.high);
        return Number.isFinite(price)
            && Number.isFinite(low)
            && Number.isFinite(high)
            && (price < low - 1e-9 || price > high + 1e-9);
    }

    /**
     * Produces display-only Final Action context from existing assessment and
     * linked-monitor state. It does not alter assessment, confirmation, or
     * notification behavior.
     */
    function finalActionContext(bridge, assessmentState, currentPrice) {
        const normalizedAssessment = normalizeState(assessmentState);
        const linked = Boolean(bridge);
        const noValidZone = linked && linkedZoneUnavailable(bridge);
        const zoneInvalidation = optionalNumber(bridge?.invalidationLevel);
        const zoneInvalid = linked
            && !noValidZone
            && Number.isFinite(Number(currentPrice))
            && zoneInvalidation !== null
            && Number(currentPrice) < zoneInvalidation - 1e-9;
        const live = bridge?.notificationState?.continuousValidity?.status === 'LIVE';

        if (noValidZone) {
            return Object.freeze({
                action: 'DO_NOT_ENTER',
                reason: 'No valid Active Zone',
                zoneInvalid: false,
                zoneInvalidation,
                linked,
                live
            });
        }

        if (zoneInvalid) {
            return Object.freeze({
                action: 'DO_NOT_ENTER',
                reason: 'ZONE INVALID',
                zoneInvalid: true,
                zoneInvalidation,
                linked,
                live
            });
        }

        if (linked && normalizedAssessment === ENTRY_STATE && !live) {
            return Object.freeze({
                action: 'WAIT',
                reason: 'Waiting for the existing linked confirmation to reach Suggested Buy — LIVE.',
                zoneInvalid: false,
                zoneInvalidation,
                linked,
                live
            });
        }

        const action = normalizedAssessment === ENTRY_STATE
            ? 'BUY_NOW'
            : normalizedAssessment === 'DO_NOT_ENTER'
                ? 'DO_NOT_ENTER'
                : 'WAIT';

        return Object.freeze({
            action,
            reason: null,
            zoneInvalid: false,
            zoneInvalidation,
            linked,
            live
        });
    }
    function continuityDurationSeconds() {
        const value = Number(storageGet(CONTINUITY_DURATION_KEY));
        return [30, 60, 90, 120].includes(value)
            ? value
            : DEFAULT_CONTINUITY_SECONDS;
    }

    /**
     * Stores a new uninterrupted-validity duration and resets any in-progress
     * confirmation window. Raw TAR-OBI assessments are not changed.
     * @param {number|string} durationSeconds Requested supported duration.
     * @returns {boolean} True when the selected duration was accepted.
     */
    function setContinuityDuration(durationSeconds) {
        const duration = Number(durationSeconds);
        if (![30, 60, 90, 120].includes(duration)) return false;
        storageSet(CONTINUITY_DURATION_KEY, String(duration));
        const raw = storageGet(STORAGE_KEY);
        const current = parseBridge(raw);
        if (!current) return true;
        const updated = {
            ...current,
            notificationState: {
                ...(current.notificationState || {}),
                continuousValidity: {
                    status: 'NONE',
                    startedAt: null,
                    durationSeconds: duration,
                    elapsedSeconds: 0,
                    confirmedAt: null
                }
            }
        };
        commitIfUnchanged(raw, updated);
        bridgeApi?.refreshLinkedBridge?.();
        return true;
    }
    function advanceContinuousValidity(previous, eligible, evaluatedAt) {
        const prior = previous && typeof previous === 'object' ? previous : {};
        const evaluatedMs = Date.parse(evaluatedAt);
        const startedAt = eligible && Number.isFinite(evaluatedMs)
            ? (prior.startedAt || evaluatedAt)
            : null;
        const durationSeconds = continuityDurationSeconds();
        const elapsedSeconds = startedAt && Number.isFinite(evaluatedMs)
            ? Math.max(0, Math.floor((evaluatedMs - Date.parse(startedAt)) / 1000))
            : 0;
        const live = eligible && elapsedSeconds >= durationSeconds;
        return {
            status: live ? 'LIVE' : eligible ? 'PENDING' : 'NONE',
            startedAt,
            durationSeconds,
            elapsedSeconds,
            liveAt: live ? (prior.liveAt || evaluatedAt) : null,
            reason: eligible ? null : 'A required live condition failed.'
        };
    }

    function expiredContinuousValidity() {
        return {
            status: 'EXPIRED',
            startedAt: null,
            durationSeconds: continuityDurationSeconds(),
            elapsedSeconds: 0,
            liveAt: null,
            reason: 'price outside bridged Zone'
        };
    }

    function continuousValidityLabel(validity, result) {
        if (result?.assessmentState === 'DATA_UNAVAILABLE') {
            const reason = String(
                result.summary
                || result.blockingReason
                || 'Required live/assessment data unavailable.'
            ).trim();
            return `Unavailable — ${reason}`;
        }
        if (validity?.status === 'LIVE') return 'Suggested Buy — LIVE';
        if (validity?.status === 'PENDING') return `Confirmation pending — ${validity.elapsedSeconds || 0} / ${validity.durationSeconds || DEFAULT_CONTINUITY_SECONDS} seconds`;
        if (validity?.status === 'EXPIRED' && validity?.reason === 'price outside bridged Zone') return 'EXPIRED — price outside bridged Zone';
        return 'Not pending';
    }
    function notificationAllowed(
        previousStatus,
        currentStatus,
        notificationState,
        evaluatedAt
    ) {
        if (
            currentStatus
                !== ENTRY_CONFIRMATION_STATUS.CONFIRMED
            || previousStatus
                === ENTRY_CONFIRMATION_STATUS.CONFIRMED
        ) {
            return false;
        }

        const lastAt = Date.parse(
            notificationState?.lastNotifiedAt || ''
        );

        const evaluatedMs = Date.parse(evaluatedAt);

        return !Number.isFinite(lastAt)
            || !Number.isFinite(evaluatedMs)
            || evaluatedMs - lastAt
                >= NOTIFICATION_COOLDOWN_MS;
    }

    /**
     * Advances the notification-only entry confirmation state
     * for one completed assessment.
     *
     * This helper does not alter or recalculate
     * the raw TAR-OBI assessment.
     *
     * @param {object|null} previous
     * Previously stored entry confirmation state.
     *
     * @param {string} assessmentState
     * Latest normalized raw assessment state.
     *
     * @param {string} evaluatedAt
     * Completed assessment timestamp.
     *
     * @returns {{
     *   status: string,
     *   consecutiveCount: number,
     *   confirmedAt: string|null
     * }}
     */
    function advanceEntryConfirmation(
        previous,
        assessmentState,
        evaluatedAt
    ) {
        const prior = previous
            && typeof previous === 'object'
            ? previous
            : {};

        if (assessmentState !== ENTRY_STATE) {
            return {
                ...prior,
                status: ENTRY_CONFIRMATION_STATUS.NONE,
                consecutiveCount: 0,
                confirmedAt: null
            };
        }

        const priorCount =
            prior.status
                === ENTRY_CONFIRMATION_STATUS.PENDING
                ? Math.max(
                    0,
                    Math.min(
                        ENTRY_CONFIRMATION_REQUIRED - 1,
                        Number(prior.consecutiveCount) || 0
                    )
                )
                : prior.status
                    === ENTRY_CONFIRMATION_STATUS.CONFIRMED
                    ? ENTRY_CONFIRMATION_REQUIRED
                    : 0;

        const consecutiveCount = Math.min(
            ENTRY_CONFIRMATION_REQUIRED,
            priorCount + 1
        );

        const confirmed =
            consecutiveCount
            >= ENTRY_CONFIRMATION_REQUIRED;

        return {
            ...prior,

            status: confirmed
                ? ENTRY_CONFIRMATION_STATUS.CONFIRMED
                : ENTRY_CONFIRMATION_STATUS.PENDING,

            consecutiveCount,

            confirmedAt: confirmed
                ? (
                    prior.confirmedAt
                    || evaluatedAt
                )
                : null
        };
    }

    function initialEntryConfirmation(bridge) {
        const existing =
            bridge?.notificationState?.entryConfirmation;

        if (
            existing
            && typeof existing === 'object'
        ) {
            return existing;
        }

        if (
            bridge?.monitorResult?.assessmentState
                !== ENTRY_STATE
        ) {
            return {
                status: ENTRY_CONFIRMATION_STATUS.NONE,
                consecutiveCount: 0,
                confirmedAt: null
            };
        }

        if (
            bridge?.notificationState?.lastNotifiedState
                === ENTRY_STATE
        ) {
            return {
                status:
                    ENTRY_CONFIRMATION_STATUS.CONFIRMED,

                consecutiveCount:
                    ENTRY_CONFIRMATION_REQUIRED,

                confirmedAt:
                    bridge.notificationState.lastNotifiedAt
                    || bridge.monitorResult.evaluatedAt
                    || null
            };
        }

        return {
            status:
                ENTRY_CONFIRMATION_STATUS.PENDING,

            consecutiveCount: 1,

            confirmedAt: null
        };
    }

    function entryConfirmationLabel(confirmation) {
        if (
            confirmation?.status
                === ENTRY_CONFIRMATION_STATUS.CONFIRMED
        ) {
            return 'Confirmed 2/2';
        }

        if (
            confirmation?.status
                === ENTRY_CONFIRMATION_STATUS.PENDING
        ) {
            return `Pending ${
                Math.max(
                    1,
                    Number(
                        confirmation.consecutiveCount
                    ) || 1
                )
            }/2`;
        }

        return 'Not pending';
    }

    function formatAlertPrice(value) {
        if (
            value === null
            || value === undefined
            || value === ''
        ) {
            return null;
        }

        const number = Number(value);

        if (!Number.isFinite(number)) {
            return null;
        }

        return number.toLocaleString('en-US', {
            useGrouping: false,
            minimumFractionDigits: 2,
            maximumFractionDigits: 4
        });
    }

    function alertTime(value) {
        return new Date(value).toLocaleString(
            'zh-TW',
            {
                timeZone: 'Asia/Taipei',
                hour12: false
            }
        );
    }

    function confirmedEntryPresentation(
        ticker,
        result,
        bridge = null
    ) {
        const sellerActive =
            result.tarState === 'Seller Active';

        const belowVwap =
            result.vwapState === 'Below VWAP';

        const currentPrice =
            formatAlertPrice(result.currentPrice)
            || 'Unavailable';

        const preferredLow =
            formatAlertPrice(
                result.preferredEntryLow
            );

        const preferredHigh =
            formatAlertPrice(
                result.preferredEntryHigh
            );

        const zoneLow =
            formatAlertPrice(
                bridge?.activeZone?.low
            );

        const zoneHigh =
            formatAlertPrice(
                bridge?.activeZone?.high
            );

        const validActiveZone =
            zoneLow
            && zoneHigh
            && Number(bridge.activeZone.low)
                <= Number(bridge.activeZone.high);

        const insideActiveZone =
            validActiveZone
            && Number.isFinite(
                Number(result.currentPrice)
            )
            && Number(result.currentPrice)
                >= Number(bridge.activeZone.low) - 1e-9
            && Number(result.currentPrice)
                <= Number(bridge.activeZone.high) + 1e-9;

        const marketCaution =
            sellerActive && belowVwap
                ? 'Seller Active / Below VWAP'
                : sellerActive
                    ? 'Seller Active'
                    : belowVwap
                        ? 'Below VWAP'
                        : null;

        const caution =
            validActiveZone && !insideActiveZone
                ? `CAUTION — Current Price is outside ETF_DCA Active Zone ${zoneLow}–${zoneHigh}${marketCaution ? ` / ${marketCaution}` : ''}`
                : marketCaution
                    ? `CAUTION — ${marketCaution}`
                    : null;

        const tone =
            validActiveZone && !insideActiveZone
                ? 'orange'
                : sellerActive && belowVwap
                    ? 'orange'
                    : sellerActive || belowVwap
                        ? 'amber'
                        : 'green';

        const details = [
            `Current Price: ${currentPrice}`
        ];

        if (
            preferredLow
            && preferredHigh
        ) {
            details.push(
                `Preferred Entry: ${preferredLow}–${preferredHigh}`
            );

            const insidePreferredEntry =
                Number(result.currentPrice)
                    >= Number(result.preferredEntryLow) - 1e-9
                && Number(result.currentPrice)
                    <= Number(result.preferredEntryHigh) + 1e-9;

            details.push(
                `Preferred Entry Check: ${insidePreferredEntry ? 'PASS — Current Price is inside range' : 'FAIL — Current Price is outside range'}`
            );
        }

        details.push(
            validActiveZone
                ? `ETF_DCA Active Zone: ${insideActiveZone ? 'PASS' : 'CAUTION'} — Current Price is ${insideActiveZone ? 'inside' : 'outside'} ${zoneLow}–${zoneHigh}`
                : 'ETF_DCA Active Zone: UNAVAILABLE — linked zone cannot be evaluated'
        );

        if (result.tarState) {
            details.push(
                `TAR: ${result.tarState}`
            );
        }

        if (result.obiState) {
            details.push(
                `OBI: ${result.obiState}`
            );
        }

        const mixedEvidence =
            (
                result.tarState === 'Buyer Active'
                && result.obiState === 'Ask Dominant'
            )
            || (
                result.tarState === 'Seller Active'
                && result.obiState === 'Bid Dominant'
            );

        details.push(
            mixedEvidence
                ? `Market Evidence: MIXED — ${result.tarState} TAR / ${result.obiState} OBI`
                : 'Market Evidence: ALIGNED OR NEUTRAL'
        );

        if (result.vwapState) {
            details.push(
                `VWAP: ${result.vwapState}`
            );
        }

        details.push('Confirmation: 2/2');

        details.push(
            `Evaluated: ${alertTime(result.evaluatedAt)}`
        );

        return {
            title:
                `${ticker} — ENTRY SETUP CONFIRMED`,

            disclaimer:
                'Setup confirmed twice; not a buy signal or order instruction.',

            caution,
            tone,
            details
        };
    }
    function showInPageAlert(
        result,
        message =
            'Entry conditions are currently met.',
        presentation = null
    ) {
        if (!alertContainer) return;

        const content =
            presentation
            || {
                title:
                    `${
                        bridgeApi
                            ?.getLinkedBridge
                            ?.()
                            ?.ticker
                        || ''
                    } — ${result.assessmentState}`,

                message,

                details: [
                    `Current price: ${
                        result.currentPrice
                        ?? 'Unavailable'
                    } · Evaluated: ${
                        alertTime(result.evaluatedAt)
                    }`
                ]
            };

        const tones = {
            green: {
                wrapper:
                    'border-emerald-300 bg-emerald-50 text-emerald-900',

                details:
                    'text-emerald-700',

                dismiss:
                    'hover:bg-emerald-100'
            },

            amber: {
                wrapper:
                    'border-amber-300 bg-amber-50 text-amber-900',

                details:
                    'text-amber-700',

                dismiss:
                    'hover:bg-amber-100'
            },

            orange: {
                wrapper:
                    'border-orange-300 bg-orange-50 text-orange-900',

                details:
                    'text-orange-700',

                dismiss:
                    'hover:bg-orange-100'
            }
        };

        const tone =
            tones[content.tone]
            || tones.green;

        alertContainer
            .classList
            ?.remove('hidden');

        alertContainer.innerHTML = `
            <div class="flex items-start justify-between gap-3 rounded-xl border p-4 shadow-sm ${tone.wrapper}">
                <div>
                    <p
                        class="font-black"
                        data-monitor-alert-title
                    ></p>

                    <p
                        class="mt-1 text-sm"
                        data-monitor-alert-message
                    ></p>

                    ${
                        content.caution
                            ? `
                                <p
                                    class="mt-2 text-sm font-bold"
                                    data-monitor-alert-caution
                                ></p>
                            `
                            : ''
                    }

                    <div
                        class="mt-2 grid gap-1 text-xs ${tone.details}"
                        data-monitor-alert-details
                    ></div>
                </div>

                <button
                    type="button"
                    data-monitor-alert-dismiss
                    class="rounded px-2 py-1 text-sm font-black ${tone.dismiss}"
                    aria-label="Dismiss notification"
                >
                    ×
                </button>
            </div>
        `;

        alertContainer
            .querySelector(
                '[data-monitor-alert-title]'
            )
            .textContent = content.title;

        alertContainer
            .querySelector(
                '[data-monitor-alert-message]'
            )
            .textContent =
                content.disclaimer
                || content.message;

        if (content.caution) {
            alertContainer
                .querySelector(
                    '[data-monitor-alert-caution]'
                )
                .textContent =
                    content.caution;
        }

        const detailsContainer =
            alertContainer.querySelector(
                '[data-monitor-alert-details]'
            );

        detailsContainer.innerHTML =
            content.details
                .map(
                    (detail, index) =>
                        `<p data-monitor-alert-detail-line="${index}"></p>`
                )
                .join('');

        content.details.forEach(
            (detail, index) => {
                detailsContainer
                    .querySelector(
                        `[data-monitor-alert-detail-line="${index}"]`
                    )
                    .textContent = detail;
            }
        );

        alertContainer
            .querySelector(
                '[data-monitor-alert-dismiss]'
            )
            ?.addEventListener(
                'click',
                () => {
                    alertContainer.innerHTML = '';

                    alertContainer
                        .classList
                        ?.add('hidden');
                }
            );
    }

    function issueStatusNotification(
        title,
        body,
        tag
    ) {
        if (
            !notificationsEnabled()
            || notificationPermission()
                !== 'granted'
        ) {
            return;
        }

        try {
            void deliverNotification(
                title,
                {
                    body,
                    tag
                }
            );
        } catch (error) {
            // Notification failure must never
            // affect assessment rendering.
        }
    }

    function issueBrowserNotification(
        bridge,
        result,
        presentation
    ) {
        if (
            !notificationsEnabled()
            || notificationPermission()
                !== 'granted'
        ) {
            return;
        }

        try {
            const content =
                presentation
                || confirmedEntryPresentation(
                    bridge.ticker,
                    result,
                    bridge
                );

            const body = [
                content.disclaimer,

                ...(
                    content.caution
                        ? [content.caution]
                        : []
                ),

                ...content.details.filter(
                    detail =>
                        !detail.startsWith(
                            'Evaluated:'
                        )
                )
            ].join('\n');

            void deliverNotification(
                `${bridge.ticker} Entry Setup Confirmed`,
                {
                    body,

                    tag:
                        `tar-obi-entry-${bridge.bridgeId}`
                }
            );
        } catch (error) {
            // Notification failure must never
            // affect assessment rendering.
        }
    }

    function lifecycleFor(
        bridge,
        now
    ) {
        const lifecycle =
            bridge.lifecycle
            && typeof bridge.lifecycle === 'object'
                ? {
                    ...bridge.lifecycle
                }
                : {
                    status:
                        ACTIVE_STATUS,

                    updatedAt:
                        bridge.createdAt,

                    expiresAt:
                        calculateExpiresAt(
                            bridge.createdAt
                        ),

                    reason:
                        null
                };

        if (!lifecycle.expiresAt) {
            lifecycle.expiresAt =
                calculateExpiresAt(
                    bridge.createdAt
                );
        }

        return lifecycle;
    }

    function isExpired(
        lifecycle,
        now
    ) {
        const expires = Date.parse(
            lifecycle?.expiresAt || ''
        );

        return Number.isFinite(expires)
            && now.getTime() >= expires;
    }

    function commitIfUnchanged(
        raw,
        bridge
    ) {
        if (
            storageGet(STORAGE_KEY)
                !== raw
        ) {
            return false;
        }

        return storageSet(
            STORAGE_KEY,
            JSON.stringify(bridge)
        );
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

        if (
            !current
            || current.bridgeId !== linked.bridgeId
        ) {
            return null;
        }

        const clock = now instanceof Date
            ? now
            : new Date(now);

        let lifecycle = lifecycleFor(
            current,
            clock
        );

        if (
            ['ACTIVE', 'PAUSED'].includes(
                lifecycle.status
            )
            && isExpired(lifecycle, clock)
        ) {
            lifecycle = {
                ...lifecycle,
                status: 'EXPIRED',
                updatedAt: isoNow(clock),
                reason:
                    lifecycle.reason
                    || 'Monitoring period ended at the Taiwan market close.'
            };
        }

        const updated = {
            ...current,

            lifecycle:
                ['ACTIVE', 'PAUSED'].includes(
                    lifecycle.status
                )
                    ? {
                        ...lifecycle,
                        monitorSessionId:
                            MONITOR_SESSION_ID
                    }
                    : lifecycle,

            monitorResult:
                current.monitorResult || null,

            notificationState: {
                lastNotifiedState: null,
                lastNotifiedAt: null,

                ...(
                    current.notificationState
                    || {}
                ),

                entryConfirmation:
                    initialEntryConfirmation(
                        current
                    )
            },

            extensions: {
                ...(
                    current.extensions
                    || {}
                )
            }
        };

        if (
            JSON.stringify(updated)
                !== raw
        ) {
            commitIfUnchanged(
                raw,
                updated
            );
        }

        bridgeApi
            ?.refreshLinkedBridge
            ?.();

        return bridgeApi
            ?.getLinkedBridge
            ?.()
            || null;
    }

    /**
     * Writes one completed, normalized result
     * to the active linked bridge.
     *
     * The method revalidates bridge identity
     * and lifecycle immediately before writing.
     *
     * @param {object} snapshot
     * Completed render snapshot from the existing refresh.
     *
     * @param {Date|number|string} [now]
     * Injectable clock for tests.
     *
     * @returns {{
     *   written: boolean,
     *   notified: boolean,
     *   confirmed?: boolean,
     *   reason?: string,
     *   result?: object
     * }}
     */
    function captureCompletedAssessment(
        snapshot,
        now = new Date()
    ) {
        const linked =
            bridgeApi
                ?.getLinkedBridge
                ?.();

        if (!linked) {
            return {
                written: false,
                notified: false,
                reason: 'standalone'
            };
        }

        const raw =
            storageGet(
                STORAGE_KEY
            );

        const current =
            parseBridge(raw);

        if (!current) {
            return {
                written: false,
                notified: false,
                reason: 'invalid-bridge'
            };
        }

        if (
            current.bridgeId
                !== linked.bridgeId
        ) {
            bridgeApi
                ?.refreshLinkedBridge
                ?.();

            refreshUi();

            return {
                written: false,
                notified: false,
                reason: 'bridge-replaced'
            };
        }

        if (
            String(current.ticker)
                .toUpperCase()
            !== String(
                snapshot?.ticker || ''
            ).toUpperCase()
        ) {
            return {
                written: false,
                notified: false,
                reason: 'ticker-mismatch'
            };
        }

        const clock =
            now instanceof Date
                ? now
                : new Date(now);

        const lifecycle =
            lifecycleFor(
                current,
                clock
            );

        if (
            lifecycle.monitorSessionId
            && lifecycle.monitorSessionId
                !== MONITOR_SESSION_ID
        ) {
            return {
                written: false,
                notified: false,
                reason:
                    'inactive-linked-session'
            };
        }

        if (
            isExpired(
                lifecycle,
                clock
            )
        ) {
            const expired = {
                ...current,

                lifecycle: {
                    ...lifecycle,
                    status: 'EXPIRED',
                    updatedAt: isoNow(clock),

                    reason:
                        lifecycle.reason
                        || 'Monitoring period ended at the Taiwan market close.'
                }
            };

            const expiredStored =
                commitIfUnchanged(
                    raw,
                    expired
                );

            bridgeApi
                ?.refreshLinkedBridge
                ?.();

            if (expiredStored) {
                const result =
                    expired.monitorResult
                    || {
                        assessmentState:
                            'EXPIRED',

                        currentPrice:
                            null,

                        evaluatedAt:
                            expired
                                .lifecycle
                                .updatedAt
                    };

                showInPageAlert(
                    result,
                    'The linked monitor has expired.'
                );

                issueStatusNotification(
                    `${expired.ticker} Monitor Expired`,
                    'The linked monitor reached its Taiwan trading-day expiration.',
                    `tar-obi-expired-${expired.bridgeId}`
                );
            }

            refreshUi();

            return {
                written: false,
                notified: false,
                reason: 'expired'
            };
        }

        if (
            lifecycle.status
                !== ACTIVE_STATUS
        ) {
            return {
                written: false,
                notified: false,

                reason:
                    String(
                        lifecycle.status
                        || 'inactive'
                    ).toLowerCase()
            };
        }

        const previousState =
            current
                .monitorResult
                ?.assessmentState
            || null;

        const result =
            normalizeCompletedAssessment(
                snapshot,
                previousState
            );

        if (!result) {
            return {
                written: false,
                notified: false,
                reason:
                    'incomplete-assessment'
            };
        }

        const storedEvaluation =
            Date.parse(
                current
                    .monitorResult
                    ?.evaluatedAt
                || ''
            );

        const nextEvaluation =
            Date.parse(
                result.evaluatedAt
            );

        if (
            Number.isFinite(
                storedEvaluation
            )
            && Number.isFinite(
                nextEvaluation
            )
            && nextEvaluation
                <= storedEvaluation
        ) {
            return {
                written: false,
                notified: false,
                reason:
                    'stale-assessment'
            };
        }

        const notificationState = {
            ...(
                current.notificationState
                || {}
            ),

            lastNotifiedState:
                current
                    .notificationState
                    ?.lastNotifiedState
                || null,

            lastNotifiedAt:
                current
                    .notificationState
                    ?.lastNotifiedAt
                || null,

            dataUnavailableSince:
                current
                    .notificationState
                    ?.dataUnavailableSince
                || null,

            lastDataUnavailableNotifiedAt:
                current
                    .notificationState
                    ?.lastDataUnavailableNotifiedAt
                || null,

            entryConfirmation:
                initialEntryConfirmation(
                    current
                )
        };

        const previousConfirmation =
            notificationState
                .entryConfirmation;

        const zoneGateEligible = linkedZoneGateEligible(current, result);
        const outsideBridgedZone = priceOutsideBridgedZone(current, result);
        const continuousEligible = zoneGateEligible && result.assessmentState === ENTRY_STATE;
        const previousContinuous = notificationState.continuousValidity || null;
        const nextContinuous = outsideBridgedZone
            ? expiredContinuousValidity()
            : advanceContinuousValidity(previousContinuous, continuousEligible, result.evaluatedAt);
        const nextConfirmation = advanceEntryConfirmation(
            previousConfirmation,
            continuousEligible ? result.assessmentState : 'WAIT_FOR_CONFIRMATION',
            result.evaluatedAt
        );

        const priorNotificationAt = Date.parse(notificationState.lastNotifiedAt || '');
        const shouldNotify = nextContinuous.status === 'LIVE'
            && previousContinuous?.status !== 'LIVE'
            && (!Number.isFinite(priorNotificationAt)
                || Date.parse(result.evaluatedAt) - priorNotificationAt >= NOTIFICATION_COOLDOWN_MS);

        notificationState.entryConfirmation = nextConfirmation;
        notificationState.continuousValidity = nextContinuous;

        let sustainedUnavailable =
            false;

        if (
            result.assessmentState
                === 'DATA_UNAVAILABLE'
        ) {
            notificationState
                .dataUnavailableSince
                ||= result.evaluatedAt;

            const unavailableSince =
                Date.parse(
                    notificationState
                        .dataUnavailableSince
                );

            sustainedUnavailable =
                !notificationState
                    .lastDataUnavailableNotifiedAt
                && Number.isFinite(
                    unavailableSince
                )
                && Date.parse(
                    result.evaluatedAt
                ) - unavailableSince
                    >= DATA_UNAVAILABLE_SUSTAINED_MS;

            if (sustainedUnavailable) {
                notificationState
                    .lastDataUnavailableNotifiedAt =
                        result.evaluatedAt;
            }
        } else {
            notificationState
                .dataUnavailableSince =
                    null;

            notificationState
                .lastDataUnavailableNotifiedAt =
                    null;
        }

        if (shouldNotify) {
            notificationState
                .lastNotifiedState =
                    result.assessmentState;

            notificationState
                .lastNotifiedAt =
                    result.evaluatedAt;
        }

        const updated = {
            ...current,

            lifecycle: {
                ...lifecycle,
                status: ACTIVE_STATUS,
                updatedAt: isoNow(clock)
            },

            monitorResult:
                result,

            notificationState
        };

        if (
            !commitIfUnchanged(
                raw,
                updated
            )
        ) {
            return {
                written: false,
                notified: false,
                reason:
                    'concurrent-update'
            };
        }

        bridgeApi
            ?.refreshLinkedBridge
            ?.();

        if (shouldNotify) {
            const presentation =
                confirmedEntryPresentation(
                    updated.ticker,
                    result,
                    updated
                );

            showInPageAlert(
                result,
                undefined,
                presentation
            );

            issueBrowserNotification(
                updated,
                result,
                presentation
            );
        } else if (
            sustainedUnavailable
        ) {
            showInPageAlert(
                result,
                'Market data has remained unavailable for at least five minutes.'
            );

            issueStatusNotification(
                `${updated.ticker} Data Unavailable`,
                'TAR-OBI market data has remained unavailable for at least five minutes.',
                `tar-obi-data-${updated.bridgeId}`
            );
        }

        refreshUi();

        return {
            written: true,
            notified: shouldNotify,

            confirmed: nextContinuous.status === 'LIVE',
            continuousValidity: nextContinuous,

            confirmation:
                nextConfirmation,

            result
        };
    }

    /**
     * Changes the lifecycle of the currently linked bridge
     * without changing setup context.
     *
     * @param {'ACTIVE'|'PAUSED'|'COMPLETED'} nextStatus
     * User-selected status.
     *
     * @param {Date|number|string} [now]
     * Injectable clock for tests.
     *
     * @returns {boolean}
     * True when the transition was stored.
     */
    function transitionLifecycle(
        nextStatus,
        now = new Date()
    ) {
        if (
            ![
                'ACTIVE',
                'PAUSED',
                'COMPLETED'
            ].includes(nextStatus)
        ) {
            return false;
        }

        const linked =
            bridgeApi
                ?.getLinkedBridge
                ?.();

        const raw =
            storageGet(
                STORAGE_KEY
            );

        const current =
            parseBridge(raw);

        if (
            !linked
            || !current
            || current.bridgeId
                !== linked.bridgeId
        ) {
            return false;
        }

        const lifecycle =
            lifecycleFor(
                current,

                now instanceof Date
                    ? now
                    : new Date(now)
            );

        const allowed =
            (
                nextStatus === 'PAUSED'
                && lifecycle.status
                    === 'ACTIVE'
            )
            || (
                nextStatus === 'ACTIVE'
                && lifecycle.status
                    === 'PAUSED'
            )
            || (
                nextStatus === 'COMPLETED'
                && [
                    'ACTIVE',
                    'PAUSED'
                ].includes(
                    lifecycle.status
                )
            );

        if (!allowed) {
            return false;
        }

        const timestamp =
            isoNow(now);

        const updated = {
            ...current,

            lifecycle: {
                ...lifecycle,
                status: nextStatus,
                updatedAt: timestamp,

                completedAt:
                    nextStatus === 'COMPLETED'
                        ? timestamp
                        : lifecycle.completedAt
                            || null,

                reason:
                    nextStatus === 'COMPLETED'
                        ? 'Monitoring ended by user.'
                        : null
            }
        };

        const stored =
            commitIfUnchanged(
                raw,
                updated
            );

        if (stored) {
            bridgeApi
                ?.refreshLinkedBridge
                ?.();

            void syncMobileSupport();
            refreshUi();
        }

        return stored;
    }

    /**
     * Requests Browser Notification permission
     * after an explicit user action.
     *
     * @returns {Promise<string>}
     * Resulting permission or unsupported.
     */
    async function enableNotifications() {
        if (
            !('Notification' in root)
            || typeof root
                .Notification
                .requestPermission
                !== 'function'
        ) {
            storageSet(
                NOTIFICATION_PREFERENCE_KEY,
                'false'
            );

            refreshUi();

            return 'unsupported';
        }

        try {
            const permission =
                await root
                    .Notification
                    .requestPermission();
            storageSet(
                NOTIFICATION_PREFERENCE_KEY,
                permission === 'granted'
                    ? 'true'
                    : 'false'
            );

            if (permission === 'granted') {
                await deliverNotification(
                    'TAR-OBI Notifications Enabled',
                    {
                        body: 'Android-compatible browser notifications are ready.',
                        tag: 'tar-obi-notification-test'
                    }
                );
            }

            refreshUi();

            return permission;
        } catch (error) {
            storageSet(
                NOTIFICATION_PREFERENCE_KEY,
                'false'
            );

            refreshUi();

            return 'denied';
        }
    }

    function formatTime(value) {
        if (
            !value
            || !Number.isFinite(
                Date.parse(value)
            )
        ) {
            return 'Unavailable';
        }

        return new Date(value)
            .toLocaleString(
                'zh-TW',
                {
                    timeZone:
                        'Asia/Taipei',

                    hour12:
                        false
                }
            );
    }

   function entryModeLabel(mode) {
          if (mode === 'left_side_starter') {
             return 'Left-Side Starter';
           }

         if (mode === 'confirmed') {
           return 'Confirmed / Right-Side';
          }

          return 'Pending / Intraday Monitoring';
  }
    function starterStatusLabel(
        bridge,
        result
    ) {
        if (
            bridge?.starterExecuted
                === true
            || result?.starterExecuted
                === true
        ) {
            return 'Executed';
        }

        if (
            bridge?.starterEligible
                === true
            || result?.starterEligible
                === true
        ) {
            return 'Eligible';
        }

        return 'Not Eligible';
    }

    function starterAllocationLabel(
        bridge,
        result
    ) {
        const value =
            optionalNumber(
                result?.starterAllocationPct
                ?? bridge?.starterAllocationPct
            );

        return value === null
            ? 'Unavailable'
            : `${value}%`;
    }

    function refreshUi() {
        if (
            typeof onUiRefresh
                === 'function'
        ) {
            onUiRefresh();
        } else if (
            controlsContainer
        ) {
            renderControls(
                controlsContainer
            );
        }
    }

    /**
     * Renders the compact Linked Monitor
     * status and controls.
     *
     * @param {HTMLElement|null} container
     * Monitor slot in the Execution Context panel.
     *
     * @returns {void}
     */
    function renderControls(container) {
        if (!container) return;

        controlsContainer =
            container;

        const bridge =
            bridgeApi
                ?.getLinkedBridge
                ?.();

        if (!bridge) {
            container.innerHTML = '';
            return;
        }

        const lifecycle =
            lifecycleFor(
                bridge,
                new Date()
            );

        const result =
            bridge.monitorResult
            || null;

        const entryConfirmation =
            initialEntryConfirmation(
                bridge
            );

        const linkedZoneExpired =
            linkedZoneUnavailable(
                bridge
            );

        const linkedZoneExpiredLabel =
            'EXPIRED — no valid ETF_DCA Active Long Zone';
        const permission =
            notificationPermission();

        const notificationUi =
            notificationUiState(
                permission,
                notificationsEnabled()
            );

        const notificationControl =
            notificationUi.actionable
                ? `
                    <button
                        type="button"
                        data-monitor-action="notify"
                        class="rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-bold text-blue-700 hover:bg-blue-50"
                    >
                        ${notificationUi.label}
                    </button>
                `
                : `
                    <button
                        type="button"
                        disabled
                        aria-disabled="true"
                        data-monitor-notification-status
                        class="cursor-default rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600"
                    >
                        ${notificationUi.label}
                    </button>
                `;

        const pauseAction =
            lifecycle.status
                === 'PAUSED'
                ? 'resume'
                : 'pause';

        const activeControl =
            [
                'ACTIVE',
                'PAUSED'
            ].includes(
                lifecycle.status
            );

        container.innerHTML = `
            <div class="mt-4 border-t border-blue-200 pt-4">
                <p class="text-xs font-black tracking-wider text-blue-600">
                    LINKED MONITOR
                </p>

                <dl class="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-3">
                    <div>
                        <dt class="text-xs text-slate-500">
                            Lifecycle
                        </dt>

                        <dd
                            data-monitor-field="lifecycle"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>

                    <div>
                        <dt class="text-xs text-slate-500">
                            Assessment
                        </dt>

                        <dd
                            data-monitor-field="assessment"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>

                    <div>
                        <dt class="text-xs text-slate-500">
                            Entry Confirmation
                        </dt>

                        <dd
                            data-monitor-field="entry-confirmation"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>

                    <div>
                        <dt class="text-xs text-slate-500">Live Confirmation</dt>
                        <dd data-monitor-field="continuous-validity" class="mt-1 font-bold"></dd>
                    </div>                    <div>
                        <dt class="text-xs text-slate-500">
                            Entry Mode
                        </dt>

                        <dd
                            data-monitor-field="entry-mode"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>

                    <div data-monitor-starter>
                        <dt class="text-xs text-slate-500">
                            Starter Status
                        </dt>

                        <dd
                            data-monitor-field="starter-status"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>

                    <div data-monitor-starter>
                        <dt class="text-xs text-slate-500">
                            Starter Allocation
                        </dt>

                        <dd
                            data-monitor-field="starter-allocation"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>

                    <div>
                        <dt class="text-xs text-slate-500">
                            Current Price
                        </dt>

                        <dd
                            data-monitor-field="price"
                            class="mt-1 font-mono font-bold"
                        ></dd>
                    </div>

                    <div>
                        <dt class="text-xs text-slate-500">
                            Last Evaluated
                        </dt>

                        <dd
                            data-monitor-field="evaluated"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>

                    <div>
                        <dt class="text-xs text-slate-500">
                            Notifications
                        </dt>

                        <dd
                            data-monitor-field="notifications"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>

                    <div>
                        <dt class="text-xs text-slate-500">
                            Screen Awake
                        </dt>

                        <dd
                            data-monitor-field="screen-awake"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>

                    <div>
                        <dt class="text-xs text-slate-500">
                            Last Notification
                        </dt>

                        <dd
                            data-monitor-field="last-notification"
                            class="mt-1 font-bold"
                        ></dd>
                    </div>
                </dl>
                ${
                    linkedZoneExpired
                        ? `<p data-monitor-zone-gate-note class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">Raw TAR-OBI Assessment is independent and is not an actionable linked signal while no valid ETF_DCA Active Long Zone is available.</p>`
                        : ''
                }

                <div class="mt-3">
                    <div class="flex flex-wrap gap-2">
                        <label class="text-xs text-slate-600">Valid for <select data-monitor-continuity class="ml-1 rounded border border-slate-300 bg-white px-1 py-1 font-bold"><option value="30">30s</option><option value="60">60s</option><option value="90">90s</option><option value="120">120s</option></select></label>
                        ${notificationControl}

                        ${
                            activeControl
                                ? `
                                    <button
                                        type="button"
                                        data-monitor-action="${pauseAction}"
                                        class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
                                    >
                                        ${
                                            pauseAction
                                                === 'pause'
                                                ? 'Pause Monitor'
                                                : 'Resume Monitor'
                                        }
                                    </button>
                                `
                                : ''
                        }

                        ${
                            activeControl
                                ? `
                                    <button
                                        type="button"
                                        data-monitor-action="complete"
                                        class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
                                    >
                                        End Monitor
                                    </button>
                                `
                                : ''
                        }
                    </div>

                    <p class="mt-2 text-xs text-slate-500">
                        Suggested Buy — LIVE requires the existing completed TAR-OBI conditions, a valid linked Active Zone (automatically confirmed or an explicit Manual Active Zone override), and uninterrupted validity for the selected duration. Any failed or stale condition resets the timer.
                    </p>
                </div>

                <p class="mt-3 text-xs text-slate-500">
                    Monitoring requires this page to remain open. Mobile operating systems may suspend background pages.
                </p>
            </div>
        `;

        const values = {
            lifecycle:
                lifecycle.status
                || 'ACTIVE',

            assessment:
                result
                    ?.assessmentState
                || 'Not evaluated',

            'entry-confirmation': linkedZoneExpired ? linkedZoneExpiredLabel : entryConfirmationLabel(entryConfirmation),
            'continuous-validity': linkedZoneExpired ? linkedZoneExpiredLabel : continuousValidityLabel(bridge.notificationState?.continuousValidity, result),

            'entry-mode':
                entryModeLabel(
                      bridge.entryMode
                      || result?.entryMode
                      || 'pending'
                 ),
            'starter-status':
                starterStatusLabel(
                    bridge,
                    result
                ),

            'starter-allocation':
                starterAllocationLabel(
                    bridge,
                    result
                ),

            price:
                result?.currentPrice
                ?? 'Unavailable',

            evaluated:
                formatTime(
                    result?.evaluatedAt
                ),

            notifications:
                notificationUi.status,

            'screen-awake':
                screenWakeLockUiStatus(lifecycle),

            'last-notification':
                formatTime(
                    bridge
                        .notificationState
                        ?.lastNotifiedAt
                )
        };

        Object.entries(values)
            .forEach(
                ([field, value]) => {
                    const element =
                        container
                            .querySelector(
                                `[data-monitor-field="${field}"]`
                            );

                    if (element) {
                        element.textContent =
                            value;
                    }
                }
            );

       const starterMode =
              (
                    bridge.entryMode
                    || result?.entryMode
                    || 'pending'
               ) === 'left_side_starter';

        container
            .querySelectorAll(
                '[data-monitor-starter]'
            )
            .forEach(
                element => {
                    element
                        .classList
                        .toggle(
                            'hidden',
                            !starterMode
                        );
                }
            );

        const durationControl = container.querySelector('[data-monitor-continuity]');
        if (durationControl) {
            durationControl.value = String(continuityDurationSeconds());
            durationControl.addEventListener('change', () => {
                setContinuityDuration(durationControl.value);
                refreshUi();
            });
        }
        container
            .querySelector(
                '[data-monitor-action="notify"]'
            )
            ?.addEventListener(
                'click',
                enableNotifications
            );

        container
            .querySelector(
                '[data-monitor-action="pause"]'
            )
            ?.addEventListener(
                'click',
                () => transitionLifecycle(
                    'PAUSED'
                )
            );

        container
            .querySelector(
                '[data-monitor-action="resume"]'
            )
            ?.addEventListener(
                'click',
                () => transitionLifecycle(
                    'ACTIVE'
                )
            );

        container
            .querySelector(
                '[data-monitor-action="complete"]'
            )
            ?.addEventListener(
                'click',
                () => transitionLifecycle(
                    'COMPLETED'
                )
            );
    }

    function handleStorageEvent(event) {
        if (
            event.key
                !== STORAGE_KEY
        ) {
            return;
        }

        const before =
            bridgeApi
                ?.getLinkedBridge
                ?.();

        bridgeApi
            ?.refreshLinkedBridge
            ?.();

        const after =
            bridgeApi
                ?.getLinkedBridge
                ?.();

        if (
            before
            && after
            && before.bridgeId
                === after.bridgeId
        ) {
            const nextStatus =
                after.lifecycle?.status
                || ACTIVE_STATUS;

            if (
                observedLifecycle
                && nextStatus
                    !== observedLifecycle
                && TERMINAL_STATUSES
                    .includes(
                        nextStatus
                    )
            ) {
                const result =
                    after.monitorResult
                    || {
                        assessmentState:
                            nextStatus,

                        currentPrice:
                            null,

                        evaluatedAt:
                            after.lifecycle?.updatedAt
                            || isoNow()
                    };

                showInPageAlert(
                    result,
                    `Bridge lifecycle changed to ${nextStatus.toLowerCase()}.`
                );

                issueStatusNotification(
                    `${after.ticker} Monitor ${nextStatus}`,

                    `The linked monitor lifecycle changed to ${nextStatus.toLowerCase()}.`,

                    `tar-obi-lifecycle-${after.bridgeId}-${nextStatus}`
                );
            }

            observedLifecycle =
                nextStatus;
        }

        void syncMobileSupport();
        refreshUi();
    }

    /**
     * Connects the monitor adapter
     * to the existing Phase 2 loader
     * and UI containers.
     *
     * @param {{
     *   bridgeApi: object,
     *   alertContainer?: HTMLElement,
     *   onUiRefresh?: Function
     * }} options
     *
     * Host dependencies.
     *
     * @returns {void}
     */
    function mount(options = {}) {
        bridgeApi =
            options.bridgeApi
            || root.TarObiBridge
            || bridgeApi;

        alertContainer =
            options.alertContainer
            || alertContainer;

        onUiRefresh =
            options.onUiRefresh
            || onUiRefresh;

        void root.TarObiMobileSupport
            ?.prepareNotifications
            ?.();

        reconcileLinkedLifecycle();

        observedLifecycle =
            bridgeApi
                ?.getLinkedBridge
                ?.()
                ?.lifecycle
                ?.status
            || ACTIVE_STATUS;

        if (
            !storageListenerBound
            && typeof root.addEventListener
                === 'function'
        ) {
            storageListenerBound =
                true;

            root.addEventListener(
                'storage',
                handleStorageEvent
            );
        }

        if (!mobileListenerBound) {
            mobileListenerBound = true;
            root.document?.addEventListener?.(
                'visibilitychange',
                () => void syncMobileSupport()
            );
            root.addEventListener?.(
                'pagehide',
                () => void root.TarObiMobileSupport
                    ?.releaseScreenWakeLock
                    ?.()
            );
        }

        void syncMobileSupport();
    }

    return Object.freeze({
        STORAGE_KEY,
        NOTIFICATION_PREFERENCE_KEY,
        CONTRACT_VERSION,
        NOTIFICATION_COOLDOWN_MS,
        DATA_UNAVAILABLE_SUSTAINED_MS,
        ENTRY_STATE,
        ENTRY_CONFIRMATION_REQUIRED,
        CONTINUITY_DURATION_KEY,
        DEFAULT_CONTINUITY_SECONDS,
        ENTRY_CONFIRMATION_STATUS,
        calculateExpiresAt,
        notificationUiState,
        advanceEntryConfirmation,
        continuityDurationSeconds,
        setContinuityDuration,
        advanceContinuousValidity,
        linkedZoneGateEligible,
        priceOutsideBridgedZone,
        finalActionContext,
        normalizeCompletedAssessment,
        reconcileLinkedLifecycle,
        captureCompletedAssessment,
        transitionLifecycle,
        enableNotifications,
        syncMobileSupport,
        renderControls,
        mount
    });
});
