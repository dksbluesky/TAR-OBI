'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const elements = new Map();
function element(id) {
    if (!elements.has(id)) elements.set(id, {
        textContent: '', innerHTML: '', className: '', disabled: false,
        classList: { add() {}, remove() {} }, addEventListener() {}
    });
    return elements.get(id);
}
const context = {
    console, Date, Intl, Number, Math,
    document: { getElementById: element, addEventListener() {} },
    localStorage: { getItem: () => null },
    setInterval: () => 1, clearInterval() {},
    addEventListener() {}
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared-market.js'), 'utf8'), context);
const html = fs.readFileSync(path.join(__dirname, '..', 'daytrade-30m-playbook.html'), 'utf8');
const source = html.match(/<script>\s*(\(\(\) => \{[\s\S]*?)<\/script>/)?.[1];
assert.ok(source, 'playbook script is available');
vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'window.playbookTest = { completedTodayBars, openingHypothesis, confirmedSwings, intradayStructure, reassessPostOr30, renderPriceAction, render }; })();'), context);
const { completedTodayBars, openingHypothesis, confirmedSwings, intradayStructure, reassessPostOr30, renderPriceAction, render } = context.playbookTest;

const day = '2026-07-27';
const at = (time) => Date.parse(`${day}T${time}:00+08:00`);
const bar = (time, close, low = 99, high = 101, volume = 600) => ({
    date: `${day}T${time}:00+08:00`, open: close, high, low, close, volume
});
const opening = ['09:00', '09:05', '09:10', '09:15', '09:20', '09:25']
    .map(time => bar(time, 100));
const breakout = bar('09:30', 102, 100.5, 102.2, 1000);
function quote(time, lastPrice = 102.5) {
    return { date: day, lastUpdated: at(time), lastPrice, previousClose: 99,
        openPrice: 100 };
}
function title(bars, time, lastPrice = 102.5, quoteTime = time) {
    render(quote(quoteTime, lastPrice), { data: bars }, new Date(at(time)), '006208', at(time));
    return element('structure-title').textContent;
}

assert.equal(completedTodayBars({ data: opening }, new Date(at('09:29'))).length, 5,
    'the 09:25 candle is incomplete at 09:29');
assert.equal(completedTodayBars({ data: [opening[1], ...opening, bar('09:30', 102)] },
    new Date(at('09:30'))).length, 6, 'duplicates and the unfinished 09:30 candle are excluded');
assert.equal(completedTodayBars({ data: [...opening,
    { ...opening[0], date: '2026-07-24T09:00:00+08:00' }] },
    new Date(at('09:30'))).length, 6, 'previous-day candles are excluded');
assert.equal(title([opening[0], opening[1], opening[2], opening[3], opening[5]], '09:31'),
    '開盤區間資料不足', 'a missing opening slot cannot complete OR30');
assert.equal(openingHypothesis(opening, 99, 100, 101, 99, 600).label,
    '區間震盪，方向尚未確認；開盤相對昨收略有優勢',
    'a flat opening must not turn a gap into a directional trend');
assert.match(openingHypothesis(opening, 99, 100, 101, 99, 600).counter, /後三根總量未高於前三根/);
const risingOpening = opening.map((item, index) => ({ ...item, close: 100 + index * 0.15, high: 101.2 }));
assert.equal(openingHypothesis(risingOpening, 99, 100, 101.2, 99, 600).label,
    '區間震盪，略偏多', 'actual closing progress can support a conditional bullish opening');
assert.equal(openingHypothesis(opening, null, 100, 101, 99, 600), null,
    'missing opening evidence cannot produce a directional hypothesis');
assert.equal(confirmedSwings([
    { high: 10, low: 8 }, { high: 12, low: 9 }, { high: 11, low: 8.5 },
    { high: 13, low: 10 }, { high: 12, low: 9 }, { high: 14, low: 11 },
    { high: 13, low: 10 }
]).high, 'HH 較高高點', 'completed bars confirm successive higher highs');
assert.equal(confirmedSwings([
    { high: 10, low: 8 }, { high: 12, low: 9 }, { high: 11, low: 8.5 },
    { high: 13, low: 10 }, { high: 12, low: 9 }, { high: 14, low: 11 },
    { high: 13, low: 10 }
]).low, 'HL 較高低點', 'completed bars confirm successive higher lows');
const fallingSwings = confirmedSwings([
    { high: 10, low: 8 }, { high: 14, low: 9 }, { high: 11, low: 7.5 },
    { high: 13, low: 8 }, { high: 10, low: 7 }, { high: 12, low: 8 },
    { high: 9, low: 6.5 }
]);
assert.equal(fallingSwings.high, 'LH 較低高點', 'completed bars confirm successive lower highs');
assert.equal(fallingSwings.low, 'LL 較低低點', 'completed bars confirm successive lower lows');
const localRange = [
    { high: 100.8, low: 99.5, close: 100.2 },
    { high: 100.7, low: 99.6, close: 100.3 },
    { high: 100.8, low: 99.5, close: 100.4 },
    { high: 100.7, low: 99.6, close: 100.3 }
];
assert.equal(intradayStructure([...localRange, { high: 100.7, low: 99.6, close: 100.5 }],
    confirmedSwings(localRange), 101, 99, 100.5).label, '盤中新區間內整理');
assert.equal(intradayStructure([...localRange, { high: 100.95, low: 100.1, close: 100.9 }],
    { latestHigh: null, latestLow: null }, 101, 99, 100.9).label, '突破近四根盤中區間',
    'a later local breakout is visible before OR30 high is crossed');
assert.equal(intradayStructure([{ high: 100.5, low: 99.9, close: 100.1 }],
    { latestLow: { low: 100.2 }, latestHigh: null, high: '不足', low: '不足' },
    101, 99, 100.1).label, '盤中支撐失守', 'a confirmed local support failure is recognized inside OR30');
assert.equal(intradayStructure([{ high: 100.6, low: 100.2, close: 100.4 }],
    { latestLow: { low: 100.2 }, latestHigh: null, high: '不足', low: '不足' },
    101, 99, 100.4).label, '盤中支撐回測暫守');
assert.match(intradayStructure([{ high: 10, low: 7.5, close: 8 }],
    { latestHigh: { high: 13 }, latestLow: { low: 7 }, high: 'LH 較低高點', low: 'LL 較低低點' },
    14, 6, 8).detail, /LH 較低高點.*LL 較低低點/);
assert.match(title(opening, '09:30', 100.5), /CHECK LATER/);
assert.match(element('opening-hypothesis').textContent, /方向尚未確認；開盤相對昨收略有優勢/);
assert.match(element('opening-decision').textContent, /09:30 觀察決定：CHECK LATER/);
assert.equal(title(risingOpening, '09:30', 100.8), 'CONTINUE',
    'a directional 09:30 opening can recommend watching before any post-OR30 candle completes');
assert.match(element('structure-reason').textContent, /尚無區間後完成K/);
const fallingOpening = opening.map((item, index) => ({ ...item, close: 100 - index * 0.15 }));
assert.equal(title(fallingOpening, '09:30', 99.2), 'CHECK LATER',
    'a bearish opening alone is a temporary step-away decision, not a completed breakdown');
assert.match(element('opening-decision').textContent, /暫避偏多/);
const localBars = ['09:30', '09:35', '09:40', '09:45'].map((time, index) =>
    bar(time, localRange[index].close, localRange[index].low, localRange[index].high));
assert.equal(title([...opening, ...localBars, bar('09:50', 100.5, 99.6, 100.7)],
    '09:56', 100.5), 'CHECK LATER');
assert.match(element('structure-pattern').textContent, /盤中新區間內整理/);
assert.match(element('structure-watch').textContent, /100\.80/);
assert.match(element('event-timeline').innerHTML, /09:55 盤中新區間內整理/);
assert.equal(title([...opening, ...localBars, bar('09:50', 100.9, 100.1, 100.95)],
    '09:56', 100.9), 'CONTINUE', 'a fresh qualified intraday breakout can restore attention inside OR30');
assert.match(element('structure-pattern').textContent, /突破盤中阻力/);
assert.match(element('structure-reason').textContent, /新盤中阻力/);
assert.match(element('structure-change').textContent, /09:30 CHECK LATER.*現在 CONTINUE/);
assert.match(element('structure-watch').textContent, /100\.80/);
assert.match(element('event-timeline').innerHTML, /09:55 突破盤中阻力/);
assert.doesNotMatch(element('event-timeline').innerHTML, /10:05/,
    'the history must not list a future local support failure');
assert.equal(title([...opening, ...localBars, bar('09:50', 100.5, 99.6, 100.7),
    bar('09:55', 100.9, 100.1, 100.95), bar('10:00', 99.4, 99.3, 100)],
    '10:05', 99.4), 'HIGH RISK / AVOID FOR NOW', 'later local support loss changes the current attention decision');
assert.match(element('event-timeline').innerHTML, /10:05 盤中支撐失守/);
assert.match(title([...opening, ...localBars, bar('09:50', 100.9, 100.1, 100.95)],
    '10:10', 100.9, '09:55'), /CHECK LATER/);
assert.equal(element('structure-pattern').textContent, '目前無有效盤中結構',
    'stale market data cannot claim a current local breakout');
assert.doesNotMatch(element('event-timeline').innerHTML, /09:35|11:15/,
    'the 09:30 view contains no future events');
assert.equal(title([...opening, breakout], '09:36'), 'CONTINUE');
assert.match(element('event-timeline').innerHTML, /09:35 向上突破/,
    'the event time is the completion time of the confirming candle');
assert.equal(title([...opening, breakout, bar('11:15', 103, 101.5, 103.2, 1000)],
    '09:36'), 'CONTINUE');
assert.doesNotMatch(element('event-timeline').innerHTML, /11:15/,
    'an unfinished future candle cannot enter the event history');
assert.equal(title([...opening, breakout, bar('09:35', 100.9, 100.8, 101.3)],
    '09:41', 100.9), 'CHECK LATER', 'a returned breakout is no longer current');
assert.match(element('structure-change').textContent, /向上突破失效/);
assert.equal(title([...opening, breakout, bar('09:35', 100.9, 100, 101.3)],
    '09:41', 100.9), 'HIGH RISK / AVOID FOR NOW');
assert.match(element('structure-reason').textContent, /不是全天不安全的預測/);
assert.match(element('report-structure').textContent, /暫時高風險/);
assert.match(element('report-evidence').innerHTML, /歷史上曾有/);
assert.equal(title([...opening, breakout, bar('09:35', 100.9, 100, 101.3),
    bar('09:40', 103, 101.5, 103.2, 1000)], '09:46', 103.1), 'CONTINUE',
    'a fresh qualified breakout can restore attention');
assert.match(element('structure-pattern').textContent, /再次向上突破/);
assert.equal(title([...opening, breakout], '09:46', 102.5, '09:35'),
    '資料非即時 / CHECK LATER', 'an old quote revokes current attention');
assert.equal(title([...opening, breakout], '09:36', 102.5, '09:40'),
    '資料非即時 / CHECK LATER', 'a future quote cannot create current attention');
const lateTimes = ['09:30', '09:35', '09:40', '09:45', '09:50', '09:55', '10:00',
    '10:05', '10:10', '10:15', '10:20'];
const quietLate = lateTimes.map((time, index) => bar(time, index % 2 ? 100.2 : 100.1,
    99.7, 100.6, 600));
assert.equal(title([...opening, ...quietLate], '10:26', 100.2), 'CHECK LATER');
assert.equal(title([...opening, ...quietLate, bar('10:25', 100.8, 100.1, 100.9, 900)],
    '10:31', 100.8), 'CONTINUE', 'a new trend can warrant attention well after the 09:30 initial decision');
assert.match(element('structure-reason').textContent, /新盤中阻力/);
assert.match(element('intraday-evidence').textContent, /最近四根完成K/);
assert.equal(title([...opening, ...quietLate, bar('10:25', 100.8, 100.1, 100.9, 900),
    bar('10:30', 100.5, 100, 100.9, 600)], '10:36', 100.5), 'CHECK LATER',
    'a later failed intraday breakout revokes continued watching');
assert.match(element('structure-reason').textContent, /收回/);
assert.equal(title([...opening, ...quietLate, bar('10:30', 100.8, 100.1, 100.9, 900)],
    '10:36', 100.8), '資料不足 / CHECK LATER', 'a missing 10:25 candle blocks trend reassessment');
const pattern = { candleFresh: true, latest: { close: 101 }, ratio: 1.5,
    priceVolume: 'RISING_EXPANDING', rangeHigh: 102 };
renderPriceAction(null, false);
assert.equal(element('pa-second-state').textContent, 'INSUFFICIENT DATA');
renderPriceAction({ ...pattern, secondAttempt: true }, true, 100, 100.5);
assert.equal(element('pa-second-state').textContent, 'DEVELOPING');
assert.equal(element('pa-reversal-state').textContent, 'NOT DETECTED');
renderPriceAction({ ...pattern, rapidBreakBelowOpen: true }, true, 100, 100.5);
assert.equal(element('pa-reversal-state').textContent, 'CONFIRMED');
renderPriceAction({ ...pattern, failedReclaim: true }, true, 100, 100.5);
assert.equal(element('pa-weak-state').textContent, 'CONFIRMED');
renderPriceAction({ ...pattern, gradualVwapRise: true }, true, 100, 100.5);
assert.equal(element('pa-gradual-state').textContent, 'DEVELOPING');
assert.match(element('pa-category-evidence').innerHTML, /RISING_EXPANDING/);
console.log('daytrade 30m playbook tests passed');
