'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'entry-assessment.html'), 'utf8');

assert.match(
    html,
    /intraday\/quote\/\$\{settings\.symbol\}`,\s*\{\s*headers,\s*cache:\s*'no-store'\s*\}/,
    'initial and recurring Fugle quote requests bypass browser cache'
);
assert.match(
    html,
    /intraday\/candles\/\$\{settings\.symbol\}\?timeframe=5`,\s*\{\s*headers,\s*cache:\s*'no-store'\s*\}/,
    'Fugle candle requests bypass browser cache'
);
assert.match(
    html,
    /ensureRefreshTimer\(MarketData\.getMarketSession\(quoteData,\s*settings\.interval\s*\*\s*1000\)\)/,
    'each completed request adjusts the refresh timer for the current market session'
);
assert.match(
    html,
    /const delay = session === 'closed' \? 60000 : querySettings\(\)\.interval \* 1000/,
    'closed sessions continue polling once per minute while live sessions use the configured interval'
);
assert.match(
    html,
    /ensureRefreshTimer\('unavailable'\)/,
    'page setup always starts a refresh timer that can detect the next market open'
);
assert.match(
    html,
    /const completedSnapshot = render\(\);\s*if \(completedRefresh\) \{\s*const linked = window\.TarObiBridge\?\.getLinkedBridge\?\.\(\);\s*const monitorState = window\.TarObiBridgeMonitor\?\.captureCompletedAssessment\(completedSnapshot\);\s*window\.TarObiAssessmentJournal\?\.recordCompletedAssessment\(completedSnapshot, linked, monitorState\);\s*\}/,
    'a completed fetch renders first, journals the raw linked snapshot, and then writes it through the bridge monitor'
);

console.log('entry refresh tests passed');
