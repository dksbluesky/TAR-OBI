import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleRequest } from '../cloud-sync/worker.mjs';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../cloud-sync/schema.sql', import.meta.url), 'utf8'));
const DB = {
    prepare(sql) {
        return {
            bind(...values) {
                const statement = sqlite.prepare(sql);
                return {
                    async first() { return statement.get(...values) || null; },
                    async run() { return { meta: { changes: statement.run(...values).changes } }; }
                };
            }
        };
    }
};
const env = { DB };
const key = 'A'.repeat(43);
const url = 'https://sync.example/v1/';
const origin = 'https://dksbluesky.github.io';
const bridge = (bridgeId, createdAt, lifecycle = 'ACTIVE') => ({
    version: '1.0', bridgeId, ticker: '006208', createdAt, sourceApplication: 'ETF_DCA-plan', marketTimeframe: '1d',
    activeZone: { low: 203, high: 209 }, lifecycle: { status: lifecycle, updatedAt: createdAt },
    monitorResult: null
});
async function call(path, method = 'GET', body, override = {}) {
    const headers = { Origin: origin, Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...override.headers };
    const response = await handleRequest(new Request(url + path, {
        method, headers, ...(body ? { body: JSON.stringify(body) } : {})
    }), env);
    return { status: response.status, body: response.status === 204 ? null : await response.json(),
        origin: response.headers.get('Access-Control-Allow-Origin') };
}

assert.equal((await call('bridge')).status, 404);
const first = bridge('first', '2026-11-19T01:00:00.000Z');
assert.equal((await call('source', 'PUT', { bridge: first, sentAt: '2026-11-19T01:00:01.000Z' })).status, 200);
const initial = await call('bridge');
assert.equal(initial.body.bridge.bridgeId, 'first');
assert.equal(initial.origin, origin);
assert.equal((await call('bridge', 'GET', null, { headers: { Authorization: `Bearer ${'B'.repeat(43)}` } })).status, 404,
    'another pairing key cannot read this Bridge');
const assessment = { ...first, monitorResult: { evaluatedAt: '2026-11-19T01:05:00.000Z', assessmentState: 'WAIT_FOR_CONFIRMATION' } };
assert.equal((await call('result', 'PUT', { bridge: assessment, sentAt: '2026-11-19T01:05:01.000Z' })).status, 200);
assert.equal((await call('bridge')).body.bridge.monitorResult.assessmentState, 'WAIT_FOR_CONFIRMATION');
const olderAssessment = { ...first, monitorResult: { evaluatedAt: '2026-11-19T01:04:00.000Z', assessmentState: 'STALE' } };
assert.equal((await call('result', 'PUT', { bridge: olderAssessment, sentAt: '2026-11-19T01:05:02.000Z' })).status, 409,
    'a later upload cannot overwrite a newer assessment with older evidence');
const completed = bridge('first', '2026-11-19T01:00:00.000Z', 'COMPLETED');
completed.lifecycle.updatedAt = '2026-11-19T01:06:00.000Z';
assert.equal((await call('source', 'PUT', { bridge: completed, sentAt: '2026-11-19T01:06:01.000Z' })).status, 200);
assert.equal((await call('bridge')).body.bridge.lifecycle.status, 'COMPLETED', 'a stale assessment cannot reopen a completed monitor');
const second = bridge('second', '2026-11-19T01:10:00.000Z');
assert.equal((await call('source', 'PUT', { bridge: second, sentAt: '2026-11-19T01:10:01.000Z' })).status, 200);
assert.equal((await call('bridge')).body.bridge.monitorResult, null, 'new monitor clears old assessment');
assert.equal((await call('result', 'PUT', { bridge: assessment, sentAt: '2026-11-19T01:11:00.000Z' })).status, 409,
    'late results from the prior Bridge are rejected');
assert.equal((await call('source', 'PUT', { bridge: first, sentAt: '2026-11-19T01:12:00.000Z' })).status, 409,
    'the earlier Bridge cannot overwrite the new monitor');
assert.equal((await call('bridge', 'GET', null, { headers: { Authorization: '' } })).status, 401);
assert.equal((await call('bridge', 'GET', null, { headers: { Origin: 'https://other.example' } })).status, 403);
assert.equal((await call('bridge', 'OPTIONS')).status, 204);
sqlite.close();
console.log('Cloud Bridge Worker tests passed');
