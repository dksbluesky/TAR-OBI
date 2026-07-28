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
