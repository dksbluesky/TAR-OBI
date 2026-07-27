const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: {}, Intl };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'shared-market.js'), 'utf8'), context);
const { calculateVolumeQuality } = context.window.MarketData;

const reference = Date.parse('2026-07-27T09:31:00+08:00');
const candle = (time, volume) => ({ date: `2026-07-27T${time}:00+08:00`, volume });
const response = latestVolume => ({ data: [
    candle('09:00', 9999),
    candle('09:05', 80), candle('09:10', 100), candle('09:15', 120), candle('09:20', 100),
    candle('09:25', latestVolume), candle('09:30', 9999),
] });

assert.equal(calculateVolumeQuality(response(59), reference).quality, 'Low');
assert.equal(calculateVolumeQuality(response(60), reference).quality, 'Normal');
assert.equal(calculateVolumeQuality(response(139), reference).quality, 'Normal');
assert.equal(calculateVolumeQuality(response(140), reference).quality, 'Expanding');
assert.equal(calculateVolumeQuality(response(199), reference).quality, 'Expanding');
assert.equal(calculateVolumeQuality(response(200), reference).quality, 'Heavy');

const result = calculateVolumeQuality(response(200), reference);
assert.equal(result.medianVolume, 100, 'opening candle is excluded from baseline');
assert.equal(result.latestVolume, 200, 'latest completed candle is used');
assert.equal(result.sampleCount, 4, 'four earlier completed candles form baseline');
assert.equal(result.ratio, 2);

assert.equal(
    calculateVolumeQuality({ data: [candle('09:05', 100), candle('09:10', 100), candle('09:15', 100), candle('09:20', 100)] }, reference).quality,
    'Unavailable',
    'latest candle plus four earlier candles are required'
);
assert.equal(calculateVolumeQuality(response(200), reference, 'stale').quality, 'Unavailable');
assert.equal(calculateVolumeQuality(response(200), null).quality, 'Unavailable');
assert.equal(calculateVolumeQuality(response(200), Date.parse('2026-07-27T09:42:00+08:00')).quality, 'Unavailable', 'old completed candle data is stale');
assert.equal(
    calculateVolumeQuality(response(200), Date.parse('2026-07-27T09:34:59+08:00')).latestVolume,
    200,
    'incomplete 09:30 candle is excluded before 09:35'
);

console.log('volume quality tests passed');