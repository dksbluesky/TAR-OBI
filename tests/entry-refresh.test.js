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
    /getMarketSession\(quoteData,\s*settings\.interval\s*\*\s*1000\)\s*===\s*'closed'/,
    'refresh timer stops only after market-session classification reports closed'
);
assert.match(
    html,
    /const completedSnapshot = render\(\);\s*if \(completedRefresh\) window\.TarObiBridgeMonitor\?\.captureCompletedAssessment\(completedSnapshot\)/,
    'a completed fetch renders first and then writes the completed assessment through the bridge monitor'
);

console.log('entry refresh tests passed');
