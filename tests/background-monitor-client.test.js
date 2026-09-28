'use strict';

const assert = require('node:assert/strict');
const modulePath = require.resolve('../background-monitor-client.js');

const values = new Map([
    ['tarObi.backgroundMonitor.url.v1', 'https://monitor.example/'],
    ['tarObi.backgroundMonitor.token.v1', 'secret'],
    ['tarObi.entryAssessment.entryBasis', 'combined'],
    ['tarObi.entryAssessment.invalidationBasis', 'match']
]);
global.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value))
};
let captured;
global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, json: async () => ({ lifecycle: { status: 'ACTIVE' } }) };
};
delete require.cache[modulePath];
const client = require(modulePath);

(async () => {
    await client.syncMonitor({ bridgeId: 'bridge one', ticker: '2330' });
    assert.equal(captured.url, 'https://monitor.example/api/monitors/bridge%20one');
    assert.equal(captured.options.headers.Authorization, 'Bearer secret');
    assert.deepEqual(JSON.parse(captured.options.body).settings, { entryBasis: 'combined', invalidationBasis: 'match' });
    await client.setLifecycle('bridge one', 'pause');
    assert.equal(captured.url, 'https://monitor.example/api/monitors/bridge%20one/pause');
    assert.equal(captured.options.method, 'POST');
    console.log('background monitor client tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
