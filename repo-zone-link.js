(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TarObiRepoZone = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const STORAGE_KEY = 'tarObi.repoActiveZoneLink.v1';
    const ETF_CACHE_BACKUP_KEY = 'tarObi.etfDcaCacheBeforeSync.v1';
    const SOURCE = 'ETF_DCA-plan GitHub';
    const PORTFOLIO_URL = 'https://api.github.com/repos/dksbluesky/ETF_DCA-plan/contents/portfolio-data.json?ref=main';
    const validSymbol = value => /^[A-Z0-9]+$/.test(String(value || '').trim().toUpperCase());
    const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
    const validZone = zone => Number.isFinite(Number(zone?.low)) && Number.isFinite(Number(zone?.high))
        && Number(zone.low) > 0 && Number(zone.high) > Number(zone.low);

    function appliedManualZone(portfolio, symbol) {
        const ticker = String(symbol || '').trim().toUpperCase();
        if (!validSymbol(ticker) || !portfolio || !Array.isArray(portfolio.dca)
            || !Array.isArray(portfolio.direct) || !validDate(portfolio.lastUpdated)) {
            throw new Error('ETF_DCA GitHub 資料格式不完整。');
        }
        const matches = [...portfolio.dca, ...portfolio.direct]
            .filter(position => String(position?.ticker || '').trim().toUpperCase() === ticker);
        if (matches.length !== 1) {
            throw new Error(matches.length ? `${ticker} 有多筆持倉，無法確定要同步哪個 Active Zone。`
                : `ETF_DCA GitHub 資料找不到 ${ticker}。`);
        }
        const criteria = matches[0].watchCriteria;
        const manual = criteria?.manualReassessment;
        if (criteria?.activeZoneSource !== 'manual_reassessment' || criteria?.zoneMode !== 'manual'
            || manual?.manualZoneSource !== 'MANUAL' || !validDate(manual?.manualAppliedAt)
            || !validZone(manual?.activeManualZone)) {
            throw new Error(`${ticker} 沒有已套用且有效的手動 Active Zone。`);
        }
        return {
            ticker,
            activeZone: { low: Number(manual.activeManualZone.low), high: Number(manual.activeManualZone.high) },
            zoneMode: 'manual_reassessment',
            appliedAt: manual.manualAppliedAt,
            portfolioUpdatedAt: portfolio.lastUpdated
        };
    }

    function validLink(link) {
        return link?.version === 1 && link.source === SOURCE && validSymbol(link.ticker)
            && validZone(link.activeZone) && link.zoneMode === 'manual_reassessment'
            && validDate(link.appliedAt) && validDate(link.portfolioUpdatedAt) && validDate(link.syncedAt);
    }

    function load(symbol) {
        try {
            const link = JSON.parse(root.localStorage?.getItem(STORAGE_KEY) || 'null');
            return validLink(link) && link.ticker === String(symbol || '').trim().toUpperCase() ? link : null;
        } catch (_error) {
            return null;
        }
    }

    function clear() {
        root.localStorage?.removeItem(STORAGE_KEY);
    }

    async function sync(symbol) {
        const ticker = String(symbol || '').trim().toUpperCase();
        if (!validSymbol(ticker)) throw new Error('請先輸入有效股票代碼。');
        const configuredRepo = root.localStorage?.getItem('p_repo') || 'dksbluesky/ETF_DCA-plan';
        const configuredFile = root.localStorage?.getItem('p_file') || 'portfolio-data.json';
        if (configuredRepo !== 'dksbluesky/ETF_DCA-plan' || configuredFile !== 'portfolio-data.json') {
            throw new Error('ETF_DCA 設定使用不同的 GitHub 資料檔，無法從 TAR-OBI 同步此瀏覽器。');
        }
        const response = await root.fetch(PORTFOLIO_URL, {
            headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store'
        });
        if (!response.ok) throw new Error(`ETF_DCA GitHub 同步失敗（HTTP ${response.status}）。`);
        const file = await response.json();
        if (file?.encoding !== 'base64' || typeof file.content !== 'string') {
            throw new Error('ETF_DCA GitHub 資料無法讀取。');
        }
        const bytes = Uint8Array.from(root.atob(file.content.replace(/\s/g, '')), character => character.charCodeAt(0));
        const portfolio = JSON.parse(new root.TextDecoder().decode(bytes));
        let zone;
        try { zone = appliedManualZone(portfolio, ticker); }
        catch (error) { if (load(ticker)) clear(); throw error; }
        const link = { version: 1, source: SOURCE, ...zone,
            syncedAt: new Date().toISOString() };
        const storage = root.localStorage;
        if (!storage) throw new Error('此瀏覽器無法儲存 ETF_DCA 同步資料。');
        const previous = {
            cache: storage.getItem('p_cache'),
            githubTime: storage.getItem('p_github_ts'),
            link: storage.getItem(STORAGE_KEY)
        };
        const portfolioCache = JSON.stringify(portfolio);
        try {
            if (previous.cache && previous.cache !== portfolioCache
                && (!previous.githubTime || !storage.getItem('p_local_ts')
                    || Number(storage.getItem('p_local_ts')) > Number(previous.githubTime))) {
                let backupKey = ETF_CACHE_BACKUP_KEY;
                if (storage.getItem(backupKey) && storage.getItem(backupKey) !== previous.cache) {
                    let suffix = Date.now();
                    while (storage.getItem(`${backupKey}.${suffix}`)) suffix++;
                    backupKey = `${backupKey}.${suffix}`;
                }
                if (storage.getItem(backupKey) !== previous.cache) {
                    storage.setItem(backupKey, previous.cache);
                }
            }
            storage.setItem('p_cache', portfolioCache);
            storage.setItem('p_github_ts', String(Math.max(Date.now(),
                Number(storage.getItem('p_local_ts')) || 0)));
            storage.setItem(STORAGE_KEY, JSON.stringify(link));
            if (storage.getItem('p_cache') !== portfolioCache || !load(ticker)) {
                throw new Error('同步資料驗證失敗。');
            }
        } catch (_error) {
            for (const [key, value] of [['p_cache', previous.cache],
                ['p_github_ts', previous.githubTime], [STORAGE_KEY, previous.link]]) {
                try { if (value === null) storage.removeItem(key); else storage.setItem(key, value); }
                catch (_restoreError) { /* Keep the original cache backup for recovery. */ }
            }
            throw new Error('此瀏覽器無法儲存 ETF_DCA 同步資料；舊資料仍保留。');
        }
        return link;
    }

    return Object.freeze({ STORAGE_KEY, ETF_CACHE_BACKUP_KEY, PORTFOLIO_URL,
        appliedManualZone, isLink: validLink, load, clear, sync });
});
