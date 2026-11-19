'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const fixedNow = Date.parse('2026-11-18T10:00:00+08:00');
class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
}
const saved = new Map();
const localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value))
};
const requests = [];
let rejectIntraday = false;
let linkedBridge = null;
const savedPortfolio = { dca: [{ ticker: '006208', watchCriteria: {
    zoneMode: 'manual', activeZoneSource: 'manual_reassessment',
    manualReassessment: { manualZoneSource: 'MANUAL', manualAppliedAt: '2026-11-18T08:00:00.000Z',
        activeManualZone: { low: 203, high: 209 } }
} }], direct: [], lastUpdated: '2026-11-18T08:30:00.000Z' };
const quoteFor = symbol => ({
    date: '2026-11-18', symbol, name: '測試標的', lastUpdated: fixedNow,
    lastPrice: 101, closePrice: 101, previousClose: 100, openPrice: 100,
    avgPrice: 100.5, isOpen: true, isContinuous: true,
    bids: [{ price: 100.9, size: 500 }], asks: [{ price: 101, size: 450 }],
    total: { tradeVolumeAtAsk: 9000, tradeVolumeAtBid: 7000, tradeVolume: 16000 }
});
const candles = { data: [
    { date: '2026-11-18T09:00:00+08:00', open: 100, high: 101, low: 99.8, close: 100.5, volume: 500, average: 100.2 },
    { date: '2026-11-18T09:05:00+08:00', open: 100.5, high: 101.2, low: 100.2, close: 101, volume: 600, average: 100.5 }
] };
async function fetchFixture(url, options) {
    requests.push({ url, key: options?.headers?.['X-API-KEY'] });
    if (url.includes('api.github.com/repos/dksbluesky/ETF_DCA-plan/contents/portfolio-data.json')) {
        return { ok: true, status: 200, json: async () => ({ encoding: 'base64',
            content: Buffer.from(JSON.stringify(savedPortfolio), 'utf8').toString('base64') }) };
    }
    if (rejectIntraday && url.includes('/intraday/')) throw new Error('fixture offline');
    const symbol = url.match(/\/([^/?]+)(?:\?|$)/)?.[1] || '006208';
    const payload = url.includes('/intraday/quote/') ? quoteFor(symbol)
        : url.includes('/intraday/candles/') ? candles : { data: [] };
    return { ok: true, status: 200, json: async () => payload };
}
function page(file, search = '', hash = '') {
    const elements = new Map();
    const intervals = [];
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            value: '', textContent: '', innerHTML: '', className: '', href: '', hidden: false,
            disabled: false, checked: false, dataset: {}, style: {}, clientWidth: 660,
            parentElement: { dataset: {} }, options: [], listeners: {},
            classList: { add() {}, remove() {}, toggle() {} },
            addEventListener(type, callback) { this.listeners[type] = callback; },
            setAttribute(name, value) { this[name] = value; },
            appendChild(child) { this.options.push(child); },
            remove(index) { this.options.splice(index, 1); },
            focus() {}
        });
        return elements.get(id);
    }
    element('opening-replay').value = 'current';
    element('opening-replay').options.push({ value: 'current' });
    element('settings-panel').hidden = true;
    const context = {
        Date: FixedDate, Intl, Number, Math, console, URLSearchParams, AbortController, atob, TextDecoder,
        setTimeout, clearTimeout, setInterval: callback => { intervals.push(callback); return intervals.length; }, clearInterval() {},
        localStorage, location: { search, hash }, fetch: fetchFixture,
        document: { getElementById: element, createElement: () => ({ value: '', textContent: '' }),
            querySelectorAll: () => [], hidden: false, addEventListener() {} },
        addEventListener() {}, TarObiBridge: {
            populateLinkedTicker() {}, handleSymbolInput() {}, getLinkedBridge() { return linkedBridge; }
        }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'shared-market.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(root, 'repo-zone-link.js'), 'utf8'), context);
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const scripts = [...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].map(match => match[1]);
    vm.runInContext(scripts.at(-1).replace(/\}\)\(\);\s*$/, 'window.dashboardTest = { aggregate }; })();'), context);
    return { html, context, element, intervals, aggregate: context.dashboardTest?.aggregate };
}
function emit(target, type) {
    assert.ok(target.listeners[type], `missing ${type} listener`);
    return target.listeners[type]({ target, currentTarget: target, preventDefault() {} });
}
async function until(predicate) {
    for (let i = 0; i < 50; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.fail('page did not finish the mocked refresh');
}

(async () => {
    const dashboard = page('index.html', '?symbol=006208', '#settings');
    const day = '2026-11-18';
    const bars = Array.from({ length: 8 }, (_, index) => ({
        start: Date.parse(`${day}T09:00:00+08:00`) + index * 300000,
        date: day, minute: 540 + index * 5, open: 100, high: 101,
        low: 99, close: 100, volume: 100, average: 100
    }));
    const asOf = Date.parse(`${day}T09:40:00+08:00`);
    for (const [period, complete] of [[5, 8], [15, 2], [30, 1], [60, 0], [120, 0]]) {
        const groups = dashboard.aggregate(bars, period, day, asOf);
        assert.equal(groups.filter(group => group.complete && !group.sessionShort).length, complete,
            `${period}-minute trend uses only completed candles`);
    }
    assert.equal(dashboard.element('symbol').value, '006208');
    assert.match(dashboard.html, /id="settings-api-key"/);
    assert.match(dashboard.html, /id="zone-sync"[^>]*>[^<]*同步 Active Zone<\/button><button id="settings-toggle"/);
    await emit(dashboard.element('zone-sync'), 'click');
    assert.match(dashboard.element('zone-link-status').textContent, /GitHub 區間已連結.*203\.00–209\.00/);
    assert.equal(JSON.parse(saved.get('tarObi.repoActiveZoneLink.v1')).ticker, '006208');
    const repoCalls = () => requests.filter(request => request.url.includes('api.github.com/repos/dksbluesky/ETF_DCA-plan')).length;
    assert.equal(repoCalls(), 1);
    linkedBridge = { ticker: '006208', activeZone: { low: 203, high: 209 } };
    await emit(dashboard.element('zone-sync'), 'click');
    assert.equal(repoCalls(), 2, 'sync checks GitHub even when a Bridge exists');
    assert.match(dashboard.element('zone-link-status').textContent, /與 GitHub 區間一致/);
    linkedBridge = { ticker: '006208', activeZone: { low: 238, high: 243 } };
    await emit(dashboard.element('zone-sync'), 'click');
    assert.equal(repoCalls(), 3);
    assert.match(dashboard.element('zone-link-status').textContent,
        /區間不一致：目前 Bridge 238\.00–243\.00；ETF_DCA GitHub 203\.00–209\.00/);
    assert.match(dashboard.element('zone-link-status').textContent, /進場評估仍使用原 Bridge/);
    assert.equal(dashboard.element('zone-link-status').className, 'zone-link-status error');
    assert.deepEqual(linkedBridge.activeZone, { low: 238, high: 243 }, 'sync never rewrites an existing Bridge');
    const reopenedWithMismatch = page('index.html', '?symbol=006208');
    assert.match(reopenedWithMismatch.element('zone-link-status').textContent, /區間不一致/,
        'a reopened dashboard still warns about a saved mismatch');
    linkedBridge = null;
    await emit(dashboard.element('source-form'), 'submit');
    assert.match(dashboard.element('status').textContent, /設定.*Fugle API Key/);
    assert.equal(dashboard.element('settings-panel').hidden, false);
    emit(dashboard.element('settings-toggle'), 'click');
    assert.equal(dashboard.element('settings-panel').hidden, true);
    emit(dashboard.element('settings-toggle'), 'click');
    assert.equal(dashboard.element('settings-panel').hidden, false);
    dashboard.element('settings-api-key').value = 'fixture-key';
    emit(dashboard.element('settings-form'), 'submit');
    await until(() => dashboard.element('price').textContent === '101.00');
    assert.match(dashboard.element('chart').innerHTML, /現價 101\.00/, 'live chart labels the current price');
    assert.equal(saved.get('fugle_api_key'), 'fixture-key');
    assert.equal(saved.get('fugle_symbol'), '006208');
    assert.ok(requests.some(request => request.url.includes('/intraday/quote/006208') && request.key === 'fixture-key'));
    await until(() => dashboard.element('status').textContent.includes('歷史 K 不可用'));
    const historicalRequests = () => requests.filter(request => request.url.includes('/historical/candles/')).length;
    assert.equal(historicalRequests(), 1);
    dashboard.intervals[0]();
    await until(() => requests.filter(request => request.url.includes('/intraday/quote/006208')).length === 2);
    assert.equal(historicalRequests(), 1, 'live refresh uses the historical retry window');
    await until(() => dashboard.element('refresh').disabled === false);
    assert.equal(dashboard.element('entry-stale').hidden, true);
    rejectIntraday = true;
    await emit(dashboard.element('source-form'), 'submit');
    rejectIntraday = false;
    assert.equal(dashboard.element('market-session').textContent, 'STALE');
    for (const id of ['tar-obi-stale', 'entry-stale', 'structure-stale'])
        assert.equal(dashboard.element(id).hidden, false, `${id} marks retained data as stale`);
    assert.match(dashboard.element('source-time').textContent, /上次資料/);
    assert.match(dashboard.html, /\.time\{text-align:left\}/, 'quote time remains visible on mobile');
    const marketStructureHtml = fs.readFileSync(path.join(root, 'daytrade-30m-playbook.html'), 'utf8');
    assert.match(marketStructureHtml, /href="\.\/index\.html" class="[^"]*whitespace-nowrap[^"]*">← Back to Dashboard/);
    dashboard.element('symbol').value = '0050';
    emit(dashboard.element('symbol'), 'input');
    assert.match(dashboard.element('calculator-link').href, /calculator\.html\?symbol=0050/);
    assert.match(dashboard.element('entry-link').href, /entry-assessment\.html\?symbol=0050/);
    assert.match(dashboard.element('structure-link').href, /daytrade-30m-playbook\.html\?symbol=0050/);
    assert.doesNotMatch(dashboard.element('structure-link').href, /fixture-key/);
    emit(dashboard.element('calculator-link'), 'click');
    assert.equal(saved.get('fugle_symbol'), '0050');

    const calculator = page('calculator.html', '?symbol=0050');
    assert.doesNotMatch(calculator.html, /id="api-key-input"/);
    calculator.context.onload();
    assert.equal(calculator.element('symbol-display').textContent, '0050');
    await emit(calculator.element('fetch-btn'), 'click');
    assert.ok(requests.some(request => request.url.includes('/intraday/quote/0050') && request.key === 'fixture-key'));
    assert.match(calculator.element('api-status').textContent, /0050/);
    const reopened = page('index.html');
    assert.equal(reopened.element('symbol').value, '0050');
    assert.equal(reopened.element('settings-api-key').value, '', 'the stored key is not copied into the input');
    await until(() => reopened.element('price').textContent === '101.00');
    console.log('dashboard settings, ticker navigation, and calculator shared-key tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
