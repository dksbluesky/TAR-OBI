'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const monitor = require('../bridge-monitor.js');

function bridge(overrides = {}) {
    return {
        activeZone: { low: 28.8, high: 29.5 },
        invalidationLevel: 28.6,
        zoneMode: 'automatic',
        extensions: { marketContextV1: { context: 'bullish', automaticZoneEligible: true } },
        notificationState: { continuousValidity: { status: 'LIVE' } },
        ...overrides
    };
}

assert.equal(
    monitor.finalActionContext(bridge(), 'ENTRY CONDITIONS MET', 29.1).action,
    'BUY_NOW',
    'a valid AUTO zone with the existing LIVE confirmation presents BUY NOW'
);
assert.equal(
    monitor.finalActionContext(bridge({ zoneMode: 'manual_override', extensions: { marketContextV1: { manualOverride: true } } }), 'ENTRY CONDITIONS MET', 29.1).action,
    'BUY_NOW',
    'a valid MANUAL zone uses the same existing LIVE confirmation result'
);
assert.equal(
    monitor.finalActionContext(bridge({ notificationState: { continuousValidity: { status: 'PENDING' } } }), 'ENTRY CONDITIONS MET', 29.1).action,
    'WAIT',
    'raw ENTRY CONDITIONS MET remains WAIT until the existing linked confirmation is LIVE'
);

assert.equal(
    monitor.finalActionContext(bridge(), 'WAIT FOR PULLBACK', 29.1).action,
    'WAIT',
    'the existing pullback state remains WAIT'
);
assert.equal(
    monitor.finalActionContext(bridge(), 'WAIT FOR CONFIRMATION', 29.1).action,
    'WAIT',
    'the existing confirmation state remains WAIT'
);
assert.equal(
    monitor.finalActionContext(bridge(), 'DO NOT ENTER', 29.1).action,
    'DO_NOT_ENTER',
    'the existing blocking state remains DO NOT ENTER'
);
assert.equal(monitor.signalModeLabel('ENTRY CONDITIONS MET'), 'RIGHT — CONFIRMED');
assert.equal(monitor.signalModeLabel('LEFT-SIDE STARTER ELIGIBLE'), 'LEFT — STARTER');
assert.equal(monitor.signalModeLabel('LEFT-SIDE EXECUTION ACCEPTABLE'), 'LEFT — STARTER');
assert.equal(monitor.signalModeLabel('HIGH-RISK LEFT-SIDE ENTRY'), 'LEFT — STARTER');
assert.equal(monitor.signalModeLabel('WAIT FOR CONFIRMATION'), 'NO ENTRY MODE');
assert.equal(monitor.signalModeLabel('DO NOT ENTER'), 'NO ENTRY MODE');
const noLinkedZone = monitor.finalActionContext(null, 'ENTRY CONDITIONS MET', 29.1, 'closed');
assert.equal(noLinkedZone.action, 'DO_NOT_ENTER');
assert.equal(noLinkedZone.reason, 'No valid Active Zone');
assert.equal(noLinkedZone.zoneInvalid, false, 'an absent linked zone is not invalidation');

const closedSession = monitor.finalActionContext(bridge(), 'ENTRY CONDITIONS MET', 29.1, 'closed');
assert.equal(closedSession.action, 'WAIT');
assert.match(closedSession.reason, /Closed-session result/);
const noZone = monitor.finalActionContext(bridge({ activeZone: null }), 'ENTRY CONDITIONS MET', 29.1);
assert.equal(noZone.action, 'DO_NOT_ENTER');
assert.equal(noZone.reason, 'No valid Active Zone');
assert.equal(noZone.zoneInvalid, false, 'no valid zone is not presented as invalidation');

const invalidated = monitor.finalActionContext(bridge(), 'ENTRY CONDITIONS MET', 28.4);
assert.equal(invalidated.action, 'DO_NOT_ENTER');
assert.equal(invalidated.zoneInvalid, true, 'only the linked ETF_DCA invalidation produces ZONE INVALID');

const html = fs.readFileSync(path.join(__dirname, '..', 'entry-assessment.html'), 'utf8');
assert.match(html, /id="final-action"/);
assert.match(html, /id="final-action-zone-warning"/);
assert.match(html, /SIGNAL MODE/);
assert.match(html, /id="signal-mode"/);
assert.match(html, /TarObiBridgeMonitor\?\.signalModeLabel\?\.\(assessment\.state\)/);
assert.match(html, /TarObiBridgeMonitor\?\.finalActionContext\?\.\(linkedBridge, assessment\.state, price, session\)/);
assert.match(html, /TAR-OBI Assessment Invalidation/);
assert.match(html, /ETF_DCA Zone Invalidation/);
console.log('final action UI tests passed');