const assert = require('assert');

const values = new Map();
global.localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
};
delete require.cache[require.resolve('../assessment-journal.js')];
const journal = require('../assessment-journal.js');

const bridge = {
    bridgeId: 'bridge-1', ticker: '006208',
    activeZone: { low: 225, high: 231 },
    C1: { met: false }, C2: { met: true }
};
const snapshot = {
    complete: true,
    ticker: '006208',
    evaluatedAt: '2026-08-05T01:00:00.000Z',
    currentPrice: 237,
    preferredEntry: { low: 229, high: 231 },
    maximumEntryPrice: 231.5,
    invalidationLevel: 225,
    marketSession: 'live',
    assessment: { state: 'WAIT FOR PULLBACK', confidence: 'High' },
    tarState: 'Buyer Active',
    obiState: 'Bid Dominant',
    vwapState: 'Above VWAP',
    spreadState: 'ACCEPTABLE',
    volumeQuality: 'Normal'
};

assert.strictEqual(journal.recordCompletedAssessment(snapshot, null), null, 'standalone mode must not be recorded');
const entry = journal.recordCompletedAssessment(snapshot, bridge);
assert.strictEqual(entry.assessmentState, 'WAIT FOR PULLBACK');
assert.strictEqual(entry.currentPrice, 237);
assert.deepStrictEqual(entry.setupContext.activeZone, { low: 225, high: 231 });
assert.strictEqual(entry.setupContext.C2.met, true);
assert.strictEqual(journal.recordCompletedAssessment(snapshot, bridge), null, 'duplicate timestamp must be ignored');
assert.strictEqual(journal.recordCompletedAssessment({
    ...snapshot,
    evaluatedAt: '2026-08-05T01:00:10.000Z',
    currentPrice: 237.1
}, bridge), null, 'price-only refresh inside heartbeat window must be ignored');
assert.strictEqual(journal.listEntries({ bridgeId: 'bridge-1' }).length, 1);

const next = journal.recordCompletedAssessment({
    ...snapshot,
    evaluatedAt: '2026-08-05T01:00:10.000Z',
    assessment: { state: 'WAIT FOR CONFIRMATION', confidence: 'Medium' }
}, bridge);
assert.strictEqual(next.assessmentState, 'WAIT FOR CONFIRMATION');
assert.strictEqual(journal.listEntries({ bridgeId: 'bridge-1' })[0].assessmentState, 'WAIT FOR CONFIRMATION');

const heartbeat = journal.recordCompletedAssessment({
    ...snapshot,
    evaluatedAt: '2026-08-05T01:15:10.000Z',
    assessment: { state: 'WAIT FOR CONFIRMATION', confidence: 'Medium' }
}, bridge);
assert.ok(heartbeat, 'unchanged state is retained as a 15-minute heartbeat');

console.log('assessment-journal tests passed');
