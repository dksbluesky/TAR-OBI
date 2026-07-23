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

function assess(overrides = {}) {
    return MarketData.calculateEntryAssessment({ ...base, ...overrides });
}

assert.equal(assess().lower, 32.45, 'combined lower boundary');
assert.equal(assess().upper, 32.6, 'positive score expands upper boundary two ticks');
assert.equal(assess().maximum, 32.6, 'positive score expands maximum two ticks');
assert.equal(assess().state, 'ENTRY CONDITIONS MET');

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
assert.ok(farVwap.upper - farVwap.lower <= 0.1 + 1e-9, 'far VWAP does not widen combined range');

assert.equal(assess({ tar: 'Buyer Active', obi: 'Balanced' }).upper, 32.55, 'moderately positive adds one tick');
assert.equal(assess({ tar: 'Balanced', obi: 'Balanced' }).upper, 32.5, 'neutral adds no ticks');
assert.equal(assess({ tar: 'Seller Active', obi: 'Balanced' }).upper, 32.45, 'moderately negative removes one tick');
assert.equal(assess({ tar: 'Seller Active', obi: 'Ask Dominant' }).state, 'DO NOT ENTER', 'strong negative blocks entry');
assert.equal(assess({ current: 32.8 }).state, 'WAIT FOR PULLBACK', 'price above maximum waits for pullback');
assert.equal(assess({ tar: 'Balanced', obi: 'Ask Dominant' }).state, 'WAIT FOR CONFIRMATION', 'mixed evidence waits for confirmation');
assert.equal(assess({ vwap: 31.5 }).state, 'WAIT FOR PULLBACK', 'material VWAP extension waits for pullback');
assert.equal(assess({ current: 32.4, vwap: 32.5, tar: 'Seller Active', obi: 'Balanced' }).state, 'DO NOT ENTER', 'selling below VWAP blocks entry');
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

console.log('assessment tests passed');
