(function (global) {
    'use strict';

    const OBI_THRESHOLD = 0.20;
    const CORE_TAR_STRONG_THRESHOLD = 0.10;
    const DETAILED_TAR_STRONG_BID = 0.40;
    const DETAILED_TAR_BID_BIASED = 0.20;
    const DETAILED_TAR_NEUTRAL_LOWER = -0.10;
    const DETAILED_TAR_ASK_BIASED = -0.20;
    const VWAP_NEAR_THRESHOLD = 0.0005;

    function calculateTarObi(askPrints, bidPrints, bidQty, askQty) {
        const totalPrints = askPrints + bidPrints;
        const totalBook = bidQty + askQty;

        if (totalPrints <= 0 || totalBook <= 0) {
            return null;
        }

        const tarAskPct = askPrints / totalPrints;
        const tarBidPct = bidPrints / totalPrints;
        const tarIndex = tarAskPct - tarBidPct;

        const obiBidPct = bidQty / totalBook;
        const obiAskPct = askQty / totalBook;
        const obiIndex = obiBidPct - obiAskPct;

        const obiKey =
            obiIndex > OBI_THRESHOLD
                ? 'Bid-heavy OBI'
                : obiIndex < -OBI_THRESHOLD
                    ? 'Ask-heavy OBI'
                    : 'Balanced OBI';

        const detTarKey =
            tarIndex >= DETAILED_TAR_STRONG_BID
                ? 'Strong Bid TAR'
                : tarIndex >= DETAILED_TAR_BID_BIASED
                    ? 'Bid-biased TAR'
                    : tarIndex > DETAILED_TAR_NEUTRAL_LOWER
                        ? 'Neutral TAR'
                        : tarIndex > DETAILED_TAR_ASK_BIASED
                            ? 'Ask-biased TAR'
                            : 'Strong Ask TAR';

        const coreTarKey =
            tarIndex >= CORE_TAR_STRONG_THRESHOLD
                ? 'Strong Bullish'
                : tarIndex <= -CORE_TAR_STRONG_THRESHOLD
                    ? 'Strong Bearish'
                    : 'Neutral';

        const coreObiKey =
            obiIndex > OBI_THRESHOLD
                ? 'Buy-heavy'
                : obiIndex < -OBI_THRESHOLD
                    ? 'Ask-heavy'
                    : 'Balanced';

        return {
            totalPrints,
            totalBook,
            tarAskPct,
            tarBidPct,
            tarIndex,
            obiBidPct,
            obiAskPct,
            obiIndex,
            obiKey,
            detTarKey,
            coreTarKey,
            coreObiKey
        };
    }

    function getTarContext(detTarKey) {
        if (
            detTarKey === 'Strong Bid TAR'
            || detTarKey === 'Bid-biased TAR'
        ) {
            return 'Buyer Active';
        }

        if (
            detTarKey === 'Strong Ask TAR'
            || detTarKey === 'Ask-biased TAR'
        ) {
            return 'Seller Active';
        }

        return detTarKey
            ? 'Balanced'
            : 'Unavailable';
    }

    function getObiContext(obiKey) {
        if (obiKey === 'Bid-heavy OBI') {
            return 'Bid Dominant';
        }

        if (obiKey === 'Ask-heavy OBI') {
            return 'Ask Dominant';
        }

        return obiKey
            ? 'Balanced'
            : 'Unavailable';
    }

    function getVwap(quote) {
        if (!quote) {
            return null;
        }

        const lastPrice =
            quote.lastPrice
            ?? quote.closePrice
            ?? null;

        let vwap =
            quote.avgPrice
            ?? null;

        if (
            vwap == null
            && quote.total?.tradeValue > 0
            && quote.total?.tradeVolume > 0
        ) {
            vwap =
                quote.total.tradeValue
                / quote.total.tradeVolume;

            if (
                lastPrice
                && vwap / lastPrice > 100
            ) {
                vwap /= 1000;
            }
        }

        return Number.isFinite(vwap)
            && vwap > 0
            ? vwap
            : null;
    }

    function getVwapPosition(price, vwap) {
        if (
            !Number.isFinite(price)
            || !Number.isFinite(vwap)
            || vwap <= 0
        ) {
            return 'Unavailable';
        }

        const deviation =
            (price - vwap) / vwap;

        return deviation > VWAP_NEAR_THRESHOLD
            ? 'Above VWAP'
            : deviation < -VWAP_NEAR_THRESHOLD
                ? 'Below VWAP'
                : 'Near VWAP';
    }

    function timestampToMs(value) {
        const number = Number(value);

        if (
            !Number.isFinite(number)
            || number <= 0
        ) {
            return null;
        }

        if (number > 1e14) {
            return Math.floor(number / 1000);
        }

        if (number > 1e11) {
            return Math.floor(number);
        }

        return Math.floor(number * 1000);
    }

    function getMarketSession(
        quote,
        refreshMs,
        now = new Date()
    ) {
        if (!quote) {
            return 'unavailable';
        }

        const parts =
            new Intl.DateTimeFormat(
                'en-CA',
                {
                    timeZone: 'Asia/Taipei',
                    hour12: false,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    weekday: 'short'
                }
            ).formatToParts(now);

        const values =
            Object.fromEntries(
                parts.map(
                    item => [
                        item.type,
                        item.value
                    ]
                )
            );

        const today =
            `${values.year}-${values.month}-${values.day}`;

        const minute =
            Number(values.hour) * 60
            + Number(values.minute);

        if (
            values.weekday === 'Sat'
            || values.weekday === 'Sun'
        ) {
            return 'closed';
        }

        if (minute < 540) {
            return 'preopen';
        }

        if (minute >= 810) {
            return 'closed';
        }

        const updatedMs =
            timestampToMs(
                quote.lastUpdated
                || quote.lastTrade?.time
                || quote.closeTime
            );

        if (!updatedMs) {
            return 'unavailable';
        }

        if (
            quote.date !== today
            || quote.isClose
        ) {
            return 'stale';
        }

        return now.getTime() - updatedMs
            > Math.max(
                90000,
                refreshMs * 2 + 15000
            )
            ? 'stale'
            : 'live';
    }

    function calculateVolumeQuality(
        candleResponse,
        referenceTimestamp,
        session = 'live'
    ) {
        const unavailable = reason => ({
            quality: 'Unavailable',
            ratio: null,
            latestVolume: null,
            medianVolume: null,
            sampleCount: 0,
            reason
        });

        if (
            session === 'stale'
            || session === 'unavailable'
            || session === 'preopen'
        ) {
            return unavailable(
                'Market data unavailable'
            );
        }

        const referenceMs =
            timestampToMs(
                referenceTimestamp
            );

        if (!referenceMs) {
            return unavailable(
                'Reference timestamp unavailable'
            );
        }

        const candles =
            Array.isArray(
                candleResponse?.data
            )
                ? candleResponse.data
                : [];

        const taipeiParts = value => {
            const parts =
                new Intl.DateTimeFormat(
                    'en-CA',
                    {
                        timeZone:
                            'Asia/Taipei',

                        hour12:
                            false,

                        year:
                            'numeric',

                        month:
                            '2-digit',

                        day:
                            '2-digit',

                        hour:
                            '2-digit',

                        minute:
                            '2-digit'
                    }
                ).formatToParts(
                    new Date(value)
                );

            return Object.fromEntries(
                parts.map(
                    item => [
                        item.type,
                        item.value
                    ]
                )
            );
        };

        const completed =
            candles
                .map(candle => {
                    const startMs =
                        Date.parse(
                            candle?.date
                        );

                    const volume =
                        Number(
                            candle?.volume
                        );

                    if (
                        !Number.isFinite(startMs)
                        || !Number.isFinite(volume)
                        || volume < 0
                    ) {
                        return null;
                    }

                    const parts =
                        taipeiParts(startMs);

                    if (
                        parts.hour === '09'
                        && parts.minute === '00'
                    ) {
                        return null;
                    }

                    if (
                        startMs
                        + 5 * 60 * 1000
                        > referenceMs
                    ) {
                        return null;
                    }

                    return {
                        startMs,
                        volume,

                        marketDate:
                            `${parts.year}-${parts.month}-${parts.day}`
                    };
                })
                .filter(Boolean)
                .sort(
                    (a, b) =>
                        a.startMs
                        - b.startMs
                );

        if (!completed.length) {
            return unavailable(
                'No completed 5-minute candles'
            );
        }

        const latest =
            completed[
                completed.length - 1
            ];

        if (
            referenceMs
            - (
                latest.startMs
                + 5 * 60 * 1000
            )
            > 6 * 60 * 1000
        ) {
            return unavailable(
                'Latest completed candle is stale'
            );
        }

        const sameDay =
            completed.filter(
                candle =>
                    candle.marketDate
                    === latest.marketDate
            );

        if (sameDay.length < 5) {
            return unavailable(
                'At least five completed candles required'
            );
        }

        const baseline =
            sameDay
                .slice(0, -1)
                .map(
                    candle =>
                        candle.volume
                )
                .sort(
                    (a, b) =>
                        a - b
                );

        const middle =
            Math.floor(
                baseline.length / 2
            );

        const medianVolume =
            baseline.length % 2
                ? baseline[middle]
                : (
                    baseline[middle - 1]
                    + baseline[middle]
                ) / 2;

        if (
            !Number.isFinite(
                medianVolume
            )
            || medianVolume <= 0
        ) {
            return unavailable(
                'Baseline volume unavailable'
            );
        }

        const ratio =
            latest.volume
            / medianVolume;

        const quality =
            ratio < 0.60
                ? 'Low'
                : ratio < 1.40
                    ? 'Normal'
                    : ratio < 2.00
                        ? 'Expanding'
                        : 'Heavy';

        return {
            quality,
            ratio,

            latestVolume:
                latest.volume,

            medianVolume,

            sampleCount:
                baseline.length,

            reason:
                null
        };
    }

    function inferTickSize(quote) {
        const prices = [
            ...(quote?.bids || []),
            ...(quote?.asks || [])
        ]
            .map(
                level =>
                    Number(level.price)
            )
            .filter(
                price =>
                    Number.isFinite(price)
                    && price > 0
            );

        const unique = [
            ...new Set(prices)
        ].sort(
            (a, b) =>
                a - b
        );

        let minimum =
            Infinity;

        for (
            let index = 1;
            index < unique.length;
            index += 1
        ) {
            const difference =
                Number(
                    (
                        unique[index]
                        - unique[index - 1]
                    ).toFixed(4)
                );

            if (
                difference > 0
                && difference < minimum
            ) {
                minimum =
                    difference;
            }
        }

        if (
            Number.isFinite(minimum)
        ) {
            return minimum;
        }

        const price =
            quote?.lastPrice
            ?? quote?.closePrice;

        if (
            !Number.isFinite(price)
        ) {
            return null;
        }

        return price < 10
            ? 0.01
            : price < 50
                ? 0.05
                : price < 100
                    ? 0.1
                    : price < 500
                        ? 0.5
                        : price < 1000
                            ? 1
                            : 5;
    }

    function roundToTick(
        value,
        tick,
        direction = 'nearest'
    ) {
        if (
            !Number.isFinite(value)
            || !Number.isFinite(tick)
            || tick <= 0
        ) {
            return null;
        }

        const units =
            value / tick;

        const rounded =
            direction === 'down'
                ? Math.floor(
                    units + 1e-9
                )
                : direction === 'up'
                    ? Math.ceil(
                        units - 1e-9
                    )
                    : Math.round(units);

        return Number(
            (
                rounded * tick
            ).toFixed(8)
        );
    }

    function calculateEntryAssessment(input) {
        const price =
            Number(input.current);

        const bid =
            Number(input.bid);

        const ask =
            Number(input.ask);

        const vwap =
            Number(input.vwap);

        const tick =
            Number(input.tick);

        const hasPrice =
            Number.isFinite(price)
            && price > 0;

        const hasBid =
            Number.isFinite(bid)
            && bid > 0;

        const hasAsk =
            Number.isFinite(ask)
            && ask > 0;

        const hasVwap =
            Number.isFinite(vwap)
            && vwap > 0;

        const hasTick =
            Number.isFinite(tick)
            && tick > 0;

        const session =
            input.session
            || 'unavailable';

        const entryBasis =
            input.entryBasis
            || 'combined';

        const invalidationBasis =
            input.invalidationBasis
            || 'match';

        const tar =
            input.tar
            || 'Unavailable';

        const obi =
            input.obi
            || 'Unavailable';

        const executionContext =
            input.executionContext
            && typeof input.executionContext
                === 'object'
                ? input.executionContext
                : null;

        const entryMode =
            executionContext?.entryMode
                === 'left_side_starter'
                ? 'left_side_starter'
                : 'confirmed';

        const tradingLower =
            hasBid
                ? bid
                : hasAsk
                    ? ask
                    : null;

        const tradingUpper =
            hasAsk
                ? ask
                : hasBid
                    ? bid
                    : null;

        const unavailable = value => ({
            state:
                'DATA UNAVAILABLE',

            confidence:
                'Low',

            lower:
                null,

            upper:
                null,

            maximum:
                null,

            invalidation:
                null,

            tradingLower,

            tradingUpper,

            factors:
                [value]
        });

        if (
            !hasPrice
            || !hasTick
            || !input.timestamp
            || [
                'unavailable',
                'stale'
            ].includes(session)
        ) {
            return unavailable(
                session === 'stale'
                    ? 'Data stale'
                    : 'Critical market data unavailable'
            );
        }

        if (
            tar === 'Unavailable'
            || obi === 'Unavailable'
        ) {
            return unavailable(
                'Essential TAR or OBI data unavailable'
            );
        }

        if (
            entryBasis === 'bidAsk'
            && !hasBid
            && !hasAsk
        ) {
            return unavailable(
                'Bid and ask unavailable'
            );
        }

        if (
            entryBasis === 'vwap'
            && !hasVwap
        ) {
            return unavailable(
                'VWAP unavailable for selected basis'
            );
        }

        if (
            entryBasis === 'combined'
            && (
                !hasVwap
                || (
                    !hasBid
                    && !hasAsk
                )
            )
        ) {
            return unavailable(
                'Combined basis anchors unavailable'
            );
        }

        const spread =
            hasBid
            && hasAsk
            && ask >= bid
                ? ask - bid
                : null;

        const vwapDifference =
            hasVwap
                ? price - vwap
                : null;

        const vwapPercent =
            hasVwap
                ? vwapDifference / vwap
                : null;

        const extensionThreshold =
            hasVwap
                ? Math.max(
                    vwap * 0.003,
                    4 * tick
                )
                : null;

        const materialExtension =
            hasVwap
            && vwapDifference
                > extensionThreshold;

        const openingContext =
            input.openingContext;

        const previousClose =
            Number(openingContext?.previousClose);

        const openPrice =
            Number(openingContext?.openPrice);

        const marketDate =
            openingContext?.marketDate;

        const openTimestamp =
            timestampToMs(openingContext?.openTime)
            || Date.parse(
                `${marketDate}T09:00:00+08:00`
            );

        const candleMs =
            5 * 60 * 1000;

        const openingCandleStart =
            Number.isFinite(openTimestamp)
                ? Math.floor(openTimestamp / candleMs)
                    * candleMs
                : null;

        const largeOpeningGap =
            Number.isFinite(previousClose)
            && previousClose > 0
            && Number.isFinite(openPrice)
            && openPrice > previousClose
            && hasVwap
            && openPrice - previousClose
                > extensionThreshold;

        const completedOpeningCandles =
            new Set(
                (
                    Array.isArray(openingContext?.candles?.data)
                        ? openingContext.candles.data
                        : []
                )
                    .map(candle => Date.parse(candle?.date))
                    .filter(start =>
                        Number.isFinite(start)
                        && Number.isFinite(openingCandleStart)
                        && start >= openingCandleStart
                        && start < openingCandleStart
                            + 5 * candleMs
                        && start + candleMs
                            <= input.timestamp
                    )
            );

        const openingPeriodComplete =
            completedOpeningCandles.size >= 5
            || (
                Number.isFinite(openTimestamp)
                && input.timestamp >= openTimestamp
                    + 6 * candleMs
            );

        const openingExtension =
            largeOpeningGap
            && Number.isFinite(openTimestamp)
            && !openingPeriodComplete;

        let lower;
        let upper;

        if (materialExtension) {
            const pullbackWidth =
                Math.max(
                    2 * tick,

                    Math.min(
                        Number.isFinite(
                            spread
                        )
                            ? spread
                            : 0,

                        3 * tick
                    )
                );

            lower =
                vwap - tick;

            upper =
                vwap + pullbackWidth;
        } else if (
            entryBasis === 'bidAsk'
        ) {
            lower =
                hasBid
                    ? bid
                    : ask;

            upper =
                hasAsk
                    ? ask
                    : bid;
        } else if (
            entryBasis === 'vwap'
        ) {
            lower =
                vwap - tick;

            upper =
                vwap + tick;
        } else if (
            entryBasis === 'current'
        ) {
            lower =
                price - tick;

            upper =
                price;
        } else {
            const marketLower =
                hasBid
                    ? bid
                    : ask;

            const marketUpper =
                hasAsk
                    ? ask
                    : bid;

            const widthCap =
                Math.max(
                    2 * tick,

                    Number.isFinite(
                        spread
                    )
                        ? spread
                        : 0
                );

            lower =
                Math.min(
                    marketLower,
                    vwap
                );

            upper =
                Math.max(
                    marketUpper,
                    vwap
                );

            if (
                upper - lower
                > widthCap
            ) {
                lower =
                    marketLower;

                upper =
                    Math.max(
                        marketUpper,
                        marketLower
                            + widthCap
                    );
            }
        }

        lower =
            roundToTick(
                lower,
                tick,
                'down'
            );

        const baseUpper =
            roundToTick(
                upper,
                tick,
                'up'
            );

        const tarScore =
            tar === 'Buyer Active'
                ? 1
                : tar === 'Seller Active'
                    ? -1
                    : 0;

        const obiScore =
            obi === 'Bid Dominant'
                ? 1
                : obi === 'Ask Dominant'
                    ? -1
                    : 0;

        const netScore =
            tarScore + obiScore;

        const wideSpread =
            Number.isFinite(spread)
            && spread
                > 3 * tick + 1e-9;

        const appliedScore =
            materialExtension
            && netScore > 0
                ? 0
                : netScore;

        upper =
            roundToTick(
                Math.max(
                    lower,

                    baseUpper
                    + appliedScore * tick
                ),

                tick,

                appliedScore < 0
                    ? 'down'
                    : 'up'
            );

        const maximum =
            roundToTick(
                Math.max(
                    upper,

                    baseUpper
                    + Math.max(
                        0,
                        appliedScore
                    ) * tick
                ),

                tick,
                'up'
            );

        let anchor;

        let resolvedInvalidation =
            invalidationBasis;

        if (
            resolvedInvalidation
                === 'match'
        ) {
            resolvedInvalidation =
                entryBasis;
        }

        if (
            resolvedInvalidation
                === 'bidAsk'
        ) {
            anchor =
                hasBid
                    ? bid
                    : null;
        } else if (
            resolvedInvalidation
                === 'vwap'
        ) {
            anchor =
                hasVwap
                    ? vwap
                    : null;
        } else if (
            resolvedInvalidation
                === 'range'
        ) {
            anchor =
                lower;
        } else if (
            resolvedInvalidation
                === 'current'
        ) {
            anchor =
                price;
        } else if (
            resolvedInvalidation
                === 'combined'
        ) {
            anchor =
                hasBid
                && hasVwap
                    ? Math.min(
                        bid,
                        vwap
                    )
                    : null;
        }

        if (
            !Number.isFinite(anchor)
        ) {
            return {
                ...unavailable(
                    'Invalidation anchor unavailable'
                ),

                lower,
                upper,
                maximum
            };
        }

        const bufferTicks =
            netScore > 0
                ? 2
                : netScore === 0
                    ? 3
                    : netScore === -1
                        ? 4
                        : 5;

        let invalidation =
            roundToTick(
                anchor
                - bufferTicks * tick,

                tick,
                'down'
            );

        invalidation =
            roundToTick(
                Math.min(
                    invalidation,
                    lower - tick,
                    price
                ),

                tick,
                'down'
            );

        if (
            !(
                lower <= upper
                && upper <= maximum
                && invalidation < lower
            )
        ) {
            return unavailable(
                'Price relationship validation failed'
            );
        }

        const insidePreferredRange =
            price >= lower - 1e-9
            && price <= upper + 1e-9;

        const inside =
            price >= lower - 1e-9
            && price <= upper + tick + 1e-9;

        const aboveMaximum =
            price > maximum + 1e-9;

        const belowInvalidation =
            price < invalidation - 1e-9;

        const belowVwapSelling =
            hasVwap
            && price < vwap
            && tar === 'Seller Active'
            && obi !== 'Bid Dominant';

        const stronglyNegative =
            tar === 'Seller Active'
            && obi === 'Ask Dominant';

        const internallyInconsistent =
            hasBid
            && hasAsk
            && bid > ask;

        const wideSpreadWithNegativeScore =
            wideSpread
            && netScore < 0;

        const hardBlocks = {
            belowInvalidation,
            stronglyNegative,
            internallyInconsistent
        };

        const blockingFactors = [];

        if (
            hardBlocks.belowInvalidation
        ) {
            blockingFactors.push(
                '✕ BLOCKING: Current Price '
                + price
                + ' below invalidation level '
                + invalidation
            );
        }

        if (
            hardBlocks.stronglyNegative
        ) {
            blockingFactors.push(
                '✕ BLOCKING: TAR '
                + tar
                + ' + OBI '
                + obi
                + ' (net score '
                + netScore
                + ')'
            );
        }

        if (
            hardBlocks
                .internallyInconsistent
        ) {
            blockingFactors.push(
                '✕ BLOCKING: Bid 1 '
                + bid
                + ' exceeds Ask 1 '
                + ask
            );
        }

        let rawState;

        if (
            blockingFactors.length > 0
        ) {
            rawState =
                'DO NOT ENTER';
        } else if (
            aboveMaximum
            || materialExtension
        ) {
            rawState =
                'WAIT FOR PULLBACK';
        } else if (
            openingExtension
        ) {
            rawState =
                'WAIT FOR CONFIRMATION';
        } else if (
            belowVwapSelling
            || wideSpreadWithNegativeScore
            || wideSpread
            || netScore < 0
            || tar === 'Balanced'
            || (
                obi === 'Ask Dominant'
                && tar !== 'Buyer Active'
            )
            || !inside
        ) {
            rawState =
                'WAIT FOR CONFIRMATION';
        } else {
            rawState =
                'ENTRY CONDITIONS MET';
        }

        let state =
            rawState;

        let confidence =
            'Moderate';

        let effectiveBlockingReason =
            blockingFactors[0]
            || null;

        const factors = [];

        if (
            entryMode
                === 'left_side_starter'
        ) {
            const zoneLow =
                Number(
                    executionContext
                        ?.activeZone
                        ?.low
                );

            const zoneHigh =
                Number(
                    executionContext
                        ?.activeZone
                        ?.high
                );

            const validSourceZone =
                Number.isFinite(zoneLow)
                && Number.isFinite(zoneHigh)
                && zoneLow > 0
                && zoneHigh > 0
                && zoneLow <= zoneHigh;

            const insideSourceZone =
                validSourceZone
                && price
                    >= zoneLow - 1e-9
                && price
                    <= zoneHigh + 1e-9;

            const sourceInvalidation =
                Number(
                    executionContext
                        ?.invalidationLevel
                );

            const validSourceInvalidation =
                Number.isFinite(
                    sourceInvalidation
                )
                && sourceInvalidation > 0;

            const belowSourceInvalidation =
                validSourceInvalidation
                && price
                    < sourceInvalidation
                        - 1e-9;

            const starterEligible =
                executionContext
                    ?.starterEligible
                === true;

            const starterExecuted =
                executionContext
                    ?.starterExecuted
                === true;

            const starterHardBlocks = [];

            if (!validSourceZone) {
                starterHardBlocks.push(
                    '✕ BLOCKING: ETF_DCA Active Zone is unavailable or invalid'
                );
            } else if (
                !insideSourceZone
            ) {
                starterHardBlocks.push(
                    '✕ BLOCKING: Current Price is outside ETF_DCA Active Zone'
                );
            }

            if (
                belowSourceInvalidation
            ) {
                starterHardBlocks.push(
                    '✕ BLOCKING: Current Price is below ETF_DCA invalidation level'
                );
            }

            if (!starterEligible) {
                starterHardBlocks.push(
                    '✕ BLOCKING: ETF_DCA has not authorized a left-side starter'
                );
            }

            if (starterExecuted) {
                starterHardBlocks.push(
                    '✕ BLOCKING: Left-side starter was already executed'
                );
            }

            if (
                internallyInconsistent
            ) {
                starterHardBlocks.push(
                    '✕ BLOCKING: Bid 1 exceeds Ask 1'
                );
            }

            const highRiskLeftSide =
                stronglyNegative
                || belowVwapSelling
                || wideSpreadWithNegativeScore
                || wideSpread
                || netScore < 0
                || materialExtension
                || aboveMaximum;

            if (
                starterHardBlocks.length > 0
            ) {
                state =
                    'DO NOT ENTER';

                confidence =
                    'Low';

                effectiveBlockingReason =
                    starterHardBlocks[0];

                factors.push(
                    ...starterHardBlocks
                );
            } else if (
                highRiskLeftSide
            ) {
                state =
                    'HIGH-RISK LEFT-SIDE ENTRY';

                confidence =
                    'Low';

                effectiveBlockingReason =
                    null;

                factors.push(
                    '⚠ ETF_DCA starter is eligible, but intraday execution risk is elevated'
                );
            } else if (
                rawState
                    === 'ENTRY CONDITIONS MET'
            ) {
                state =
                    'LEFT-SIDE EXECUTION ACCEPTABLE';

                confidence =
                    input.volumeQuality
                    && input.volumeQuality
                        !== 'Unavailable'
                        ? 'High'
                        : 'Moderate';

                effectiveBlockingReason =
                    null;

                factors.push(
                    '✓ ETF_DCA starter is eligible and execution conditions are acceptable'
                );
            } else {
                state =
                    'LEFT-SIDE STARTER ELIGIBLE';

                confidence =
                    'Moderate';

                effectiveBlockingReason =
                    null;

                factors.push(
                    '– Left-side starter is eligible; right-side confirmation is not required for this possible left-side entry'
                );
            }

            factors.push(
                `– Confirmed-mode raw assessment: ${rawState}`
            );
        } else {
            if (
                state === 'DATA UNAVAILABLE'
                || state === 'DO NOT ENTER'
                || aboveMaximum
                || wideSpread
                || netScore < 0
                || (
                    !hasBid
                    || !hasAsk
                )
            ) {
                confidence =
                    'Low';
            } else if (
                state
                    === 'ENTRY CONDITIONS MET'
                && inside
                && tar === 'Buyer Active'
                && obi !== 'Ask Dominant'
                && !materialExtension
                && input.volumeQuality
                && input.volumeQuality
                    !== 'Unavailable'
            ) {
                confidence =
                    'High';
            }

            if (
                state === 'DO NOT ENTER'
            ) {
                factors.push(
                    ...blockingFactors
                );
            }
        }

        factors.push(
            insidePreferredRange
                ? '✓ Current Price inside preferred entry range'
                : price > upper
                    ? '✕ Current Price above preferred entry range'
                    : '– Current Price below preferred entry range'
        );

        factors.push(
            price <= maximum
                ? '✓ Below maximum entry price'
                : '✕ Above maximum entry price'
        );

        factors.push(
            tar === 'Buyer Active'
                ? '✓ TAR buyer active'
                : tar === 'Seller Active'
                    ? '✕ TAR seller active'
                    : '– TAR balanced'
        );

        factors.push(
            obi === 'Bid Dominant'
                ? '✓ OBI bid dominant'
                : obi === 'Ask Dominant'
                    ? '✕ OBI ask dominant'
                    : '– OBI balanced'
        );

        if (hasVwap) {
            factors.push(
                materialExtension
                    ? '✕ Price materially above VWAP'
                    : Math.abs(vwapPercent)
                        <= Math.max(
                            0.001,
                            2 * tick / vwap
                        )
                        ? '✓ Price near VWAP'
                        : price > vwap
                            ? '✓ Price above VWAP'
                            : '✕ Price below VWAP'
            );
        }

        if (openingExtension) {
            factors.push(
                '✕ Opening gap/extension — waiting for post-open market development'
            );
        }

        factors.push(
            wideSpread
                ? '✕ Spread is wide'
                : '✓ Spread acceptable'
        );

        factors.push(
            input.volumeQuality
            && input.volumeQuality
                !== 'Unavailable'
                ? `– Volume quality ${input.volumeQuality.toLowerCase()}`
                : '– Volume quality unavailable'
        );

        return {
            state,
            rawState,
            entryMode,
            confidence,
            lower,
            upper,
            maximum,
            invalidation,
            tradingLower,
            tradingUpper,
            netScore,
            spread,
            wideSpread,
            materialExtension,
            vwapDifference,
            vwapPercent,

            blockingReason:
                effectiveBlockingReason,

            ruleEvaluation: {
                tar,
                obi,

                vwapPosition:
                    getVwapPosition(
                        price,
                        vwap
                    ),

                bid1:
                    hasBid
                        ? bid
                        : null,

                ask1:
                    hasAsk
                        ? ask
                        : null,

                spread,
                netScore,
                belowInvalidation,
                stronglyNegative,
                belowVwapSelling,
                wideSpreadWithNegativeScore,
                internallyInconsistent,

                hardBlockActive:
                    Boolean(
                        effectiveBlockingReason
                    )
            },

            factors:
                factors.slice(0, 9)
        };
    }

    // Observations only: callers retain ownership of monitoring and entry decisions.
    function analyzePriceAction({ candles, quote, vwap, now = Date.now() }) {
        const quoteTime = timestampToMs(quote?.lastUpdated || quote?.lastTrade?.time || quote?.closeTime);
        const cutoff = Math.min(now, quoteTime || 0);
        const day = quote?.date;
        const open = Number(quote?.openPrice);
        const current = Number(quote?.lastPrice ?? quote?.closePrice);
        const bars = (Array.isArray(candles?.data) ? candles.data : [])
            .map(item => ({ start: Date.parse(item?.date), open: Number(item?.open),
                high: Number(item?.high), low: Number(item?.low), close: Number(item?.close),
                volume: Number(item?.volume ?? item?.total?.volume) }))
            .filter(bar => Number.isFinite(bar.start) && bar.start + 300000 <= cutoff
                && new Date(bar.start).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }) === day
                && [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
                && bar.volume >= 0)
            .sort((a, b) => a.start - b.start)
            .filter((bar, index, all) => index === 0 || bar.start !== all[index - 1].start);
        const openingStart = Date.parse(`${day}T09:00:00+08:00`);
        const opening = Array.from({ length: 6 }, (_, index) =>
            bars.find(bar => bar.start === openingStart + index * 300000));
        const openingComplete = opening.every(Boolean);
        const rangeHigh = openingComplete ? Math.max(...opening.map(bar => bar.high)) : null;
        const rangeLow = openingComplete ? Math.min(...opening.map(bar => bar.low)) : null;
        const after = openingComplete ? bars.filter(bar => bar.start >= openingStart + 1800000) : [];
        const latest = after.at(-1), previous = after.at(-2) || opening.at(-1);
        const candleFresh = Boolean(latest && quoteTime - (latest.start + 300000) <= 360000);
        const quality = calculateVolumeQuality(candles, quoteTime, getMarketSession(quote, 30000, new Date(now)));
        const ratio = quality.ratio;
        const volumeExpanding = ratio !== null && ratio >= 1.4;
        const volumeWeakening = ratio !== null && ratio < 0.6;
        const breakout = Boolean(latest && latest.close > rangeHigh
            && latest.volume >= Math.max(500, opening.reduce((sum, bar) => sum + bar.volume, 0) / 6));
        const breakdown = Boolean(latest && latest.close < rangeLow);
        const earlierBreakout = after.slice(0, -1).some(bar => bar.close > rangeHigh);
        const falseBreakout = Boolean(earlierBreakout && latest && latest.close <= rangeHigh);
        const acceptedBreakout = Boolean(breakout && previous?.close > rangeHigh);
        const successfulRetest = Boolean(acceptedBreakout && latest.low <= rangeHigh
            && latest.close > rangeHigh);
        const first = opening[0];
        const initialRally = Boolean(first && Number.isFinite(open) && first.high > open && first.close > open);
        const initialDecline = Boolean(first && Number.isFinite(open) && first.low < open && first.close < open);
        const pullbackHoldsOpen = Boolean(initialRally && latest
            && bars.some(bar => bar.start > first.start && bar.start < latest.start
                && bar.low >= open && bar.low < first.high)
            && latest.low >= open);
        const secondAttempt = Boolean(pullbackHoldsOpen && latest.close > previous.close);
        const rapidBreakBelowOpen = Boolean(initialRally && latest && previous && latest.close < open
            && previous.close > latest.close && latest.start - previous.start <= 300000);
        const failedReclaim = Boolean(initialDecline && latest && after.length >= 2
            && after.some(bar => bar.high >= open) && latest.close < open && latest.high <= open);
        const recent = after.slice(-3);
        const gradualVwapRise = Boolean(recent.length === 3 && Number.isFinite(vwap) && vwap > 0
            && recent.every(bar => bar.close > vwap)
            && recent[0].close < recent[1].close && recent[1].close < recent[2].close
            && (recent[2].close - recent[0].close) / recent[0].close <= 0.015
            && ratio !== null && ratio >= 1 && ratio < 2);
        const lowVolumePullback = Boolean(previous && latest && previous.close > previous.open
            && latest.close < previous.close && latest.low >= open && volumeWeakening);
        const higherLow = Boolean(after.length >= 3 && after.at(-1).low > after.at(-3).low);
        const strongSellingPullback = Boolean(previous && latest && previous.close > previous.open
            && latest.close < previous.low && volumeExpanding);
        const resistanceRejection = Boolean(previous && latest && latest.high >= previous.high
            && latest.close < previous.close && latest.close < latest.open);
        const breakdownFailedRetest = Boolean(previous && latest && previous.close < rangeLow
            && latest.high >= rangeLow && latest.close < rangeLow);
        const failedGapRecovery = Boolean(Number.isFinite(Number(quote?.previousClose))
            && open < Number(quote.previousClose) && latest?.high >= Number(quote.previousClose)
            && latest.close < Number(quote.previousClose));
        const priceVolume = previous && latest && ratio !== null
            ? `${latest.close >= previous.close ? 'RISING' : 'FALLING'}_${volumeExpanding ? 'EXPANDING' : volumeWeakening ? 'DECLINING' : 'NORMAL'}` : 'UNAVAILABLE';
        const divergence = Boolean(previous && latest && volumeWeakening
            && (latest.high > previous.high || latest.low < previous.low));
        return { openingComplete, rangeHigh, rangeLow, openPrice: open, currentPrice: current,
            vwap, quoteTime, latest, candleFresh, ratio, priceVolume,
            breakout, breakdown, acceptedBreakout, falseBreakout, successfulRetest,
            secondAttempt, rapidBreakBelowOpen, failedReclaim, gradualVwapRise,
            lowVolumePullback, higherLow, strongSellingPullback, resistanceRejection,
            failedGapRecovery, breakdownFailedRetest, divergence };
    }

    // Opening observations use only the completed 09:00–09:25 candles supplied by the caller.
    // OR30 breakout decisions remain in analyzePriceAction and begin after 09:30.
    function analyzeOpeningRules(bars, openPrice) {
        const opening = Array.isArray(bars) ? bars.slice(0, 6) : [];
        const count = opening.length;
        const states = ['待資料', '待資料', '待資料', '待資料'];
        const messages = ['等待首根完成 K。', '等待首根完成 K。', '等待首根完成 K。', '等待三根完成 K 與逐根均價。'];
        const high = count ? Math.max(...opening.map(bar => bar.high)) : null;
        const low = count ? Math.min(...opening.map(bar => bar.low)) : null;
        const latest = opening.at(-1) || null;
        if (!count || !Number.isFinite(openPrice) || openPrice <= 0) {
            return { count, high, low, latest, summary: '等待開盤證據', states, messages };
        }
        const first = opening[0], previous = opening.at(-2);
        const beganUp = first.close > openPrice;
        const beganDown = first.close < openPrice;
        const afterFirst = opening.slice(1);
        const pulledBack = afterFirst.some((bar, index) => bar.close < opening[index].close);
        const pullbackLow = afterFirst.length ? Math.min(...afterFirst.map(bar => bar.low)) : null;
        const heldOpen = beganUp && pulledBack && afterFirst.every(bar => bar.low >= openPrice);
        const lostOpen = beganUp && afterFirst.some(bar => bar.low < openPrice);
        const lossBar = beganUp ? afterFirst.find((bar, index) =>
            opening[index].close >= openPrice && bar.close < openPrice
            && bar.start - opening[index].start === 300000) : null;
        const failedReclaimBar = beganDown ? afterFirst.find(bar =>
            bar.high >= openPrice && bar.close < openPrice) : null;
        const lastThree = opening.slice(-3);
        const volumeRatio = previous?.volume > 0 ? latest.volume / previous.volume : null;
        const gentleRise = lastThree.length === 3
            && lastThree.every(bar => Number.isFinite(bar.average) && bar.close > bar.average)
            && lastThree[0].close < lastThree[1].close && lastThree[1].close < lastThree[2].close
            && (lastThree[2].close - lastThree[0].close) / lastThree[0].close <= 0.015
            && lastThree[2].volume >= lastThree[0].volume
            && Number.isFinite(volumeRatio) && volumeRatio >= 1 && volumeRatio < 2;
        const fmt = value => Number(value).toFixed(2);
        states[0] = heldOpen ? '守住，觀察再攻' : lostOpen ? latest.close >= openPrice ? '曾失守，已站回'
            : '開盤價已失守' : beganUp ? '等待回落' : '不適用';
        messages[0] = heldOpen ? `回落低點 ${fmt(pullbackLow)} 未破開盤 ${fmt(openPrice)}；觀察下一次上攻。`
            : lostOpen ? `回落曾低於開盤 ${fmt(openPrice)}；最新收 ${fmt(latest.close)}，不能判作全程守住。`
                : beganUp ? `首根收 ${fmt(first.close)} 高於開盤；尚待回落測試。` : '首根未先漲，不能套用此情境。';
        states[1] = lossBar && latest.close < openPrice ? '跌破警示' : lossBar ? '曾跌破，已站回' : beganUp ? '未出現' : '不適用';
        messages[1] = lossBar ? `相鄰完成 K 由開盤價上方收至 ${fmt(lossBar.close)}；最新收 ${fmt(latest.close)}。`
            : beganUp ? `尚無相鄰完成 K 跌破開盤 ${fmt(openPrice)}。` : '首根未先漲，不能套用此情境。';
        states[2] = failedReclaimBar && latest.close < openPrice ? '反彈受阻' : failedReclaimBar ? '曾受阻，已站回'
            : beganDown ? '等待反彈' : '不適用';
        messages[2] = failedReclaimBar ? `反彈曾觸及開盤 ${fmt(openPrice)} 卻收於下方；最新收 ${fmt(latest.close)}。`
            : beganDown ? `首根收 ${fmt(first.close)} 低於開盤；尚待反彈測試。` : '首根未先跌，不能套用此情境。';
        states[3] = gentleRise ? '溫和價量上行' : lastThree.length < 3 || lastThree.some(bar => !Number.isFinite(bar.average)) ? '資料不足' : '未符合';
        messages[3] = gentleRise ? `近三根收盤緩升，均高於各自當根均價；最新量為前根 ${volumeRatio.toFixed(2)} 倍。`
            : states[3] === '資料不足' ? '等待三根完成 K 與各根當時的均價。' : '緩升、逐根均價上方與溫和放量尚未同時成立。';
        const summary = states[1] === '跌破警示' ? '先漲後失守開盤價，偏多假設受損'
            : states[2] === '反彈受阻' ? '先跌後反彈受阻，短線偏弱'
                : gentleRise ? '緩升且價量配合，等待延續確認'
                    : heldOpen ? '回落守住開盤價，觀察第二次上攻'
                        : beganUp ? '首根偏強，等待回落測試'
                            : beganDown ? '首根偏弱，等待反彈測試' : '首根方向尚未明確';
        return { count, high, low, latest, summary, states, messages };
    }

    // Reference images are examples. Report only measurable price/volume evidence.
    function analyzeReferencePattern({ bars = [], action }) {
        const none = { title: '尚無可核對的圖型', evidence: '需要連續已完成 K 與可比較的價量證據。', pending: '下一根完成 K 後再檢查。', reference: null };
        if (!action?.openingComplete || !action.latest || !action.candleFresh) return none;
        const latest = action.latest;
        const ratio = Number.isFinite(action.ratio) ? action.ratio : null;
        const ratioText = ratio === null ? '相對量未知' : `相對量 ${ratio.toFixed(2)} 倍`;
        const fmt = value => Number(value).toFixed(2);
        if (action.breakdown && Number.isFinite(action.currentPrice) && action.currentPrice > 0
            && action.currentPrice < action.rangeLow) return {
            title: '跌破支撐', reference: 5,
            evidence: `對照「縮量回調與趨勢延續」中的跌破支撐情境：完成 K 收 ${fmt(latest.close)}、現價 ${fmt(action.currentPrice)}，均低於 OR30 下緣 ${fmt(action.rangeLow)}；支撐企穩與回調再續條件因此不成立；${ratioText}。`,
            pending: ratio !== null && ratio >= 1.4 ? '觀察後續是否延續或重新站回支撐。' : '圖中放量跌破條件尚未確認；觀察後續量能。'
        };
        if (action.falseBreakout && action.currentPrice <= action.rangeHigh) return { title: '上破後收回 · 圖 3/5', reference: 3,
            evidence: `先前完成 K 上破 OR30 高點 ${fmt(action.rangeHigh)}，最新收 ${fmt(latest.close)} 返回其下。`,
            pending: '等待後續 K 確認是否持續失守；不能只憑一根稱為完整假突破。' };
        if (action.breakout && action.currentPrice > action.rangeHigh) return { title: `${action.acceptedBreakout ? '上破後持續站穩' : '初次帶量上破'} · 圖 3/5`, reference: 3,
            evidence: `完成 K 收 ${fmt(latest.close)} 高於 OR30 高點 ${fmt(action.rangeHigh)}；${ratioText}。`,
            pending: action.acceptedBreakout ? '觀察回測能否守住。' : '等待後續完成 K 站穩或回測。' };
        if (action.resistanceRejection || action.failedGapRecovery || action.breakdownFailedRetest) return {
            title: '阻力受阻線索 · 圖 1/5', reference: 1,
            evidence: `最新完成 K 收 ${fmt(latest.close)}，出現近端阻力、缺口或跌破回測受阻。`,
            pending: '僅有價格結構證據；無法由 K 線確認機構訂單塊。'
        };
        const consecutive = sequence => sequence.every((bar, index) => index === 0
            || Number.isFinite(bar.start) && bar.start - sequence[index - 1].start === 300000);
        const pivots = field => bars.flatMap((bar, index) => index > 0 && index < bars.length - 1
            && consecutive(bars.slice(index - 1, index + 2))
            && (field === 'high' ? bar.high > bars[index - 1].high && bar.high > bars[index + 1].high
                : bar.low < bars[index - 1].low && bar.low < bars[index + 1].low) ? [{ bar, index }] : []);
        for (const field of ['high', 'low']) {
            const points = pivots(field), first = points.at(-2), second = points.at(-1);
            if (!first || !second || second.index < bars.length - 5 || first.bar.volume <= 0) continue;
            const priceExtends = field === 'high' ? second.bar.high > first.bar.high : second.bar.low < first.bar.low;
            if (priceExtends && second.bar.volume <= first.bar.volume * 0.8) return {
                title: `${field === 'high' ? '頂' : '底'}背離線索 · 圖 4/5`, reference: 4,
                evidence: `已確認${field === 'high' ? '高' : '低'}點 ${fmt(first.bar[field])} → ${fmt(second.bar[field])}，對應量 ${Math.round(first.bar.volume)} → ${Math.round(second.bar.volume)} 張。`,
                pending: '量能背離僅是警示；等待後續價格結構確認。'
            };
        }
        const recent = bars.slice(-4);
        if (recent.length === 4 && consecutive(recent)
            && recent[0].close < recent[1].close && recent[1].close < recent[2].close
            && recent[3].close < recent[2].close && recent[3].low >= action.openPrice
            && recent[2].volume > 0 && recent[3].volume <= recent[2].volume * 0.8) return {
            title: '上升後縮量回調', reference: 5,
            evidence: `對照「縮量回調與趨勢延續」中的縮量回調：前三根收盤走高，最新收 ${fmt(recent[3].close)} 回落但未破開盤 ${fmt(action.openPrice)}；量為前根 ${(recent[3].volume / recent[2].volume).toFixed(2)} 倍。`,
            pending: '尚待支撐穩定及重新放量上攻，不能稱為趨勢延續。'
        };
        const three = bars.slice(-3);
        if (three.length === 3 && consecutive(three) && three[0].volume > 0) {
            const rising = three[0].close < three[1].close && three[1].close < three[2].close;
            const falling = three[0].close > three[1].close && three[1].close > three[2].close;
            const change = three[2].volume / three[0].volume;
            if ((rising || falling) && (change >= 1.2 || change <= 0.8)) return {
                title: `價${rising ? '漲' : '跌'}量${change >= 1.2 ? '增' : '縮'} · 圖 2/5`, reference: 2,
                evidence: `近三根收盤 ${fmt(three[0].close)} → ${fmt(three[2].close)}；成交量 ${Math.round(three[0].volume)} → ${Math.round(three[2].volume)} 張。`,
                pending: '仍是短窗價量觀察，等待後續 K 確認趨勢。'
            };
        }
        return none;
    }

    // Use completed candles in chronological order. Earlier sessions may warm EMA20,
    // while callers decide which session's marks to display.
    function calculateHlSignals(data, period = 20) {
        const ema = new Array(data.length).fill(null);
        if (data.length >= period) {
            let sum = 0;
            for (let i = 0; i < period; i++) sum += data[i].close;
            ema[period - 1] = sum / period;
            for (let i = period; i < data.length; i++)
                ema[i] = data[i].close * (2 / (period + 1)) + ema[i - 1] * (1 - 2 / (period + 1));
        }
        let hi = null, lo = null, legs = 0, dir = 0, waiting = false, prevBull = null, prevBear = null;
        const signals = [];
        for (let i = 1; i < data.length; i++) {
            if (ema[i] === null) continue;
            const c = data[i], p = data[i - 1], bull = c.close > ema[i], bear = c.close < ema[i];
            let newHi = false, newLo = false, label = null;
            if (bull && (hi === null || c.high > hi)) { hi = c.high; newHi = true; }
            if (bear && (lo === null || c.low < lo)) { lo = c.low; newLo = true; }
            if (prevBull !== null && ((bull && !prevBull) || (bear && !prevBear))) {
                legs = 0; dir = 0; waiting = false; newHi = false; newLo = false;
                hi = bull ? c.high : null; lo = bear ? c.low : null;
            }
            if (bull) {
                if (newHi) { legs = 0; dir = 0; waiting = false; }
                if (c.high < p.high && c.low < p.low && dir !== -1) { legs = legs === 0 ? 1 : 2; dir = -1; waiting = true; }
                if (dir === -1 && c.high > p.high) { if (waiting) label = legs === 1 ? 'H1' : 'H2'; if (legs === 1) dir = 0; waiting = false; }
            }
            if (bear) {
                if (newLo) { legs = 0; dir = 0; waiting = false; }
                if (c.low > p.low && c.high > p.high && dir !== 1) { legs = legs === 0 ? 1 : 2; dir = 1; waiting = true; }
                if (dir === 1 && c.low < p.low) { if (waiting) label = legs === 1 ? 'L1' : 'L2'; if (legs === 1) dir = 0; waiting = false; }
            }
            prevBull = bull; prevBear = bear;
            if (label) signals.push({ start: c.start, label });
        }
        return { ema, signals };
    }

    global.MarketData =
        Object.freeze({
            OBI_THRESHOLD,
            CORE_TAR_STRONG_THRESHOLD,
            DETAILED_TAR_STRONG_BID,
            DETAILED_TAR_BID_BIASED,
            DETAILED_TAR_NEUTRAL_LOWER,
            DETAILED_TAR_ASK_BIASED,
            VWAP_NEAR_THRESHOLD,
            calculateTarObi,
            getTarContext,
            getObiContext,
            getVwap,
            getVwapPosition,
            timestampToMs,
            getMarketSession,
            calculateVolumeQuality,
            inferTickSize,
            roundToTick,
            calculateEntryAssessment,
            analyzePriceAction,
            analyzeOpeningRules,
            analyzeReferencePattern,
            calculateHlSignals
        });
})(window);
