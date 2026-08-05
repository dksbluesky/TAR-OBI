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
    /const completedSnapshot = render\(\);\s*if \(completedRefresh\) \{\s*const linked = window\.TarObiBridge\?\.getLinkedBridge\?\.\(\);\s*window\.TarObiAssessmentJournal\?\.recordCompletedAssessment\(completedSnapshot, linked\);\s*window\.TarObiBridgeMonitor\?\.captureCompletedAssessment\(completedSnapshot\);\s*\}/,
    'a completed fetch renders first, journals the raw linked snapshot, and then writes it through the bridge monitor'
);

console.log('entry refresh tests passed');
