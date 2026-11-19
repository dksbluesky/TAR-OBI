(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TarObiRepoZone = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const STORAGE_KEY = 'tarObi.repoActiveZoneLink.v1';
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
        root.localStorage?.setItem(STORAGE_KEY, JSON.stringify(link));
        if (!load(ticker)) throw new Error('此瀏覽器無法儲存 ETF_DCA 區間連結。');
        return link;
    }

    return Object.freeze({ STORAGE_KEY, PORTFOLIO_URL, appliedManualZone, isLink: validLink, load, clear, sync });
});
