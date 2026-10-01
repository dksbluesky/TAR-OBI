'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = __dirname;
const ETF_ROOT = path.resolve(ROOT, '..', 'ETF_DCA-plan');
const STORAGE_KEY = 'etfDca.executionBridge.v1';
const STARTED_PENDING_EVENT = 'STARTED_PENDING';
const DEFAULT_STATE_FILE = path.join(ROOT, '.tar-obi-monitor-state.json');
const ALLOWED_ORIGINS = new Set(['https://dksbluesky.github.io']);

function loadDotEnv(file = path.join(ROOT, '.env')) {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match || process.env[match[1]] !== undefined) continue;
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        process.env[match[1]] = value;
    }
}

function jsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createMemoryStorage() {
    let values = new Map();
    return {
        useBridge(bridge) {
            values = new Map([[STORAGE_KEY, JSON.stringify(bridge)]]);
        },
        getBridge() {
            const raw = values.get(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        },
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); }
    };
}

const serviceStorage = createMemoryStorage();
globalThis.localStorage = serviceStorage;
globalThis.window = globalThis;
require('./shared-market.js');
const bridgeLoader = require('./bridge-loader.js');
const bridgeMonitor = require('./bridge-monitor.js');
delete globalThis.window;

let activeRecord = null;
const bridgeApi = {
    validateBridge: bridgeLoader.validateBridge,
    getLinkedBridge: () => serviceStorage.getBridge(),
    refreshLinkedBridge: () => serviceStorage.getBridge()
};
bridgeMonitor.mount({ bridgeApi });

function firstPrice(quote, side) {
    const value = Number(quote?.[side]?.[0]?.price);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function buildSnapshot(record, quote, candles) {
    const MarketData = globalThis.MarketData;
    const interval = [10, 30, 60].includes(Number(record.settings?.interval)) ? Number(record.settings.interval) : 30;
    const timestamp = MarketData.timestampToMs(quote?.lastUpdated || quote?.lastTrade?.time || quote?.closeTime);
    const session = MarketData.getMarketSession(quote, interval * 1000);
    const current = Number(quote?.lastPrice ?? quote?.closePrice);
    const price = Number.isFinite(current) && current > 0 ? current : null;
    const bid = firstPrice(quote, 'bids');
    const ask = firstPrice(quote, 'asks');
    const vwap = MarketData.getVwap(quote);
    const askPrints = Number(quote?.total?.tradeVolumeAtAsk) || 0;
    const bidPrints = Number(quote?.total?.tradeVolumeAtBid) || 0;
    const bidQty = (quote?.bids || []).reduce((sum, level) => sum + (Number(level.size) || 0), 0);
    const askQty = (quote?.asks || []).reduce((sum, level) => sum + (Number(level.size) || 0), 0);
    const metrics = MarketData.calculateTarObi(askPrints, bidPrints, bidQty, askQty);
    const tar = MarketData.getTarContext(metrics?.detTarKey);
    const obi = MarketData.getObiContext(metrics?.obiKey);
    const volumeQuality = MarketData.calculateVolumeQuality(candles, timestamp, session);
    const tick = MarketData.inferTickSize(quote);
    const bridge = record.bridge;
    const assessment = MarketData.calculateEntryAssessment({
        current: price,
        bid,
        ask,
        vwap,
        tick,
        timestamp,
        session,
        tar,
        obi,
        entryBasis: record.settings?.entryBasis || 'combined',
        invalidationBasis: record.settings?.invalidationBasis || 'match',
        volumeQuality: volumeQuality.quality,
        executionContext: {
            entryMode: bridge.entryMode || 'pending',
            starterEligible: bridge.starterEligible === true,
            starterExecuted: bridge.starterExecuted === true,
            starterRisk: bridge.starterRisk || null,
            activeZone: bridge.activeZone || null,
            invalidationLevel: bridge.invalidationLevel ?? null
        }
    });
    return {
        complete: Boolean(quote && metrics && timestamp),
        ticker: bridge.ticker,
        evaluatedAt: timestamp ? new Date(timestamp).toISOString() : null,
        currentPrice: price,
        preferredEntry: { low: assessment.lower, high: assessment.upper },
        maximumEntryPrice: assessment.maximum,
        invalidationLevel: assessment.invalidation,
        marketSession: session,
        assessment,
        entryMode: bridge.entryMode || 'pending',
        starterEligible: bridge.starterEligible === true,
        starterExecuted: bridge.starterExecuted === true,
        starterRisk: bridge.starterRisk || null,
        tarState: tar,
        obiState: obi,
        vwapState: MarketData.getVwapPosition(price, vwap),
        spreadState: Number.isFinite(bid) && Number.isFinite(ask) ? (assessment.wideSpread ? 'WIDE' : 'ACCEPTABLE') : null,
        volumeQuality: volumeQuality.quality
    };
}

function readState(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed.monitors === 'object' ? parsed : { monitors: {} };
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return { monitors: {} };
    }
}

function writeState(file, state) {
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

function transitionEvent(previous, next, initialEvaluation = false) {
    const before = previous?.notificationState?.continuousValidity?.status || 'NONE';
    const after = next?.notificationState?.continuousValidity?.status || 'NONE';
    if (initialEvaluation) return 'STARTED';
    if (after === 'LIVE' && before !== 'LIVE') return 'LIVE';
    if (before === 'LIVE' && after === 'EXPIRED') return 'EXPIRED';
    return null;
}

function telegramText(event, bridge) {
    const result = bridge.monitorResult || {};
    const validity = bridge.notificationState?.continuousValidity || {};
    const range = result.preferredEntry;
    const rangeText = Number.isFinite(Number(range?.low)) && Number.isFinite(Number(range?.high))
        ? `${range.low}–${range.high}`
        : 'Unavailable';
    const zone = bridge.activeZone;
    const zoneText = Number.isFinite(Number(zone?.low)) && Number.isFinite(Number(zone?.high))
        ? `${zone.low}–${zone.high}`
        : 'Unavailable';
    const liveStatus = validity.reason
        ? `${validity.status || 'NONE'} — ${validity.reason}`
        : validity.status || 'NONE';
    return [
        event === 'STARTED' ? 'TAR-OBI MONITOR STARTED' : `TAR-OBI ${event}`,
        `Ticker: ${bridge.ticker}`,
        `Live Confirmation: ${liveStatus}`,
        `Price: ${result.currentPrice ?? 'Unavailable'}`,
        `Bridged Active Zone: ${zoneText}`,
        `Preferred Entry: ${rangeText}`,
        `Assessment: ${result.assessmentState || 'Unavailable'}`,
        `TAR: ${result.tarState || 'Unavailable'}`,
        `OBI: ${result.obiState || 'Unavailable'}`,
        `VWAP: ${result.vwapState || 'Unavailable'}`,
        `Time: ${result.evaluatedAt || new Date().toISOString()}`
    ].join('\n');
}

async function sendTelegram(fetchImpl, config, text) {
    if (!config.telegramToken || !config.telegramChatId) throw new Error('Telegram environment variables are not configured.');
    const response = await fetchImpl(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: config.telegramChatId, text })
    });
    if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
    return response.json();
}

function createMonitorService(options = {}) {
    const config = {
        controlToken: options.controlToken ?? process.env.TAR_OBI_CONTROL_TOKEN ?? '',
        fugleApiKey: options.fugleApiKey ?? process.env.FUGLE_API_KEY ?? '',
        telegramToken: options.telegramToken ?? process.env.TELEGRAM_TOKEN ?? '',
        telegramChatId: options.telegramChatId ?? process.env.CHAT_ID ?? '',
        stateFile: options.stateFile || process.env.TAR_OBI_STATE_FILE || DEFAULT_STATE_FILE,
        intervalMs: Number(options.intervalMs || process.env.TAR_OBI_INTERVAL_MS || 10000),
        fetchImpl: options.fetchImpl || globalThis.fetch,
        setIntervalImpl: options.setIntervalImpl || setInterval,
        clearIntervalImpl: options.clearIntervalImpl || clearInterval,
        now: options.now || (() => new Date()),
        buildSnapshotImpl: options.buildSnapshotImpl || buildSnapshot,
        sendTelegramImpl: options.sendTelegramImpl || sendTelegram
    };
    const state = readState(config.stateFile);
    let timer = null;

    function save() { writeState(config.stateFile, state); }

    function putMonitor(bridge, settings = {}) {
        if (!bridge?.bridgeId || !bridge?.ticker) throw new Error('A valid linked bridge is required.');
        const existing = state.monitors[bridge.bridgeId] || {};
        const pushedEvents = existing.pushedEvents || [];
        if (!state.monitors[bridge.bridgeId] && !pushedEvents.includes(STARTED_PENDING_EVENT)) {
            pushedEvents.push(STARTED_PENDING_EVENT);
        }
        state.monitors[bridge.bridgeId] = {
            ...existing,
            bridge: jsonClone(bridge),
            settings: { ...(existing.settings || {}), ...settings },
            pushedEvents,
            updatedAt: config.now().toISOString()
        };
        save();
        return state.monitors[bridge.bridgeId];
    }

    function lifecycle(id, action) {
        const record = state.monitors[id];
        if (!record) return null;
        const map = { start: 'ACTIVE', active: 'ACTIVE', resume: 'ACTIVE', pause: 'PAUSED', end: 'COMPLETED' };
        const status = map[action];
        if (!status) throw new Error('Invalid lifecycle action.');
        record.bridge.lifecycle = {
            ...(record.bridge.lifecycle || {}),
            status,
            updatedAt: config.now().toISOString(),
            completedAt: status === 'COMPLETED' ? config.now().toISOString() : record.bridge.lifecycle?.completedAt || null
        };
        record.updatedAt = config.now().toISOString();
        save();
        return record;
    }

    async function fetchMarket(record) {
        const symbol = encodeURIComponent(record.bridge.ticker);
        const headers = { 'X-API-KEY': config.fugleApiKey };
        const base = 'https://api.fugle.tw/marketdata/v1.0';
        const [quoteResponse, candleResponse] = await Promise.all([
            config.fetchImpl(`${base}/stock/intraday/quote/${symbol}`, { headers, cache: 'no-store' }),
            config.fetchImpl(`${base}/stock/intraday/candles/${symbol}?timeframe=5`, { headers, cache: 'no-store' }).catch(() => null)
        ]);
        if (!quoteResponse.ok) throw new Error(`Fugle quote HTTP ${quoteResponse.status}`);
        return {
            quote: await quoteResponse.json(),
            candles: candleResponse?.ok ? await candleResponse.json() : null
        };
    }

    async function evaluate(id, market = null) {
        const record = state.monitors[id];
        if (!record || record.bridge.lifecycle?.status !== 'ACTIVE') return { skipped: true };
        const previous = jsonClone(record.bridge);
        const initialEvaluation = !previous.monitorResult?.evaluatedAt;
        const data = market || await fetchMarket(record);
        const snapshot = config.buildSnapshotImpl(record, data.quote, data.candles);
        serviceStorage.useBridge(record.bridge);
        activeRecord = record;
        bridgeMonitor.reconcileLinkedLifecycle(config.now());
        const capture = bridgeMonitor.captureCompletedAssessment(snapshot, config.now());
        record.bridge = serviceStorage.getBridge();
        record.updatedAt = config.now().toISOString();
        const startupPending = record.pushedEvents.includes(STARTED_PENDING_EVENT);
        const event = transitionEvent(
            previous,
            record.bridge,
            (initialEvaluation || startupPending)
                && capture.written
                && Boolean(record.bridge.monitorResult?.evaluatedAt)
        );
        let pushed = false;
        if (event) {
            const eventId = `${event}:${record.bridge.monitorResult?.evaluatedAt || record.updatedAt}`;
            if (!record.pushedEvents.includes(eventId)) {
                try {
                    await config.sendTelegramImpl(config.fetchImpl, config, telegramText(event, record.bridge));
                } catch (error) {
                    if (event === 'STARTED') {
                        record.bridge = previous;
                        activeRecord = null;
                    }
                    throw error;
                }
                if (event === 'STARTED') {
                    record.pushedEvents = record.pushedEvents.filter(item => item !== STARTED_PENDING_EVENT);
                }
                record.pushedEvents.push(eventId);
                pushed = true;
            }
        }
        save();
        activeRecord = null;
        return { capture, event, pushed, bridge: record.bridge };
    }

    async function evaluateAll() {
        for (const id of Object.keys(state.monitors)) {
            try { await evaluate(id); } catch (error) {
                state.monitors[id].lastError = error.message;
                state.monitors[id].updatedAt = config.now().toISOString();
                save();
            }
        }
    }

    function start() {
        if (!config.controlToken || !config.fugleApiKey) throw new Error('TAR_OBI_CONTROL_TOKEN and FUGLE_API_KEY are required.');
        if (!config.telegramToken || !config.telegramChatId) throw new Error('TELEGRAM_TOKEN and CHAT_ID are required.');
        if (!timer) timer = config.setIntervalImpl(() => void evaluateAll(), config.intervalMs);
        return timer;
    }

    function stop() {
        if (timer) config.clearIntervalImpl(timer);
        timer = null;
    }

    return { config, state, putMonitor, lifecycle, evaluate, evaluateAll, start, stop };
}

function contentType(file) {
    return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.css': 'text/css; charset=utf-8' })[path.extname(file)] || 'application/octet-stream';
}

function safeStaticPath(urlPath) {
    const decoded = decodeURIComponent(urlPath.split('?')[0]);
    let base = ROOT;
    let relative = decoded;
    if (decoded === '/') relative = '/TAR-OBI/index.html';
    if (decoded === '/ETF_DCA-plan/') relative = '/ETF_DCA-plan/index.html';
    if (relative.startsWith('/ETF_DCA-plan/')) {
        base = ETF_ROOT;
        relative = relative.slice('/ETF_DCA-plan'.length);
    } else if (relative.startsWith('/TAR-OBI/')) {
        relative = relative.slice('/TAR-OBI'.length);
    }
    const target = path.resolve(base, `.${relative}`);
    return target === base || target.startsWith(`${base}${path.sep}`) ? target : null;
}

function createHttpServer(service) {
    return http.createServer(async (request, response) => {
        try {
            const origin = request.headers.origin;
            if (origin && ALLOWED_ORIGINS.has(origin)) {
                response.setHeader('Access-Control-Allow-Origin', origin);
                response.setHeader('Vary', 'Origin');
            }
            if (request.method === 'OPTIONS') {
                if (!origin || !ALLOWED_ORIGINS.has(origin)) {
                    response.writeHead(403).end();
                    return;
                }
                response.writeHead(204, {
                    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                    'Access-Control-Max-Age': '600'
                }).end();
                return;
            }
            const url = new URL(request.url, 'http://localhost');
            const match = url.pathname.match(/^\/api\/monitors\/([^/]+)(?:\/([^/]+))?$/);
            if (url.pathname === '/api/config' && request.method === 'GET') {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ notification: 'telegram', telegramConfigured: Boolean(service.config.telegramToken && service.config.telegramChatId) }));
                return;
            }
            if (match) {
                if (request.headers.authorization !== `Bearer ${service.config.controlToken}`) {
                    response.writeHead(401).end('Unauthorized');
                    return;
                }
                const id = decodeURIComponent(match[1]);
                if (request.method === 'GET' && !match[2]) {
                    const record = service.state.monitors[id];
                    response.writeHead(record ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(record || { error: 'Not found' }));
                    return;
                }
                if (request.method === 'PUT' && !match[2]) {
                    const chunks = [];
                    for await (const chunk of request) chunks.push(chunk);
                    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    const settings = payload.settings || {};
                    delete payload.settings;
                    const record = service.putMonitor(payload, settings);
                    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(record));
                    return;
                }
                if (request.method === 'POST' && match[2]) {
                    const record = service.lifecycle(id, match[2]);
                    response.writeHead(record ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(record || { error: 'Not found' }));
                    return;
                }
            }
            if (!['GET', 'HEAD'].includes(request.method)) {
                response.writeHead(405).end('Method Not Allowed');
                return;
            }
            const file = safeStaticPath(url.pathname);
            if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                response.writeHead(404).end('Not Found');
                return;
            }
            response.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': 'no-store' });
            if (request.method === 'HEAD') response.end();
            else fs.createReadStream(file).pipe(response);
        } catch (error) {
            response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
        }
    });
}

if (require.main === module) {
    loadDotEnv();
    const service = createMonitorService();
    service.start();
    const port = Number(process.env.PORT || 8080);
    const server = createHttpServer(service);
    server.listen(port, '0.0.0.0', () => {
        console.log(`TAR-OBI Always-On Monitor: http://0.0.0.0:${port}/`);
    });
}

module.exports = { buildSnapshot, createHttpServer, createMonitorService, loadDotEnv, sendTelegram, transitionEvent };
