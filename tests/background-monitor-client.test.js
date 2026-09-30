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
    values.set('tarObi.backgroundMonitor.url.v1', '192.168.68.61 :8080');
    await client.syncMonitor({ bridgeId: 'bridge one', ticker: '2330' });
    assert.equal(captured.url, 'http://192.168.68.61:8080/api/monitors/bridge%20one');

    values.set('tarObi.backgroundMonitor.url.v1', '');
    values.set('tarObi.backgroundMonitor.token.v1', '');
    function element() {
        return {
            listeners: {},
            addEventListener(type, callback) { this.listeners[type] = callback; }
        };
    }
    function createWrapper() {
        const elements = {
            '[data-background-monitor-details]': element(),
            '[data-background-status]': element(),
            '[data-background-url]': element(),
            '[data-background-token]': element(),
            '[data-background-connect]': element()
        };
        return {
            className: '',
            set innerHTML(_html) {},
            querySelector(selector) { return elements[selector]; },
            elements
        };
    }
    global.document = { createElement: createWrapper };
    const container = { children: [], appendChild(child) { this.children.push(child); } };
    const bridge = { bridgeId: 'bridge one', ticker: '2330' };
    client.render(container, bridge);
    let details = container.children[0].elements['[data-background-monitor-details]'];
    assert.equal(details.open, false, 'monitor panel begins collapsed after a fresh page load');
    details.open = true;
    details.listeners.toggle();
    container.children = [];
    client.render(container, bridge);
    details = container.children[0].elements['[data-background-monitor-details]'];
    assert.equal(details.open, true, 'an expanded monitor panel remains open after a UI rerender');
    details.open = false;
    details.listeners.toggle();
    container.children = [];
    client.render(container, bridge);
    details = container.children[0].elements['[data-background-monitor-details]'];
    assert.equal(details.open, false, 'a collapsed monitor panel remains closed after a UI rerender');
    console.log('background monitor client tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
