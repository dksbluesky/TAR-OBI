'use strict';

const assert = require('node:assert/strict');
const repoZone = require('../repo-zone-link.js');

const values = new Map();
global.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
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
    assert.equal(repoZone.load('2330'), null, 'a saved zone cannot be used for another ticker');

    global.fetch = async () => response(portfolio({ low: 205, high: 211 }));
    assert.deepEqual((await repoZone.sync('006208')).activeZone, { low: 205, high: 211 },
        'a second click reads the current saved zone');

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
    global.fetch = async () => { throw new Error('network unavailable'); };
    await assert.rejects(repoZone.sync('006208'), /network unavailable/);
    assert.deepEqual(repoZone.load('006208').activeZone, { low: 203, high: 209 },
        'a network failure does not erase the last known snapshot');
    repoZone.clear();
    assert.equal(repoZone.load('006208'), null);
    console.log('repo Active Zone link tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
