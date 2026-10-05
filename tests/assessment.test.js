const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'shared-market.js'), 'utf8'), context);
const MarketData = context.window.MarketData;

const base = {
    current: 32.5,
    bid: 32.45,
    ask: 32.5,
    vwap: 32.45,
    tick: 0.05,
    timestamp: Date.now(),
    session: 'live',
    tar: 'Buyer Active',
    obi: 'Bid Dominant',
    entryBasis: 'combined',
    invalidationBasis: 'match',
    volumeQuality: 'Unavailable',
};

const openingNow = new Date('2026-07-28T01:01:00.000Z');
const previousCloseQuote = {
    date: '2026-07-27',
    isClose: true,
    lastUpdated: Date.parse('2026-07-27T05:30:00.000Z')
};
assert.equal(
    MarketData.getMarketSession(previousCloseQuote, 30000, openingNow),
    'stale',
    'previous closed snapshot during Taiwan trading hours stays retryable'
);
assert.equal(
    MarketData.getMarketSession({ ...previousCloseQuote, date: '2026-07-28' }, 30000, openingNow),
    'stale',
    'temporary isClose snapshot during Taiwan trading hours stays retryable'
);
assert.equal(
    MarketData.getMarketSession({
        date: '2026-07-28',
        isClose: false,
        lastUpdated: Date.parse('2026-07-28T01:00:50.000Z')
    }, 30000, openingNow),
    'live',
    'fresh current-day opening quote is live'
);
assert.equal(
    MarketData.getMarketSession(previousCloseQuote, 30000, new Date('2026-07-28T05:31:00.000Z')),
    'closed',
    'actual Taiwan post-close time remains closed'
);

function assess(overrides = {}) {
    return MarketData.calculateEntryAssessment({ ...base, ...overrides });
}

assert.equal(assess().lower, 32.45, 'combined lower boundary');
assert.equal(assess().upper, 32.6, 'positive score expands upper boundary two ticks');
assert.equal(assess().maximum, 32.6, 'positive score expands maximum two ticks');
assert.equal(assess().state, 'ENTRY CONDITIONS MET');
const monitor = require('../bridge-monitor.js');
const liveBridge = {
    activeZone: { low: 265, high: 266 },
    invalidationLevel: 264,
    zoneMode: 'automatic',
    extensions: { marketContextV1: { context: 'bullish', automaticZoneEligible: true } },
    notificationState: { continuousValidity: { status: 'LIVE' } }
};
const gapTimestamp = Date.parse('2026-07-27T09:21:00+08:00');
const gapBase = {
    current: 265.4, bid: 265.35, ask: 265.4, vwap: 265.2,
    tick: 0.05, timestamp: gapTimestamp,
    openingContext: {
        previousClose: 258,
        openPrice: 264.2,
        openTime: Date.parse('2026-07-27T09:00:00+08:00') * 1000,
        marketDate: '2026-07-27',
        candles: { data: [
            { date: '2026-07-27T09:00:00+08:00', open: 264.2, high: 265.4, low: 264.1, close: 265.2 },
            { date: '2026-07-27T09:05:00+08:00', open: 265.2, high: 265.6, low: 265, close: 265.5 },
            { date: '2026-07-27T09:10:00+08:00', open: 265.5, high: 265.8, low: 265.3, close: 265.7 },
            { date: '2026-07-27T09:15:00+08:00', open: 265.7, high: 266.1, low: 265.4, close: 266 }
        ] }
    }
};
const gapAssessment = assess(gapBase);
assert.equal(gapAssessment.state, 'WAIT FOR CONFIRMATION', 'large opening gap waits despite near VWAP and positive flow');
assert.ok(gapAssessment.factors.some(factor => /Opening gap\/extension/.test(factor)));
assert.equal(monitor.finalActionContext(liveBridge, gapAssessment.state, 265.4).action, 'WAIT', 'large gap cannot reach BUY NOW with a LIVE zone');
assert.equal(assess({ ...gapBase, openingContext: null }).state, 'ENTRY CONDITIONS MET', 'legacy callers without opening context retain behavior');
assert.equal(assess({ ...gapBase, openingContext: { ...gapBase.openingContext, previousClose: 264 } }).state, 'ENTRY CONDITIONS MET', 'ordinary open retains entry assessment');
assert.equal(monitor.finalActionContext(liveBridge, 'ENTRY CONDITIONS MET', 265.4).action, 'BUY_NOW', 'ordinary entry still reaches BUY NOW with LIVE zone');
assert.equal(assess({ ...gapBase, tar: 'Seller Active', obi: 'Ask Dominant' }).state, 'DO NOT ENTER', 'hard blocker outranks opening gap');
assert.equal(assess({ ...gapBase, session: 'stale' }).state, 'DATA UNAVAILABLE', 'stale data outranks opening gap');
const wideFirstCandle = assess({
    ...gapBase,
    openingContext: { ...gapBase.openingContext, candles: { data: [
        { ...gapBase.openingContext.candles.data[0], high: 275, low: 263 },
        ...gapBase.openingContext.candles.data.slice(1)
    ] } }
});
assert.equal(wideFirstCandle.state, 'WAIT FOR CONFIRMATION', 'wide opening candle does not deactivate gap protection');
const developed = assess({
    ...gapBase,
    timestamp: Date.parse('2026-07-27T09:26:00+08:00'),
    openingContext: { ...gapBase.openingContext, candles: { data: [
        ...gapBase.openingContext.candles.data,
        { date: '2026-07-27T09:20:00+08:00', open: 266, high: 267, low: 265.5, close: 266.8 }
    ] } }
});
assert.equal(developed.state, 'ENTRY CONDITIONS MET', 'five completed opening candles retire guard without a PA-pattern check');
assert.equal(
    assess({ ...gapBase, timestamp: Date.parse('2026-07-27T13:00:00+08:00') }).state,
    'ENTRY CONDITIONS MET',
    'morning gap no longer independently blocks an afternoon entry'
);
assert.equal(
    assess({ ...gapBase, openingContext: { ...gapBase.openingContext, candles: null } }).state,
    'WAIT FOR CONFIRMATION',
    'missing candles do not remove early opening protection'
);
assert.equal(
    assess({ ...gapBase, timestamp: Date.parse('2026-07-27T09:31:00+08:00'), openingContext: {
        ...gapBase.openingContext, candles: null
    } }).state,
    'ENTRY CONDITIONS MET',
    'fresh quote bounds opening guard when candles are unavailable'
);
assert.equal(
    assess({ ...gapBase, current: 267, vwap: 265.2 }).state,
    'WAIT FOR PULLBACK',
    'material VWAP extension keeps pullback precedence over opening gap'
);
assert.deepEqual([assess().tradingLower, assess().tradingUpper], [32.45, 32.5], 'trading range remains executable bid/ask');

assert.deepEqual(
    [assess({ entryBasis: 'bidAsk' }).lower, assess({ entryBasis: 'bidAsk' }).upper],
    [32.45, 32.6],
    'bid/ask range receives the dynamic adjustment'
);
assert.deepEqual(
    [assess({ entryBasis: 'vwap', tar: 'Balanced', obi: 'Balanced' }).lower, assess({ entryBasis: 'vwap', tar: 'Balanced', obi: 'Balanced' }).upper],
    [32.4, 32.5],
    'VWAP range uses one tick on either side'
);
assert.deepEqual(
    [assess({ entryBasis: 'current', tar: 'Balanced', obi: 'Balanced' }).lower, assess({ entryBasis: 'current', tar: 'Balanced', obi: 'Balanced' }).upper],
    [32.45, 32.5],
    'current-price range uses current and one tick below'
);

const farVwap = assess({ vwap: 30, tar: 'Balanced', obi: 'Balanced' });
assert.ok(farVwap.upper - farVwap.lower <= 0.15 + 1e-9, 'far VWAP uses the capped pullback band');
assert.ok(farVwap.upper < base.current, 'far VWAP preferred range remains below current price');

assert.equal(assess({ tar: 'Buyer Active', obi: 'Balanced' }).upper, 32.55, 'moderately positive adds one tick');
assert.equal(assess({ tar: 'Balanced', obi: 'Balanced' }).upper, 32.5, 'neutral adds no ticks');
assert.equal(assess({ tar: 'Seller Active', obi: 'Balanced' }).upper, 32.45, 'moderately negative removes one tick');
assert.equal(assess({ tar: 'Seller Active', obi: 'Ask Dominant' }).state, 'DO NOT ENTER', 'strong negative blocks entry');
assert.equal(assess({ current: 32.8 }).state, 'WAIT FOR PULLBACK', 'price above maximum waits for pullback');
assert.equal(assess({ tar: 'Balanced', obi: 'Ask Dominant' }).state, 'WAIT FOR CONFIRMATION', 'mixed evidence waits for confirmation');
const extended = assess({ current: 33, bid: 32.95, ask: 33, vwap: 32.5 });
assert.equal(extended.state, 'WAIT FOR PULLBACK', 'material VWAP extension waits for pullback');
assert.deepEqual([extended.tradingLower, extended.tradingUpper], [32.95, 33], 'extended trading range remains bid/ask');
assert.ok(extended.upper < 33, 'preferred range is below extended current price');
assert.ok(extended.upper <= extended.maximum, 'preferred upper does not exceed maximum');
assert.ok(extended.factors.includes('✕ Current Price above preferred entry range'), 'pullback factor reports price above preferred range');
assert.ok(!extended.factors.includes('✓ Current Price inside preferred entry range'), 'pullback does not claim price is inside preferred range');
assert.equal(assess({ current: 32.4, vwap: 32.5, tar: 'Seller Active', obi: 'Balanced' }).state, 'WAIT FOR CONFIRMATION', 'selling below VWAP with balanced OBI waits for confirmation');
assert.equal(assess({ bid: 32.3, ask: 32.5 }).confidence, 'Low', 'wide spread lowers confidence');
assert.equal(assess({ entryBasis: 'vwap', vwap: null }).state, 'DATA UNAVAILABLE', 'missing selected anchor is unavailable');
assert.equal(assess({ session: 'stale' }).maximum, null, 'stale data has no actionable maximum');

for (const result of [
    assess(),
    assess({ tar: 'Balanced', obi: 'Balanced' }),
    assess({ tar: 'Seller Active', obi: 'Balanced' }),
    assess({ entryBasis: 'current' }),
]) {
    assert.ok(result.lower <= result.upper, 'range lower <= upper');
    assert.ok(result.upper <= result.maximum, 'range upper <= maximum');
    assert.ok(result.invalidation < result.lower, 'invalidation below range');
    for (const value of [result.lower, result.upper, result.maximum, result.invalidation]) {
        assert.ok(Math.abs(value / base.tick - Math.round(value / base.tick)) < 1e-8, 'price aligns to tick');
    }
}

const insideRangeBlocked = assess({ current: 32.4, bid: 32.4, ask: 32.5, vwap: 32.4, tar: 'Seller Active', obi: 'Ask Dominant' });
assert.equal(insideRangeBlocked.state, 'DO NOT ENTER', 'inside preferred range remains blocked by stronger evidence');
assert.match(insideRangeBlocked.factors[0], /^✕ BLOCKING:/, 'blocking reason is the first assessment factor');
assert.ok(insideRangeBlocked.factors.includes('✓ Current Price inside preferred entry range'), 'price-range context remains visible after blocker');
assert.ok(
    insideRangeBlocked.factors.indexOf('✓ Current Price inside preferred entry range') > 0,
    'blocking reason takes precedence over inside-range signal'
);

const doNotEnterCases = [
    assess({ tar: 'Seller Active', obi: 'Ask Dominant' }),
    assess({ bid: 32.55, ask: 32.5, tar: 'Balanced', obi: 'Balanced' }),
];
for (const result of doNotEnterCases) {
    assert.equal(result.state, 'DO NOT ENTER', 'explicit hard blocking scenario is prohibited');
    assert.ok(result.factors.length > 0, 'DO NOT ENTER always has an assessment factor');
    assert.match(result.factors[0], /^✕ BLOCKING:/, 'DO NOT ENTER always starts with a blocking reason');
    assert.equal(result.blockingReason, result.factors[0], 'blocking reason matches the first visible factor');
    assert.equal(result.ruleEvaluation.hardBlockActive, true, 'DO NOT ENTER reports an active hard block');
}

const mixedEvidenceCases = [
    assess({ current: 32.4, vwap: 32.5, tar: 'Seller Active', obi: 'Balanced' }),
    assess({ tar: 'Balanced', obi: 'Ask Dominant' }),
    assess({ tar: 'Balanced', obi: 'Balanced' }),
    assess({ bid: 32.3, ask: 32.5, tar: 'Seller Active', obi: 'Balanced' }),
];
for (const result of mixedEvidenceCases) {
    assert.equal(result.state, 'WAIT FOR CONFIRMATION', 'mixed or insufficient evidence waits for confirmation');
    assert.equal(result.blockingReason, null, 'mixed evidence has no hard blocking reason');
    assert.equal(result.ruleEvaluation.hardBlockActive, false, 'mixed evidence does not report a hard block');
}

const diagnostic = insideRangeBlocked.ruleEvaluation;
assert.deepEqual(
    {
        tar: diagnostic.tar, obi: diagnostic.obi, vwapPosition: diagnostic.vwapPosition,
        bid1: diagnostic.bid1, ask1: diagnostic.ask1, spread: diagnostic.spread,
        netScore: diagnostic.netScore, stronglyNegative: diagnostic.stronglyNegative,
        belowVwapSelling: diagnostic.belowVwapSelling,
        wideSpreadWithNegativeScore: diagnostic.wideSpreadWithNegativeScore,
        internallyInconsistent: diagnostic.internallyInconsistent,
    },
    {
        tar: 'Seller Active', obi: 'Ask Dominant', vwapPosition: 'Near VWAP',
        bid1: 32.4, ask1: 32.5, spread: 0.10000000000000142,
        netScore: -2, stronglyNegative: true, belowVwapSelling: false,
        wideSpreadWithNegativeScore: false, internallyInconsistent: false,
    },
    'assessment exposes exact live values and evaluated blocking booleans'
);
console.log('assessment tests passed');
