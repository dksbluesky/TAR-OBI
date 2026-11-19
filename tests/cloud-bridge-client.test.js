const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const code = fs.readFileSync(require.resolve('../cloud-bridge.js'), 'utf8');
const key = 'A'.repeat(43);
const source = id => ({ version: '1.0', bridgeId: id, ticker: '006208',
    createdAt: id === 'new' ? '2026-11-19T02:00:00Z' : '2026-11-19T01:00:00Z',
    sourceApplication: 'ETF_DCA-plan', marketTimeframe: '1d', activeZone: { low: 203, high: 209 } });
const values = new Map([['tarObi.cloudBridge.url.v1', 'https://sync.example'],
    ['tarObi.cloudBridge.pairingKey.v1', key]]);
let current = source('old');
let remote = source('new');
let fetches = 0;
let reloads = 0;
const sandbox = {
    URL, AbortController, Date, module: { exports: {} },
    setTimeout, clearTimeout,
    localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
    TarObiBridge: {
        validateBridge: bridge => Boolean(bridge?.bridgeId),
        readBridge: () => current,
        linkBridge: bridge => { current = bridge; return bridge; }
    },
    location: { reload: () => { reloads++; } },
    fetch: async () => { fetches++; return new Response(JSON.stringify({ bridge: remote })); }
};
vm.runInNewContext(code, sandbox);
const client = sandbox.module.exports;

(async () => {
    assert.equal(await client.pull(), false, 'cloud is disabled by default');
    assert.equal(fetches, 0, 'disabled client does not call the network');
    values.set(client.ENABLED_KEY, 'true');
    assert.equal(await client.pull(), true);
    assert.equal(current.bridgeId, 'new', 'new cloud monitor replaces old local monitor');
    assert.equal(client.isVerified('new'), true);
    assert.equal(reloads, 1, 'new monitor reloads the page to adopt its context');

    const oldResult = { evaluatedAt: '2026-11-19T02:01:00Z', assessmentState: 'OLD' };
    current.monitorResult = oldResult;
    remote = { ...remote, monitorResult: { evaluatedAt: '2026-11-19T02:02:00Z', assessmentState: 'NEW' } };
    assert.equal(await client.pull(), true);
    assert.equal(current.monitorResult.assessmentState, 'NEW');

    current.monitorResult = { evaluatedAt: '2026-11-19T02:03:00Z', assessmentState: 'LOCAL_NEWER' };
    assert.equal(await client.pull(), true);
    assert.equal(current.monitorResult.assessmentState, 'LOCAL_NEWER', 'newer local assessment is preserved');

    current.lifecycle = { status: 'COMPLETED', updatedAt: '2026-11-19T02:03:00Z' };
    remote = { ...remote, lifecycle: { status: 'ACTIVE', updatedAt: '2026-11-19T02:04:00Z' } };
    assert.equal(await client.pull(), true);
    assert.equal(current.lifecycle.status, 'COMPLETED', 'cloud cannot reopen a completed local monitor');

    current.lifecycle = { status: 'ACTIVE', updatedAt: '2026-11-19T02:05:00Z' };
    remote = { ...remote, lifecycle: { status: 'EXPIRED', updatedAt: '2026-11-19T02:04:00Z' } };
    assert.equal(await client.pull(), true);
    assert.equal(current.lifecycle.status, 'EXPIRED', 'terminal cloud lifecycle wins over a later active timestamp');

    remote = source('old');
    assert.equal(await client.pull(), false, 'older cloud monitor cannot replace a newer local one');
    assert.equal(current.bridgeId, 'new');
    console.log('TAR-OBI Cloud Bridge client tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
