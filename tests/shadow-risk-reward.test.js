'use strict';

const assert = require('node:assert/strict');
const rr = require('../shadow-risk-reward.js');

const start = Date.parse('2026-10-12T09:00:00+08:00');
const closes = [100, 100.2, 100.5, 101, 100.6, 100.1, 99.8, 100.2, 100.6, 101,
    100.5, 100.1, 99.9, 100.3, 100.6, 100.9, 100.4, 100, 100.2, 100.5];
const bars = closes.map((close, index) => ({
    date: new Date(start + index * 300000).toISOString(),
    open: close, high: close + 0.1, low: close - 0.1, close
}));
const base = {
    asOf: new Date(start + bars.length * 300000).toISOString(),
    proposedEntry: 100.55, tick: 0.05,
    intradayCandles: { data: bars },
    historicalCandles: { data: [] },
    etfBroadInvalidation: 97,
    manualOrTrailingInvalidation: 98
};
const result = rr.assess(base);
assert.equal(result.target1?.kind, 'CREDIBLE_RESISTANCE');
assert.equal(result.entryStructuralStop, null, 'a generic pivot is not a setup-specific stop');
assert.equal(result.etfBroadInvalidation, 97);
assert.equal(result.manualOrTrailingInvalidation, 98);
assert.ok(result.grossRr > 0);
assert.equal(result.grossRr, (result.target1.price - base.proposedEntry) / (base.proposedEntry - base.etfBroadInvalidation));
assert.equal(result.rrAssessment, 'CALCULABLE — ETF broad-risk estimate; no R&R gate');
assert.equal(rr.assess({ ...base, manualOrTrailingInvalidation: 99 }).grossRr, result.grossRr,
    'manual/trailing invalidation must not enter Option A arithmetic');
assert.equal(result.candleQuality.status, 'OK');
assert.equal(result.evidence[0]?.price, result.target1?.price, 'T1 is displayed first');
assert.equal(result.evidence[1]?.price, result.target2?.price, 'T2 is displayed second');
assert.ok(result.target1?.rejections.every(rejection => rejection.pivotAt && rejection.reactionAt
    && Number.isFinite(rejection.pivotPrice) && Number.isFinite(rejection.reactionLow)));

const priorStart = Date.parse('2026-10-08T09:00:00+08:00');
const priorSession = Array.from({ length: 53 }, (_, i) => ({
    date: new Date(priorStart + i * 300000).toISOString(), high: 100, low: 99.9, close: 99.95
}));
priorSession[52] = { ...priorSession[52], high: 102, low: 101.8, close: 101.9 };
priorSession.push({ date: new Date(priorStart + 54 * 300000).toISOString(),
    high: 101.99, low: 101.98, close: 101.98 });
const nextSession = Array.from({ length: 5 }, (_, i) => ({
    date: new Date(start + i * 300000).toISOString(), high: 100, low: 99, close: 99.5
}));
const crossedSession = rr.assess({ ...base, asOf: new Date(start + 5 * 300000).toISOString(),
    historicalCandles: { data: priorSession }, intradayCandles: { data: nextSession } });
assert.equal(crossedSession.candleQuality.status, 'OK');
assert.equal(crossedSession.completedFiveMinuteBars, 59, 'total includes prior and current sessions');
assert.equal(rr.completedFiveMinuteBars(null, { data: nextSession }, crossedSession.asOf).length, 5,
    'today count uses the same completed-candle cutoff without prior history');
assert.equal(crossedSession.evidence.find(level => level.price === 102)?.rejectionCount, 0,
    'a next-session gap is not an intraday rejection');

const noEntry = rr.assess({ ...base, proposedEntry: null });
assert.equal(noEntry.completedFiveMinuteBars, bars.length, 'coverage is independent of entry availability');
assert.equal(noEntry.grossRr, null);
for (const invalidation of [null, 0, base.proposedEntry, base.proposedEntry + 1]) {
    const unavailable = rr.assess({ ...base, etfBroadInvalidation: invalidation });
    assert.equal(unavailable.grossRr, null);
    assert.equal(unavailable.rrAssessment, 'R&R UNAVAILABLE — valid ETF broad invalidation required');
}

const duplicate = rr.assess({ ...base, intradayCandles: { data: [...bars, bars[4]] } });
assert.equal(duplicate.candleQuality.status, 'GAP_OR_DUPLICATE');
assert.deepEqual(duplicate.candleQuality.duplicateTimestamps, [bars[4].date]);
assert.equal(duplicate.rrAssessment, 'R&R UNAVAILABLE — candle coverage issue');
assert.equal(duplicate.grossRr, null);
const gap = rr.assess({ ...base, intradayCandles: { data: bars.filter((_, i) => i !== 4) } });
assert.equal(gap.candleQuality.status, 'GAP_OR_DUPLICATE');
assert.deepEqual(gap.candleQuality.missingCandles, [bars[4].date]);

const previous = [-0.3, -0.2, -0.1].map((offset, i) => ({
    date: new Date(Date.parse('2026-10-08T13:10:00+08:00') + i * 300000).toISOString(),
    high: 100.5, low: 99 + offset, close: 100
}));
const boundary = rr.assess({ ...base, historicalCandles: { data: previous },
    intradayCandles: { data: bars }, proposedEntry: 100.55 });
assert.equal(boundary.entryStructuralStop, null, 'prior session must not confirm current setup stop');
assert.equal(boundary.rrAssessment, 'R&R UNAVAILABLE — candle coverage issue');

const closing = Array.from({ length: 53 }, (_, i) => ({
    date: new Date(start + i * 300000).toISOString(), high: 101, low: 100, close: 100.5
}));
closing.push({ ...closing[0], date: new Date(start + 54 * 300000).toISOString() });
const validClosing = rr.assess({ ...base, asOf: new Date(start + 55 * 300000).toISOString(),
    intradayCandles: { data: closing } });
assert.equal(validClosing.candleQuality.status, 'OK', '13:25 is not expected before Fugle 13:30 close');
const missingClosing = rr.assess({ ...base, asOf: new Date(start + 55 * 300000).toISOString(),
    intradayCandles: { data: closing.slice(0, -1) } });
assert.ok(missingClosing.candleQuality.missingCandles.includes(closing.at(-1).date));

const future = { ...bars[0], date: new Date(start + 21 * 300000).toISOString(), high: 200 };
const withFuture = rr.assess({ ...base, intradayCandles: { data: [...bars, future] } });
assert.equal(withFuture.target1?.price, result.target1?.price, 'future candle cannot alter target');
assert.equal(withFuture.completedFiveMinuteBars, result.completedFiveMinuteBars);

const partial = rr.assess({ ...base, asOf: new Date(start + 19 * 300000 + 60000).toISOString() });
assert.equal(partial.completedFiveMinuteBars, 19, 'unfinished current candle excluded');

const noStop = rr.assess({ ...base, intradayCandles: { data: bars.slice(0, 8) } });
assert.equal(noStop.grossRr, null, 'no credible target means no R&R');

const brokenBars = [
    ...bars,
    { ...bars[0], date: new Date(start + 20 * 300000).toISOString(), close: 101.4, high: 101.5, low: 101.2 },
    { ...bars[0], date: new Date(start + 21 * 300000).toISOString(), close: 101.5, high: 101.6, low: 101.3 }
];
const broken = rr.assess({ ...base, asOf: new Date(start + 22 * 300000).toISOString(), proposedEntry: 101.55, intradayCandles: { data: brokenBars } });
assert.ok(broken.evidence.some(level => level.kind === 'BROKEN_RESISTANCE'));
assert.equal(broken.target1, null, 'accepted former ceiling is not selected as a target');

const oldDaily = rr.assess({ ...base, dailyResistance: { levels: [{ price: 102, date: '2026-10-13' }] } });
assert.ok(!oldDaily.evidence.some(level => level.price === 102), 'future daily pivot excluded');
const repeatedDaily = rr.assess({ ...base, dailyResistance: { asOf: '2026-10-09', levels: [{ price: 102, date: '2026-10-08', repeatedPivotCount: 2 }] } });
assert.ok(repeatedDaily.evidence.some(level => level.price === 102 && level.kind === 'CREDIBLE_RESISTANCE'));
const provisionalDaily = rr.assess({ ...base, intradayCandles: { data: bars.slice(0, 8) }, dailyResistance: { asOf: '2026-10-09', levels: [{ price: 102, date: '2026-10-08', repeatedPivotCount: 1 }] } });
assert.equal(provisionalDaily.grossRr, null);
assert.equal(provisionalDaily.resistanceConfidence, 'PROVISIONAL_RESISTANCE');
console.log('shadow R&R tests passed');
