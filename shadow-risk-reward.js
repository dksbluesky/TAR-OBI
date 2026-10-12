(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TarObiShadowRr = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const number = value => value === null || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
    const taipeiDate = ms => {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
        const part = name => parts.find(item => item.type === name)?.value;
        return `${part('year')}-${part('month')}-${part('day')}`;
    };
    const median = values => {
        const sorted = values.filter(value => value > 0).sort((a, b) => a - b);
        return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    };

    function collectCompletedFiveMinuteBars(historical, intraday, asOf) {
        const cutoff = Date.parse(asOf || '');
        if (!Number.isFinite(cutoff)) return { bars: [], duplicateTimestamps: [], missingCandles: [] };
        const today = taipeiDate(cutoff);
        const bars = new Map();
        const duplicateTimestamps = [];
        for (const [source, data] of [['historical', historical], ['intraday', intraday]]) {
            for (const bar of Array.isArray(data?.data) ? data.data : []) {
                const start = Date.parse(bar.date || '');
                const high = number(bar.high), low = number(bar.low), close = number(bar.close);
                if (!Number.isFinite(start) || high === null || low === null || close === null || low > high) continue;
                const barDay = taipeiDate(start);
                if (source === 'historical' && barDay >= today) continue;
                if (source === 'intraday' && barDay !== today) continue;
                // Fugle timestamps minute bars at their start. The current bar is provisional.
                if (start + 5 * 60000 > cutoff) continue;
                if (bars.has(start)) duplicateTimestamps.push(bar.date);
                bars.set(start, { date: bar.date, start, high, low, close });
            }
        }
        const completed = [...bars.values()].sort((a, b) => a.start - b.start);
        const byDay = new Map();
        for (const bar of completed) {
            const day = taipeiDate(bar.start);
            if (!byDay.has(day)) byDay.set(day, []);
            byDay.get(day).push(bar);
        }
        const missingCandles = [];
        for (const [day, dayBars] of byDay) {
            const open = Date.parse(`${day}T09:00:00+08:00`);
            const close = Date.parse(`${day}T13:30:00+08:00`);
            const sessionComplete = day < today || cutoff >= close + 5 * 60000;
            const lastRegular = Math.min(Date.parse(`${day}T13:20:00+08:00`),
                sessionComplete ? close : dayBars.at(-1).start);
            // Fugle supplies 13:30 as the closing bar; 13:25 is not an expected slot.
            for (let expected = open; expected <= lastRegular; expected += 5 * 60000) {
                if (!bars.has(expected)) missingCandles.push(new Date(expected).toISOString());
            }
            if (sessionComplete && !bars.has(close)) missingCandles.push(new Date(close).toISOString());
        }
        return { bars: completed, duplicateTimestamps, missingCandles };
    }

    function completedFiveMinuteBars(historical, intraday, asOf) {
        return collectCompletedFiveMinuteBars(historical, intraday, asOf).bars;
    }

    function pivots(bars, field, span = 2) {
        const found = [];
        for (let i = span; i < bars.length - span; i++) {
            const price = bars[i][field];
            const left = bars.slice(i - span, i), right = bars.slice(i + 1, i + span + 1);
            const isPivot = field === 'high'
                ? left.every(bar => price > bar.high) && right.every(bar => price >= bar.high)
                : left.every(bar => price < bar.low) && right.every(bar => price <= bar.low);
            if (isPivot) found.push({ price, index: i, date: bars[i].date });
        }
        return found;
    }

    function assess(input = {}) {
        const asOf = input.asOf, entry = number(input.proposedEntry), tick = number(input.tick);
        const broadInvalidation = number(input.etfBroadInvalidation);
        const manualOrTrailingInvalidation = number(input.manualOrTrailingInvalidation);
        const result = {
            algorithmVersion: 1,
            asOf: asOf || null, proposedEntry: entry, target1: null, target2: null,
            entryStructuralStop: null, etfBroadInvalidation: broadInvalidation,
            manualOrTrailingInvalidation, availableUpsidePct: null, grossRr: null,
            netRr: null, resistanceConfidence: 'UNAVAILABLE', rrAssessment: 'R&R UNAVAILABLE',
            earlyEntryCandidate: null, earlyEntryReason: 'No independently confirmed early-entry structure',
            completedFiveMinuteBars: 0, coveredSessions: 0, firstCompletedCandle: null,
            lastCompletedCandle: null, dailyStructureAsOf: input.dailyResistance?.asOf || null,
            candleQuality: { status: 'UNAVAILABLE', duplicateTimestamps: [], missingCandles: [] },
            stopReason: 'No setup-linked intraday invalidation in the existing context',
            evidence: []
        };
        const collection = collectCompletedFiveMinuteBars(input.historicalCandles, input.intradayCandles, asOf);
        const bars = collection.bars;
        result.completedFiveMinuteBars = bars.length;
        result.coveredSessions = new Set(bars.map(bar => taipeiDate(bar.start))).size;
        result.firstCompletedCandle = bars[0]?.date || null;
        result.lastCompletedCandle = bars.at(-1)?.date || null;
        result.candleQuality = {
            status: collection.duplicateTimestamps.length || collection.missingCandles.length ? 'GAP_OR_DUPLICATE' : 'OK',
            duplicateTimestamps: collection.duplicateTimestamps,
            missingCandles: collection.missingCandles
        };
        if (result.candleQuality.status !== 'OK') {
            result.rrAssessment = 'R&R UNAVAILABLE — candle coverage issue';
            return result;
        }
        if (!(entry > 0) || !(tick > 0)) return result;
        if (bars.length < 7) { result.evidence.push('Insufficient completed 5-minute candles'); return result; }

        const cutoff = Date.parse(asOf);
        const recentDays = [...new Set(bars.map(bar => taipeiDate(bar.start)))].slice(-10);
        const recent = bars.filter(bar => recentDays.includes(taipeiDate(bar.start)));
        const range = median(recent.map(bar => bar.high - bar.low)) || tick;
        const tolerance = Math.max(2 * tick, range * 0.5);
        const rejectionMove = Math.max(2 * tick, range);
        const highs = pivots(bars, 'high').filter(point => recentDays.includes(taipeiDate(Date.parse(point.date))));
        const daily = Array.isArray(input.dailyResistance?.levels) ? input.dailyResistance.levels : [];
        const dailyHighs = daily.filter(point => {
            const date = String(point.date || '').slice(0, 10);
            return number(point.price) !== null && Date.parse(`${date}T13:30:00+08:00`) <= cutoff;
        }).map(point => ({ price: Number(point.price), date: point.date, source: 'DAILY_PIVOT',
            repeatedPivotCount: Number(point.repeatedPivotCount) || 0 }));
        const candidates = [...highs.map(point => ({ ...point, source: 'INTRADAY_PIVOT' })), ...dailyHighs]
            .sort((a, b) => a.price - b.price);
        const groups = [];
        for (const candidate of candidates) {
            const group = groups.find(item => Math.abs(item.price - candidate.price) <= tolerance);
            if (group) group.members.push(candidate);
            else groups.push({ price: candidate.price, members: [candidate] });
        }
        const levels = groups.map(group => {
            const touches = highs.filter(point => Math.abs(point.price - group.price) <= tolerance);
            const rejections = touches.map(point => {
                const following = bars.slice(point.index + 1, point.index + 5);
                const reaction = following.find(bar => group.price - bar.low >= rejectionMove);
                return reaction ? { pivotPrice: point.price, pivotAt: point.date,
                    reactionLow: reaction.low, reactionAt: reaction.date } : null;
            }).filter(Boolean);
            const dailyRepeated = group.members.some(point => point.source === 'DAILY_PIVOT' && point.repeatedPivotCount >= 2);
            const lastTwo = bars.slice(-2);
            const broken = lastTwo.length === 2 && entry > group.price + tolerance
                && lastTwo.every(bar => bar.close > group.price + tolerance);
            return {
                price: group.price, kind: broken ? 'BROKEN_RESISTANCE'
                    : rejections.length >= 2 || dailyRepeated ? 'CREDIBLE_RESISTANCE' : 'PROVISIONAL_RESISTANCE',
                rejectionCount: rejections.length, rejections, repeatedDailyPivots: dailyRepeated,
                sources: [...new Set(group.members.map(point => point.source))],
                observedAt: group.members.map(point => point.date)
            };
        });
        const credible = levels.filter(level => level.kind === 'CREDIBLE_RESISTANCE' && level.price > entry);
        result.target1 = credible[0] || null;
        result.target2 = credible[1] || null;
        result.resistanceConfidence = result.target1 ? 'CREDIBLE_RESISTANCE'
            : levels.some(level => level.kind === 'PROVISIONAL_RESISTANCE' && level.price > entry) ? 'PROVISIONAL_RESISTANCE'
                : levels.some(level => level.kind === 'BROKEN_RESISTANCE') ? 'BROKEN_RESISTANCE' : 'UNAVAILABLE';
        const selected = [result.target1, result.target2].filter(Boolean);
        result.evidence = [...selected, ...levels.filter(level =>
            !selected.includes(level) && (level.kind === 'BROKEN_RESISTANCE'
                || level.price >= entry - range * 2))].slice(0, 8);
        if (!result.target1) {
            result.rrAssessment = result.resistanceConfidence === 'PROVISIONAL_RESISTANCE'
                ? 'TARGET UNCERTAIN — execution result unchanged' : 'R&R UNAVAILABLE';
            return result;
        }
        result.availableUpsidePct = (result.target1.price - entry) / entry * 100;
        // Option A is a shadow estimate using the ETF's broader invalidation,
        // not an entry-specific structural stop or the manual/trailing level.
        if (!(broadInvalidation > 0) || !(broadInvalidation < entry)) {
            result.rrAssessment = 'R&R UNAVAILABLE — valid ETF broad invalidation required';
            return result;
        }
        const risk = entry - broadInvalidation;
        const reward = result.target1.price - entry;
        if (!(risk > 0) || !(reward > 0)) return result;
        result.grossRr = reward / risk;
        result.rrAssessment = 'CALCULABLE — ETF broad-risk estimate; no R&R gate';
        return result;
    }

    return Object.freeze({ assess, completedFiveMinuteBars });
});
