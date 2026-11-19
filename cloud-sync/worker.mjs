const ALLOWED_ORIGIN = 'https://dksbluesky.github.io';
const MAX_BODY_BYTES = 120_000;

function reply(status, body, origin, extra = {}) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra };
    if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
    }
    return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

function permittedOrigin(request, env) {
    const origin = request.headers.get('Origin');
    return origin === ALLOWED_ORIGIN || (env.DEV_ORIGIN && origin === env.DEV_ORIGIN) ? origin : null;
}

async function accountId(request) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '');
    if (!match) return null;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validBridge(bridge) {
    return bridge?.version === '1.0' && typeof bridge.bridgeId === 'string'
        && bridge.bridgeId.length > 0 && typeof bridge.ticker === 'string'
        && /^[A-Z0-9]+$/.test(bridge.ticker) && Number.isFinite(Date.parse(bridge.createdAt))
        && bridge.sourceApplication === 'ETF_DCA-plan'
        && typeof bridge.marketTimeframe === 'string' && bridge.marketTimeframe.length > 0
        && (bridge.activeZone == null || (Number.isFinite(Number(bridge.activeZone.low))
            && Number.isFinite(Number(bridge.activeZone.high))
            && Number(bridge.activeZone.low) <= Number(bridge.activeZone.high)));
}

function chooseLifecycle(source, result) {
    const a = source?.lifecycle;
    const b = result?.lifecycle;
    if (!b) return a;
    if (!a) return b;
    const terminal = new Set(['COMPLETED', 'EXPIRED', 'INVALIDATED']);
    if (terminal.has(a.status) && !terminal.has(b.status)) return a;
    if (terminal.has(b.status) && !terminal.has(a.status)) return b;
    return Date.parse(b.updatedAt || '') > Date.parse(a.updatedAt || '') ? b : a;
}

function composedBridge(row) {
    const source = JSON.parse(row.source_json);
    const result = row.result_json ? JSON.parse(row.result_json) : null;
    if (result?.monitorResult) source.monitorResult = result.monitorResult;
    const lifecycle = chooseLifecycle(source, result);
    if (lifecycle) source.lifecycle = lifecycle;
    return source;
}

async function readBody(request) {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return null;
    try { return JSON.parse(body); } catch (_error) { return null; }
}

async function currentRow(db, id) {
    return db.prepare('SELECT * FROM bridge_sync WHERE account_id = ?').bind(id).first();
}

async function publishSource(db, id, payload) {
    const bridge = payload?.bridge;
    const sentAt = payload?.sentAt;
    if (!validBridge(bridge) || !Number.isFinite(Date.parse(sentAt))) return { status: 400, body: { error: 'Invalid source Bridge' } };
    const createdAt = new Date(bridge.createdAt).toISOString();
    const writtenAt = new Date(sentAt).toISOString();
    const raw = JSON.stringify(bridge);
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return { status: 413, body: { error: 'Bridge too large' } };
    const existing = await currentRow(db, id);
    if (!existing) {
        const inserted = await db.prepare('INSERT OR IGNORE INTO bridge_sync (account_id, bridge_id, source_json, source_created_at, source_written_at, revision) VALUES (?, ?, ?, ?, ?, 1)')
            .bind(id, bridge.bridgeId, raw, createdAt, writtenAt).run();
        if (inserted.meta?.changes === 1) return { status: 200, body: { bridgeId: bridge.bridgeId, revision: 1 } };
        return { status: 409, body: { error: 'Concurrent source update; fetch current Bridge' } };
    }
    if (bridge.bridgeId !== existing.bridge_id) {
        if (Date.parse(createdAt) <= Date.parse(existing.source_created_at)) {
            return { status: 409, body: { error: 'Older Bridge rejected' } };
        }
        const updated = await db.prepare('UPDATE bridge_sync SET bridge_id = ?, source_json = ?, source_created_at = ?, source_written_at = ?, result_json = NULL, result_written_at = NULL, revision = revision + 1 WHERE account_id = ? AND source_created_at < ?')
            .bind(bridge.bridgeId, raw, createdAt, writtenAt, id, createdAt).run();
        return updated.meta?.changes === 1
            ? { status: 200, body: { bridgeId: bridge.bridgeId, revision: existing.revision + 1 } }
            : { status: 409, body: { error: 'Newer Bridge already exists' } };
    }
    if (Date.parse(writtenAt) <= Date.parse(existing.source_written_at)) {
        return { status: 409, body: { error: 'Older source update rejected' } };
    }
    const updated = await db.prepare('UPDATE bridge_sync SET source_json = ?, source_written_at = ?, revision = revision + 1 WHERE account_id = ? AND bridge_id = ? AND source_written_at < ?')
        .bind(raw, writtenAt, id, bridge.bridgeId, writtenAt).run();
    return updated.meta?.changes === 1
        ? { status: 200, body: { bridgeId: bridge.bridgeId, revision: existing.revision + 1 } }
        : { status: 409, body: { error: 'Newer source update already exists' } };
}

async function publishResult(db, id, payload) {
    const bridge = payload?.bridge;
    const sentAt = payload?.sentAt;
    if (!validBridge(bridge) || !Number.isFinite(Date.parse(sentAt))
        || (bridge.monitorResult && !Number.isFinite(Date.parse(bridge.monitorResult.evaluatedAt)))
        || (!bridge.monitorResult && !bridge.lifecycle)) {
        return { status: 400, body: { error: 'Invalid assessment update' } };
    }
    const writtenAt = new Date(sentAt).toISOString();
    const row = await currentRow(db, id);
    if (!row || row.bridge_id !== bridge.bridgeId) return { status: 409, body: { error: 'Current Bridge differs' } };
    if (bridge.monitorResult && row.result_json) {
        const previous = JSON.parse(row.result_json).monitorResult;
        if (previous && Date.parse(bridge.monitorResult.evaluatedAt) < Date.parse(previous.evaluatedAt)) {
            return { status: 409, body: { error: 'Older assessment rejected' } };
        }
    }
    if (row.result_written_at && Date.parse(writtenAt) <= Date.parse(row.result_written_at)) {
        return { status: 409, body: { error: 'Older assessment rejected' } };
    }
    const raw = JSON.stringify({ monitorResult: bridge.monitorResult, lifecycle: bridge.lifecycle || null });
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return { status: 413, body: { error: 'Assessment too large' } };
    const updated = await db.prepare('UPDATE bridge_sync SET result_json = ?, result_written_at = ?, revision = revision + 1 WHERE account_id = ? AND bridge_id = ? AND (result_written_at IS NULL OR result_written_at < ?)')
        .bind(raw, writtenAt, id, bridge.bridgeId, writtenAt).run();
    return updated.meta?.changes === 1
        ? { status: 200, body: { bridgeId: bridge.bridgeId, revision: row.revision + 1 } }
        : { status: 409, body: { error: 'Newer assessment already exists' } };
}

export async function handleRequest(request, env) {
    const origin = permittedOrigin(request, env);
    if (request.headers.get('Origin') && !origin) return reply(403, { error: 'Origin not allowed' }, null);
    if (request.method === 'OPTIONS') {
        return reply(204, null, origin, {
            'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Max-Age': '600'
        });
    }
    const path = new URL(request.url).pathname;
    if (!['/v1/bridge', '/v1/source', '/v1/result'].includes(path)) return reply(404, { error: 'Not found' }, origin);
    const id = await accountId(request);
    if (!id) return reply(401, { error: 'Pairing key required' }, origin);
    if (!env.DB) return reply(503, { error: 'Database not configured' }, origin);
    try {
        if (path === '/v1/bridge' && request.method === 'GET') {
            const row = await currentRow(env.DB, id);
            return row ? reply(200, { bridge: composedBridge(row), revision: row.revision, syncedAt: row.source_written_at }, origin)
                : reply(404, { error: 'No current Bridge' }, origin);
        }
        if (request.method !== 'PUT' || (path !== '/v1/source' && path !== '/v1/result')) {
            return reply(405, { error: 'Method not allowed' }, origin);
        }
        const body = await readBody(request);
        if (!body) return reply(400, { error: 'Invalid JSON or oversized request' }, origin);
        const outcome = path === '/v1/source'
            ? await publishSource(env.DB, id, body) : await publishResult(env.DB, id, body);
        return reply(outcome.status, outcome.body, origin);
    } catch (_error) {
        return reply(503, { error: 'Cloud sync temporarily unavailable' }, origin);
    }
}

export default { fetch: handleRequest };
