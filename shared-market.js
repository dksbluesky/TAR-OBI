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
        if (totalPrints <= 0 || totalBook <= 0) return null;

        const tarAskPct = askPrints / totalPrints;
        const tarBidPct = bidPrints / totalPrints;
        const tarIndex = tarAskPct - tarBidPct;
        const obiBidPct = bidQty / totalBook;
        const obiAskPct = askQty / totalBook;
        const obiIndex = obiBidPct - obiAskPct;

        const obiKey = obiIndex > OBI_THRESHOLD ? 'Bid-heavy OBI' : obiIndex < -OBI_THRESHOLD ? 'Ask-heavy OBI' : 'Balanced OBI';
        const detTarKey = tarIndex >= DETAILED_TAR_STRONG_BID ? 'Strong Bid TAR'
            : tarIndex >= DETAILED_TAR_BID_BIASED ? 'Bid-biased TAR'
            : tarIndex > DETAILED_TAR_NEUTRAL_LOWER ? 'Neutral TAR'
            : tarIndex > DETAILED_TAR_ASK_BIASED ? 'Ask-biased TAR'
            : 'Strong Ask TAR';
        const coreTarKey = tarIndex >= CORE_TAR_STRONG_THRESHOLD ? 'Strong Bullish' : tarIndex <= -CORE_TAR_STRONG_THRESHOLD ? 'Strong Bearish' : 'Neutral';
        const coreObiKey = obiIndex > OBI_THRESHOLD ? 'Buy-heavy' : obiIndex < -OBI_THRESHOLD ? 'Ask-heavy' : 'Balanced';

        return { totalPrints, totalBook, tarAskPct, tarBidPct, tarIndex, obiBidPct, obiAskPct, obiIndex, obiKey, detTarKey, coreTarKey, coreObiKey };
    }

    function getTarContext(detTarKey) {
        if (detTarKey === 'Strong Bid TAR' || detTarKey === 'Bid-biased TAR') return 'Buyer Active';
        if (detTarKey === 'Strong Ask TAR' || detTarKey === 'Ask-biased TAR') return 'Seller Active';
        return detTarKey ? 'Balanced' : 'Unavailable';
    }

    function getObiContext(obiKey) {
        if (obiKey === 'Bid-heavy OBI') return 'Bid Dominant';
        if (obiKey === 'Ask-heavy OBI') return 'Ask Dominant';
        return obiKey ? 'Balanced' : 'Unavailable';
    }

    function getVwap(quote) {
        if (!quote) return null;
        const lastPrice = quote.lastPrice ?? quote.closePrice ?? null;
        let vwap = quote.avgPrice ?? null;
        if (vwap == null && quote.total?.tradeValue > 0 && quote.total?.tradeVolume > 0) {
            vwap = quote.total.tradeValue / quote.total.tradeVolume;
            if (lastPrice && vwap / lastPrice > 100) vwap /= 1000;
        }
        return Number.isFinite(vwap) && vwap > 0 ? vwap : null;
    }

    function getVwapPosition(price, vwap) {
        if (!Number.isFinite(price) || !Number.isFinite(vwap) || vwap <= 0) return 'Unavailable';
        const deviation = (price - vwap) / vwap;
        return deviation > VWAP_NEAR_THRESHOLD ? 'Above VWAP' : deviation < -VWAP_NEAR_THRESHOLD ? 'Below VWAP' : 'Near VWAP';
    }

    function timestampToMs(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return null;
        if (n > 1e14) return Math.floor(n / 1000);
        if (n > 1e11) return Math.floor(n);
        return Math.floor(n * 1000);
    }

    function getMarketSession(quote, refreshMs, now = new Date()) {
        if (!quote) return 'unavailable';
        if (quote.isClose) return 'closed';
        const updatedMs = timestampToMs(quote.lastUpdated || quote.lastTrade?.time || quote.closeTime);
        if (!updatedMs) return 'unavailable';
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(now);
        const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
        const today = `${p.year}-${p.month}-${p.day}`;
        const minute = Number(p.hour) * 60 + Number(p.minute);
        if (p.weekday === 'Sat' || p.weekday === 'Sun') return 'closed';
        if (minute < 540) return 'preopen';
        if (quote.date !== today || minute >= 810) return 'closed';
        return now.getTime() - updatedMs > Math.max(90000, refreshMs * 2 + 15000) ? 'stale' : 'live';
    }

    function calculateVolumeQuality(candleResponse, referenceTimestamp, session = 'live') {
        const unavailable = reason => ({
            quality: 'Unavailable', ratio: null, latestVolume: null,
            medianVolume: null, sampleCount: 0, reason,
        });
        if (session === 'stale' || session === 'unavailable' || session === 'preopen') return unavailable('Market data unavailable');
        const referenceMs = timestampToMs(referenceTimestamp);
        if (!referenceMs) return unavailable('Reference timestamp unavailable');
        const candles = Array.isArray(candleResponse?.data) ? candleResponse.data : [];
        const taipeiParts = value => {
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit',
            }).formatToParts(new Date(value));
            return Object.fromEntries(parts.map(item => [item.type, item.value]));
        };
        const completed = candles.map(candle => {
            const startMs = Date.parse(candle?.date);
            const volume = Number(candle?.volume);
            if (!Number.isFinite(startMs) || !Number.isFinite(volume) || volume < 0) return null;
            const parts = taipeiParts(startMs);
            if (parts.hour === '09' && parts.minute === '00') return null;
            if (startMs + 5 * 60 * 1000 > referenceMs) return null;
            return { startMs, volume, marketDate: `${parts.year}-${parts.month}-${parts.day}` };
        }).filter(Boolean).sort((a, b) => a.startMs - b.startMs);
        if (!completed.length) return unavailable('No completed 5-minute candles');
        const latest = completed[completed.length - 1];
        if (referenceMs - (latest.startMs + 5 * 60 * 1000) > 6 * 60 * 1000) return unavailable('Latest completed candle is stale');
        const sameDay = completed.filter(candle => candle.marketDate === latest.marketDate);
        if (sameDay.length < 5) return unavailable('At least five completed candles required');
        const baseline = sameDay.slice(0, -1).map(candle => candle.volume).sort((a, b) => a - b);
        const middle = Math.floor(baseline.length / 2);
        const medianVolume = baseline.length % 2 ? baseline[middle] : (baseline[middle - 1] + baseline[middle]) / 2;
        if (!Number.isFinite(medianVolume) || medianVolume <= 0) return unavailable('Baseline volume unavailable');
        const ratio = latest.volume / medianVolume;
        const quality = ratio < 0.60 ? 'Low' : ratio < 1.40 ? 'Normal' : ratio < 2.00 ? 'Expanding' : 'Heavy';
        return {
            quality, ratio, latestVolume: latest.volume, medianVolume,
            sampleCount: baseline.length, reason: null,
        };
    }
    function inferTickSize(quote) {
        const prices = [...(quote?.bids || []), ...(quote?.asks || [])]
            .map(level => Number(level.price))
            .filter(price => Number.isFinite(price) && price > 0);
        const unique = [...new Set(prices)].sort((a, b) => a - b);
        let minimum = Infinity;
        for (let i = 1; i < unique.length; i += 1) {
            const difference = Number((unique[i] - unique[i - 1]).toFixed(4));
            if (difference > 0 && difference < minimum) minimum = difference;
        }
        if (Number.isFinite(minimum)) return minimum;
        const price = quote?.lastPrice ?? quote?.closePrice;
        if (!Number.isFinite(price)) return null;
        return price < 10 ? 0.01 : price < 50 ? 0.05 : price < 100 ? 0.1 : price < 500 ? 0.5 : price < 1000 ? 1 : 5;
    }

    function roundToTick(value, tick, direction = 'nearest') {
        if (!Number.isFinite(value) || !Number.isFinite(tick) || tick <= 0) return null;
        const units = value / tick;
        const rounded = direction === 'down' ? Math.floor(units + 1e-9)
            : direction === 'up' ? Math.ceil(units - 1e-9)
            : Math.round(units);
        return Number((rounded * tick).toFixed(8));
    }

    function calculateEntryAssessment(input) {
        const price = Number(input.current);
        const bid = Number(input.bid);
        const ask = Number(input.ask);
        const vwap = Number(input.vwap);
        const tick = Number(input.tick);
        const hasPrice = Number.isFinite(price) && price > 0;
        const hasBid = Number.isFinite(bid) && bid > 0;
        const hasAsk = Number.isFinite(ask) && ask > 0;
        const hasVwap = Number.isFinite(vwap) && vwap > 0;
        const hasTick = Number.isFinite(tick) && tick > 0;
        const session = input.session || 'unavailable';
        const entryBasis = input.entryBasis || 'combined';
        const invalidationBasis = input.invalidationBasis || 'match';
        const tar = input.tar || 'Unavailable';
        const obi = input.obi || 'Unavailable';
        const tradingLower = hasBid ? bid : hasAsk ? ask : null;
        const tradingUpper = hasAsk ? ask : hasBid ? bid : null;
        const unavailable = value => ({
            state: 'DATA UNAVAILABLE', confidence: 'Low', lower: null, upper: null,
            maximum: null, invalidation: null, tradingLower, tradingUpper, factors: [value],
        });

        if (!hasPrice || !hasTick || !input.timestamp || ['unavailable', 'stale'].includes(session)) return unavailable(session === 'stale' ? 'Data stale' : 'Critical market data unavailable');
        if (tar === 'Unavailable' || obi === 'Unavailable') return unavailable('Essential TAR or OBI data unavailable');
        if (entryBasis === 'bidAsk' && !hasBid && !hasAsk) return unavailable('Bid and ask unavailable');
        if (entryBasis === 'vwap' && !hasVwap) return unavailable('VWAP unavailable for selected basis');
        if (entryBasis === 'combined' && (!hasVwap || (!hasBid && !hasAsk))) return unavailable('Combined basis anchors unavailable');

        const spread = hasBid && hasAsk && ask >= bid ? ask - bid : null;
        const vwapDifference = hasVwap ? price - vwap : null;
        const vwapPercent = hasVwap ? vwapDifference / vwap : null;
        const materialExtension = hasVwap && vwapDifference > Math.max(vwap * 0.003, 4 * tick);
        let lower;
        let upper;
        if (materialExtension) {
            const pullbackWidth = Math.max(2 * tick, Math.min(Number.isFinite(spread) ? spread : 0, 3 * tick));
            lower = vwap - tick;
            upper = vwap + pullbackWidth;
        } else if (entryBasis === 'bidAsk') {
            lower = hasBid ? bid : ask;
            upper = hasAsk ? ask : bid;
        } else if (entryBasis === 'vwap') {
            lower = vwap - tick;
            upper = vwap + tick;
        } else if (entryBasis === 'current') {
            lower = price - tick;
            upper = price;
        } else {
            const marketLower = hasBid ? bid : ask;
            const marketUpper = hasAsk ? ask : bid;
            const widthCap = Math.max(2 * tick, Number.isFinite(spread) ? spread : 0);
            lower = Math.min(marketLower, vwap);
            upper = Math.max(marketUpper, vwap);
            if (upper - lower > widthCap) {
                lower = marketLower;
                upper = Math.max(marketUpper, marketLower + widthCap);
            }
        }

        lower = roundToTick(lower, tick, 'down');
        const baseUpper = roundToTick(upper, tick, 'up');
        const tarScore = tar === 'Buyer Active' ? 1 : tar === 'Seller Active' ? -1 : 0;
        const obiScore = obi === 'Bid Dominant' ? 1 : obi === 'Ask Dominant' ? -1 : 0;
        const netScore = tarScore + obiScore;
        const wideSpread = Number.isFinite(spread) && spread > 3 * tick + 1e-9;
        const appliedScore = materialExtension && netScore > 0 ? 0 : netScore;
        upper = roundToTick(Math.max(lower, baseUpper + appliedScore * tick), tick, appliedScore < 0 ? 'down' : 'up');
        const maximum = roundToTick(Math.max(upper, baseUpper + Math.max(0, appliedScore) * tick), tick, 'up');

        let anchor;
        let resolvedInvalidation = invalidationBasis;
        if (resolvedInvalidation === 'match') resolvedInvalidation = entryBasis;
        if (resolvedInvalidation === 'bidAsk') anchor = hasBid ? bid : null;
        else if (resolvedInvalidation === 'vwap') anchor = hasVwap ? vwap : null;
        else if (resolvedInvalidation === 'range') anchor = lower;
        else if (resolvedInvalidation === 'current') anchor = price;
        else if (resolvedInvalidation === 'combined') anchor = hasBid && hasVwap ? Math.min(bid, vwap) : null;
        if (!Number.isFinite(anchor)) {
            return { ...unavailable('Invalidation anchor unavailable'), lower, upper, maximum };
        }
        const bufferTicks = netScore > 0 ? 2 : netScore === 0 ? 3 : netScore === -1 ? 4 : 5;
        let invalidation = roundToTick(anchor - bufferTicks * tick, tick, 'down');
        invalidation = roundToTick(Math.min(invalidation, lower - tick, price), tick, 'down');

        if (!(lower <= upper && upper <= maximum && invalidation < lower)) return unavailable('Price relationship validation failed');

        const insidePreferredRange = price >= lower - 1e-9 && price <= upper + 1e-9;
        const inside = price >= lower - 1e-9 && price <= upper + tick + 1e-9;
        const aboveMaximum = price > maximum + 1e-9;
        const belowInvalidation = price < invalidation - 1e-9;
        const belowVwapSelling = hasVwap && price < vwap && tar === 'Seller Active' && obi !== 'Bid Dominant';
        const stronglyNegative = tar === 'Seller Active' && obi === 'Ask Dominant';
        const internallyInconsistent = hasBid && hasAsk && bid > ask;
        const wideSpreadWithNegativeScore = wideSpread && netScore < 0;
        const hardBlocks = { belowInvalidation, stronglyNegative, internallyInconsistent };
        const blockingFactors = [];
        if (hardBlocks.belowInvalidation) blockingFactors.push('✕ BLOCKING: Current Price ' + price + ' below invalidation level ' + invalidation);
        if (hardBlocks.stronglyNegative) blockingFactors.push('✕ BLOCKING: TAR ' + tar + ' + OBI ' + obi + ' (net score ' + netScore + ')');
        if (hardBlocks.internallyInconsistent) blockingFactors.push('✕ BLOCKING: Bid 1 ' + bid + ' exceeds Ask 1 ' + ask);

        let state;
        if (blockingFactors.length > 0) state = 'DO NOT ENTER';
        else if (aboveMaximum || materialExtension) state = 'WAIT FOR PULLBACK';
        else if (belowVwapSelling || wideSpreadWithNegativeScore || wideSpread || netScore < 0 || tar === 'Balanced' || (obi === 'Ask Dominant' && tar !== 'Buyer Active') || !inside) state = 'WAIT FOR CONFIRMATION';
        else state = 'ENTRY CONDITIONS MET';

        let confidence = 'Moderate';
        if (state === 'DATA UNAVAILABLE' || state === 'DO NOT ENTER' || aboveMaximum || wideSpread || netScore < 0 || (!hasBid || !hasAsk)) confidence = 'Low';
        else if (state === 'ENTRY CONDITIONS MET' && inside && tar === 'Buyer Active' && obi !== 'Ask Dominant' && !materialExtension && input.volumeQuality && input.volumeQuality !== 'Unavailable') confidence = 'High';

        const factors = state === 'DO NOT ENTER' ? [...blockingFactors] : [];
        factors.push(insidePreferredRange ? '✓ Current Price inside preferred entry range'
            : price > upper ? '✕ Current Price above preferred entry range'
            : '– Current Price below preferred entry range');
        factors.push(price <= maximum ? '✓ Below maximum entry price' : '✕ Above maximum entry price');
        factors.push(tar === 'Buyer Active' ? '✓ TAR buyer active' : tar === 'Seller Active' ? '✕ TAR seller active' : '– TAR balanced');
        factors.push(obi === 'Bid Dominant' ? '✓ OBI bid dominant' : obi === 'Ask Dominant' ? '✕ OBI ask dominant' : '– OBI balanced');
        if (hasVwap) factors.push(materialExtension ? '✕ Price materially above VWAP' : Math.abs(vwapPercent) <= Math.max(0.001, 2 * tick / vwap) ? '✓ Price near VWAP' : price > vwap ? '✓ Price above VWAP' : '✕ Price below VWAP');
        factors.push(wideSpread ? '✕ Spread is wide' : '✓ Spread acceptable');
        factors.push(input.volumeQuality && input.volumeQuality !== 'Unavailable' ? `– Volume quality ${input.volumeQuality.toLowerCase()}` : '– Volume quality unavailable');

        return {
            state, confidence, lower, upper, maximum, invalidation, tradingLower, tradingUpper,
            netScore, spread, wideSpread, materialExtension, vwapDifference, vwapPercent,
            blockingReason: blockingFactors[0] || null,
            ruleEvaluation: {
                tar, obi, vwapPosition: getVwapPosition(price, vwap), bid1: hasBid ? bid : null,
                ask1: hasAsk ? ask : null, spread, netScore, belowInvalidation, stronglyNegative,
                belowVwapSelling, wideSpreadWithNegativeScore, internallyInconsistent,
                hardBlockActive: blockingFactors.length > 0,
            },
            factors: factors.slice(0, 7),
        };
    }

    global.MarketData = Object.freeze({
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
    });
})(window);
