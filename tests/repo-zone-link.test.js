'use strict';

const assert = require('node:assert/strict');
const repoZone = require('../repo-zone-link.js');

const values = new Map();
const oldCache = JSON.stringify({ dca: [{ ticker: '006208', oldLocalValue: true }], direct: [] });
values.set('p_cache', oldCache);
values.set('p_local_ts', '500');
values.set('p_github_ts', '400');
let rejectCacheWrite = false;
global.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
        if (rejectCacheWrite && key === 'p_cache') throw new Error('storage full');
        values.set(key, String(value));
    },
    removeItem: key => values.delete(key)
};

const portfolio = (zone = { low: 203, high: 209 }) => ({
    dca: [{ ticker: '006208', watchCriteria: {
        zoneMode: 'manual', activeZoneSource: 'manual_reassessment',
        manualReassessment: { manualZoneSource: 'MANUAL', manualAppliedAt: '2026-11-18T08:00:00.000Z',
            activeManualZone: zone, manualDraft: { low: 190, high: 195 } }
    } }], direct: [], lastUpdated: '2026-11-18T08:30:00.000Z'
});
const response = data => ({ ok: true, status: 200, json: async () => ({ encoding: 'base64',
    content: Buffer.from(JSON.stringify(data), 'utf8').toString('base64') }) });

(async () => {
    let calls = 0;
    global.fetch = async (url, options) => {
        calls++;
        assert.equal(url, repoZone.PORTFOLIO_URL);
        assert.equal(options.cache, 'no-store');
        assert.equal(options.headers.Authorization, undefined, 'public sync never sends credentials');
        return response(portfolio());
    };
    const link = await repoZone.sync('006208');
    assert.equal(calls, 1);
    assert.deepEqual(link.activeZone, { low: 203, high: 209 });
    assert.equal(link.zoneMode, 'manual_reassessment');
    assert.equal(repoZone.load('006208').source, 'ETF_DCA-plan GitHub');
    assert.deepEqual(JSON.parse(values.get('p_cache')), portfolio(), 'ETF_DCA cache mirrors the fetched portfolio');
    assert.equal(values.get(repoZone.ETF_CACHE_BACKUP_KEY), oldCache, 'the previous ETF cache remains recoverable');
    assert.ok(Number(values.get('p_github_ts')) >= Number(values.get('p_local_ts')),
        'ETF_DCA will not prefer its previous local cache on next open');
    assert.equal(repoZone.load('2330'), null, 'a saved zone cannot be used for another ticker');

    global.fetch = async () => response(portfolio({ low: 205, high: 211 }));
    assert.deepEqual((await repoZone.sync('006208')).activeZone, { low: 205, high: 211 },
        'a second click reads the current saved zone');
    assert.equal(values.get(repoZone.ETF_CACHE_BACKUP_KEY), oldCache, 'later syncs do not overwrite the original backup');
    const newerUnsavedCache = JSON.stringify({ dca: [{ ticker: '006208', unsavedLater: true }], direct: [] });
    values.set('p_cache', newerUnsavedCache);
    values.set('p_local_ts', String(Number(values.get('p_github_ts')) + 1));
    await repoZone.sync('006208');
    assert.ok([...values.entries()].some(([key, value]) => key.startsWith(repoZone.ETF_CACHE_BACKUP_KEY + '.')
        && value === newerUnsavedCache), 'a later unsaved cache gets its own backup');

    const draftOnly = portfolio();
    draftOnly.dca[0].watchCriteria.manualReassessment.manualZoneSource = null;
    global.fetch = async () => response(draftOnly);
    await assert.rejects(repoZone.sync('006208'), /沒有已套用且有效/);
    assert.equal(repoZone.load('006208'), null, 'a successful repo read removes an obsolete saved link');

    const duplicate = portfolio();
    duplicate.direct.push({ ticker: '006208', watchCriteria: duplicate.dca[0].watchCriteria });
    assert.throws(() => repoZone.appliedManualZone(duplicate, '006208'), /多筆持倉/);
    assert.throws(() => repoZone.appliedManualZone(portfolio({ low: 209, high: 203 }), '006208'), /沒有已套用且有效/);
    assert.throws(() => repoZone.appliedManualZone(portfolio(), '2330'), /找不到/);

    global.fetch = async () => response(portfolio());
    await repoZone.sync('006208');
    const cacheBeforeFailure = values.get('p_cache');
    rejectCacheWrite = true;
    await assert.rejects(repoZone.sync('006208'), /無法儲存 ETF_DCA 同步資料/);
    rejectCacheWrite = false;
    assert.equal(values.get('p_cache'), cacheBeforeFailure, 'a failed cache write leaves ETF data intact');
    values.set('p_repo', 'another/portfolio');
    await assert.rejects(repoZone.sync('006208'), /不同的 GitHub 資料檔/);
    values.delete('p_repo');
    global.fetch = async () => { throw new Error('network unavailable'); };
    await assert.rejects(repoZone.sync('006208'), /network unavailable/);
    assert.deepEqual(repoZone.load('006208').activeZone, { low: 203, high: 209 },
        'a network failure does not erase the last known snapshot');
    repoZone.clear();
    assert.equal(repoZone.load('006208'), null);
    console.log('repo Active Zone link tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
