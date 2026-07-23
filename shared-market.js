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

    function getCompleted15mCandle(candleResponse, quote) {
        if (!candleResponse || !Array.isArray(candleResponse.data) || !candleResponse.data.length) return null;
        const referenceMs = timestampToMs(quote?.lastUpdated || quote?.lastTrade?.time || quote?.closeTime) || Date.now();
        const completed = candleResponse.data.filter(candle => {
            const startMs = Date.parse(candle.date);
            return Number.isFinite(startMs) && startMs + 15 * 60 * 1000 <= referenceMs;
        });
        return completed.length ? completed[completed.length - 1] : null;
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
        inferTickSize,
        getCompleted15mCandle,
    });
})(window);