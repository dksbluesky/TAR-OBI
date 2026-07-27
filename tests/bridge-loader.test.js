'use strict';

const assert = require('node:assert/strict');
const modulePath = require.resolve('../bridge-loader.js');

function createStorage(entries = {}) {
    const values = new Map(Object.entries(entries));
    return {
        values,
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); }
    };
}

function loadConsumer(storage) {
    global.localStorage = storage;
    delete require.cache[modulePath];
    return require(modulePath);
}

function validBridge(overrides = {}) {
    return {
        version: '1.0',
        bridgeId: 'bridge-001',
        ticker: '006208',
        createdAt: '2026-07-27T02:00:00.000Z',
        sourceApplication: 'ETF_DCA-plan',
        marketTimeframe: '1d',
        marketLevelTimeframe: '60m',
        marketSessionState: 'CLOSED',
        zoneMode: 'aggressive',
        activeZone: { low: 235.25, high: 235.6 },
        preferredEntry: null,
        maximumEntryPrice: null,
        invalidationLevel: 232.5,
        h1H2Status: { type: 'H2' },
        C1: { met: true },
        C2: { met: true },
        C3: { met: false },
        C4: { classification: 'Qualified', confirmed: true },
        setupStatus: { label: 'Ready', provisional: false },
        extensions: {},
        ...overrides
    };
}

const storage = createStorage({
    'etfDca.executionBridge.v1': JSON.stringify(validBridge()),
    fugle_symbol: '2330'
});
let consumer = loadConsumer(storage);

assert.equal(consumer.validateBridge(validBridge()), true);
assert.equal(consumer.validateBridge(validBridge({ version: '2.0' })), false);
assert.equal(consumer.validateBridge(validBridge({ ticker: '' })), false);
assert.equal(consumer.validateBridge(validBridge({ activeZone: { low: 240, high: 230 } })), false);
assert.equal(consumer.initialize().mode, 'linked');

const tickerInput = { value: '2330' };
consumer.populateLinkedTicker(tickerInput);
assert.equal(tickerInput.value, '006208');
assert.equal(consumer.handleSymbolInput('006208'), 'linked');
assert.equal(consumer.handleSymbolInput('0050'), 'standalone');
assert.equal(storage.values.get('etfDca.executionBridge.v1'), JSON.stringify(validBridge()));
assert.equal(storage.values.get(consumer.DISMISSED_KEY), 'bridge-001');
assert.equal(tickerInput.value, '006208');

consumer = loadConsumer(storage);
assert.equal(consumer.initialize().mode, 'standalone');

storage.values.set('etfDca.executionBridge.v1', JSON.stringify(validBridge({ bridgeId: 'bridge-002' })));
consumer = loadConsumer(storage);
assert.equal(consumer.initialize().mode, 'linked');

const fields = new Map();
const disconnectButton = {
    addEventListener(eventName, handler) {
        assert.equal(eventName, 'click');
        this.click = handler;
    }
};
const backButton = {
    addEventListener(eventName, handler) {
        assert.equal(eventName, 'click');
        this.click = handler;
    }
};
const panel = {
    innerHTML: '',
    classList: { add() {}, remove() {} },
    querySelector(selector) {
        if (selector === '[data-bridge-back]') return backButton;
        if (selector === '[data-bridge-disconnect]') return disconnectButton;
        const match = selector.match(/data-bridge-field="([^"]+)"/);
        if (!match) return null;
        if (!fields.has(match[1])) fields.set(match[1], { textContent: '' });
        return fields.get(match[1]);
    }
};

let disconnected = false;
consumer.renderContextPanel(panel, { onDisconnect() { disconnected = true; } });
assert.doesNotMatch(panel.innerHTML, /<input|<select|contenteditable/i);
assert.doesNotMatch(panel.innerHTML, /href="https:\/\/dksbluesky\.github\.io\/ETF_DCA-plan\/"/);
assert.match(panel.innerHTML, /data-bridge-back[^>]*>Back to ETF_DCA-plan<\/button>/);
assert.equal(fields.get('ticker').textContent, '006208');
assert.equal(fields.get('timeframe').textContent, '60m');
assert.equal(fields.get('active-zone').textContent, '235.25 ~ 235.6');
assert.equal(fields.get('h-signal').textContent, 'H2');
assert.equal(fields.get('c1').textContent, '✓');
assert.equal(fields.get('c3').textContent, 'Pending');
disconnectButton.click();
assert.equal(disconnected, true);
assert.equal(consumer.getMode(), 'standalone');
assert.ok(storage.values.has('etfDca.executionBridge.v1'));

const malformedStorage = createStorage({ 'etfDca.executionBridge.v1': '{invalid' });
consumer = loadConsumer(malformedStorage);
assert.equal(consumer.readBridge(), null);
assert.equal(consumer.initialize().mode, 'standalone');

consumer = loadConsumer({
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); }
});
assert.equal(consumer.initialize().mode, 'standalone');

const emptyStorage = createStorage();
consumer = loadConsumer(emptyStorage);
const standaloneInput = { value: '2330' };
assert.equal(consumer.initialize().mode, 'standalone');
assert.equal(consumer.populateLinkedTicker(standaloneInput), null);
assert.equal(standaloneInput.value, '2330');
assert.equal(emptyStorage.values.size, 0);

console.log('bridge loader tests passed');
