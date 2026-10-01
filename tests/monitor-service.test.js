'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHttpServer, createMonitorService } = require('../monitor-service.js');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-obi-monitor-'));
const stateFile = path.join(temporaryDirectory, 'state.json');
let clock = new Date('2026-07-27T02:00:00.000Z');
let snapshotTime = clock.toISOString();
let snapshotPrice = 235.5;
const pushes = [];

function bridge() {
    return {
        version: '1.0',
        bridgeId: 'bridge-001',
        ticker: '006208',
        createdAt: '2026-07-27T02:00:00.000Z',
        sourceApplication: 'ETF_DCA-plan',
        marketTimeframe: '1d',
        activeZone: { low: 235.25, high: 235.6 },
        invalidationLevel: 234.8,
        lifecycle: { status: 'ACTIVE', updatedAt: clock.toISOString(), expiresAt: '2099-07-27T05:30:00.000Z' },
        notificationState: {},
        extensions: {
            sourceContextUpdatedAt: '2099-07-27T02:00:00.000Z',
            marketContextV1: { context: 'bullish', automaticZoneEligible: true }
        }
    };
}

function snapshot(record) {
    return {
        complete: true,
        ticker: record.bridge.ticker,
        evaluatedAt: snapshotTime,
        currentPrice: snapshotPrice,
        preferredEntry: { low: 235.25, high: 235.6 },
        maximumEntryPrice: 235.65,
        invalidationLevel: 234.8,
        marketSession: 'live',
        assessment: {
            state: 'ENTRY CONDITIONS MET',
            lower: 235.25,
            upper: 235.6,
            maximum: 235.65,
            invalidation: 234.8,
            wideSpread: false,
            factors: ['Entry conditions met'],
            blockingReason: null
        },
        tarState: 'Buyer Active',
        obiState: 'Bid Dominant',
        vwapState: 'Near VWAP',
        spreadState: 'ACCEPTABLE',
        volumeQuality: 'NORMAL'
    };
}

function serviceOptions(overrides = {}) {
    return {
        stateFile,
        controlToken: 'control-token',
        fugleApiKey: 'fugle-key',
        telegramToken: 'telegram-token',
        telegramChatId: 'chat-id',
        now: () => new Date(clock),
        buildSnapshotImpl: snapshot,
        sendTelegramImpl: async (_fetch, _config, text) => { pushes.push(text); return { ok: true }; },
        fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
        ...overrides
    };
}

async function request(port, method, target, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: target,
            headers: { Authorization: 'Bearer control-token', 'Content-Type': 'application/json', ...headers }
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject);
        if (body) request.write(JSON.stringify(body));
        request.end();
    });
}

(async () => {
    const service = createMonitorService(serviceOptions());
    service.putMonitor(bridge(), { entryBasis: 'combined', invalidationBasis: 'match', interval: 10 });
    assert.equal(service.state.monitors['bridge-001'].bridge.lifecycle.status, 'ACTIVE', 'Start stores an active monitor');
    assert.equal(service.lifecycle('bridge-001', 'pause').bridge.lifecycle.status, 'PAUSED');
    assert.equal(service.lifecycle('bridge-001', 'resume').bridge.lifecycle.status, 'ACTIVE');

    const first = await service.evaluate('bridge-001', { quote: {}, candles: null });
    assert.equal(first.bridge.notificationState.continuousValidity.status, 'PENDING');
    assert.equal(first.event, 'STARTED');
    assert.equal(first.pushed, true);
    assert.equal(pushes.length, 1, 'the first evaluation sends one startup status message');
    assert.match(pushes[0], /TAR-OBI MONITOR STARTED/);
    assert.match(pushes[0], /Live Confirmation: PENDING/);
    assert.match(pushes[0], /Bridged Active Zone: 235\.25–235\.6/);

    clock = new Date('2026-07-27T02:01:31.000Z');
    snapshotTime = clock.toISOString();
    const live = await service.evaluate('bridge-001', { quote: {}, candles: null });
    assert.equal(live.event, 'LIVE');
    assert.equal(live.pushed, true);
    assert.equal(pushes.length, 2, 'PENDING to LIVE attempts exactly one Telegram push');

    await service.evaluate('bridge-001', { quote: {}, candles: null });
    assert.equal(pushes.length, 2, 'unchanged state does not duplicate Telegram push');

    clock = new Date('2026-07-27T02:02:00.000Z');
    snapshotTime = clock.toISOString();
    snapshotPrice = 236;
    const expired = await service.evaluate('bridge-001', { quote: {}, candles: null });
    assert.equal(expired.event, 'EXPIRED');
    assert.equal(pushes.length, 3, 'LIVE to EXPIRED attempts exactly one Telegram push');

    clock = new Date('2026-07-27T02:03:00.000Z');
    snapshotTime = clock.toISOString();
    snapshotPrice = 235.5;
    service.putMonitor({
        ...bridge(),
        bridgeId: 'bridge-outside-zone',
        activeZone: { low: 236, high: 237 }
    });
    const initialExpired = await service.evaluate('bridge-outside-zone', { quote: {}, candles: null });
    assert.equal(initialExpired.bridge.notificationState.continuousValidity.status, 'EXPIRED');
    assert.equal(initialExpired.event, 'STARTED');
    assert.equal(initialExpired.pushed, true, 'an initially expired monitor reports its startup status');
    assert.match(pushes.at(-1), /TAR-OBI MONITOR STARTED/);
    assert.match(pushes.at(-1), /Live Confirmation: EXPIRED — price outside bridged Zone/);
    assert.match(pushes.at(-1), /Bridged Active Zone: 236–237/);
    await service.evaluate('bridge-outside-zone', { quote: {}, candles: null });
    assert.equal(pushes.length, 4, 'repeated EXPIRED polling does not duplicate the startup message');

    const incompleteService = createMonitorService(serviceOptions({
        stateFile: path.join(temporaryDirectory, 'incomplete-state.json'),
        buildSnapshotImpl: record => ({ complete: false, ticker: record.bridge.ticker })
    }));
    incompleteService.putMonitor({ ...bridge(), bridgeId: 'bridge-incomplete' });
    const incomplete = await incompleteService.evaluate('bridge-incomplete', { quote: {}, candles: null });
    assert.equal(incomplete.capture.written, false);
    assert.equal(incomplete.event, null, 'an incomplete first assessment does not send a startup alert');
    assert.equal(incompleteService.state.monitors['bridge-incomplete'].bridge.monitorResult ?? null, null);
    incompleteService.config.buildSnapshotImpl = snapshot;
    const completed = await incompleteService.evaluate('bridge-incomplete', { quote: {}, candles: null });
    assert.equal(completed.event, 'STARTED', 'the first complete assessment sends the deferred startup alert');

    let deliveryAttempts = 0;
    const retryService = createMonitorService(serviceOptions({
        stateFile: path.join(temporaryDirectory, 'retry-state.json'),
        sendTelegramImpl: async () => {
            deliveryAttempts += 1;
            if (deliveryAttempts === 1) throw new Error('Telegram unavailable');
            return { ok: true };
        }
    }));
    retryService.putMonitor({ ...bridge(), bridgeId: 'bridge-retry' });
    await assert.rejects(
        retryService.evaluate('bridge-retry', { quote: {}, candles: null }),
        /Telegram unavailable/
    );
    assert.equal(retryService.state.monitors['bridge-retry'].bridge.monitorResult ?? null, null);
    const retried = await retryService.evaluate('bridge-retry', { quote: {}, candles: null });
    assert.equal(retried.event, 'STARTED', 'a failed startup alert remains eligible for retry');
    assert.equal(retried.pushed, true);
    assert.equal(deliveryAttempts, 2);

    const preEvaluatedService = createMonitorService(serviceOptions({ stateFile: path.join(temporaryDirectory, 'pre-evaluated-state.json') }));
    preEvaluatedService.putMonitor({
        ...bridge(),
        bridgeId: 'bridge-pre-evaluated',
        monitorResult: { evaluatedAt: '2026-07-27T01:59:00.000Z' }
    });
    const preEvaluated = await preEvaluatedService.evaluate('bridge-pre-evaluated', { quote: {}, candles: null });
    assert.equal(preEvaluated.event, 'STARTED', 'a newly submitted bridge sends startup status even if ETF_DCA supplied an earlier monitorResult');

    const legacyStateFile = path.join(temporaryDirectory, 'legacy-state.json');
    fs.writeFileSync(legacyStateFile, JSON.stringify({ monitors: {
        'bridge-legacy': {
            bridge: { ...bridge(), bridgeId: 'bridge-legacy', monitorResult: { evaluatedAt: '2026-07-27T01:59:00.000Z' } },
            settings: {},
            pushedEvents: []
        }
    } }));
    const legacyService = createMonitorService(serviceOptions({ stateFile: legacyStateFile }));
    const legacy = await legacyService.evaluate('bridge-legacy', { quote: {}, candles: null });
    assert.equal(legacy.event, null, 'loading an older already-evaluated monitor does not fabricate a new startup alert');

    service.lifecycle('bridge-001', 'pause');
    const restarted = createMonitorService(serviceOptions());
    assert.equal(restarted.state.monitors['bridge-001'].bridge.lifecycle.status, 'PAUSED', 'restart recovers the persisted monitor');
    restarted.lifecycle('bridge-001', 'resume');
    assert.equal(restarted.state.monitors['bridge-001'].bridge.lifecycle.status, 'ACTIVE');
    restarted.lifecycle('bridge-001', 'end');
    assert.equal(restarted.state.monitors['bridge-001'].bridge.lifecycle.status, 'COMPLETED', 'End completes the monitor');

    const smokeState = path.join(temporaryDirectory, 'smoke-state.json');
    pushes.length = 0;
    snapshotPrice = 235.5;
    clock = new Date('2026-07-27T02:00:00.000Z');
    snapshotTime = clock.toISOString();
    const smoke = createMonitorService(serviceOptions({ stateFile: smokeState }));
    const server = createHttpServer(smoke);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const preflight = await request(port, 'OPTIONS', '/api/monitors/bridge-001', undefined, {
        Origin: 'https://dksbluesky.github.io',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization,content-type'
    });
    assert.equal(preflight.status, 204, 'GitHub Pages API preflight is accepted');
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://dksbluesky.github.io');
    assert.match(preflight.headers['access-control-allow-methods'], /PUT/);
    assert.match(preflight.headers['access-control-allow-headers'], /Authorization/);
    const blockedPreflight = await request(port, 'OPTIONS', '/api/monitors/bridge-001', undefined, {
        Origin: 'https://untrusted.example',
        'Access-Control-Request-Method': 'PUT'
    });
    assert.equal(blockedPreflight.status, 403, 'unlisted web origins are rejected');
    const started = await request(port, 'PUT', '/api/monitors/bridge-001', { ...bridge(), settings: { interval: 10 } });
    assert.equal(started.status, 200, 'HTTP Start accepts the existing bridge');
    const crossOriginStatus = await request(port, 'GET', '/api/monitors/bridge-001', undefined, {
        Origin: 'https://dksbluesky.github.io'
    });
    assert.equal(crossOriginStatus.status, 200);
    assert.equal(crossOriginStatus.headers['access-control-allow-origin'], 'https://dksbluesky.github.io');
    await smoke.evaluate('bridge-001', { quote: {}, candles: null });
    clock = new Date('2026-07-27T02:01:31.000Z');
    snapshotTime = clock.toISOString();
    await smoke.evaluate('bridge-001', { quote: {}, candles: null });
    assert.equal(pushes.length, 2, 'end-to-end HTTP start sends the startup status and later LIVE transition');
    const tarPage = await request(port, 'GET', '/TAR-OBI/entry-assessment.html');
    const etfPage = await request(port, 'GET', '/ETF_DCA-plan/');
    assert.equal(tarPage.status, 200, 'service hosts TAR-OBI for the Android browser');
    assert.equal(etfPage.status, 200, 'service hosts ETF_DCA on the same origin');
    await new Promise(resolve => server.close(resolve));

    console.log('monitor service lifecycle test passed');
    console.log('monitor service restart/recovery test passed');
    console.log('Telegram transition deduplication test passed');
    console.log('browser-independent end-to-end smoke test passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
