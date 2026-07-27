'use strict';

const assert = require('node:assert/strict');
const modulePath = require.resolve('../bridge-loader.js');
const ETF_URL = 'https://dksbluesky.github.io/ETF_DCA-plan/';

function defineGlobal(name, value) {
    Object.defineProperty(global, name, {
        configurable: true,
        writable: true,
        value
    });
}

function loadNavigation({
    mobile = false,
    userAgent = mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    maxTouchPoints = mobile ? 5 : 0,
    opener = null,
    focusThrows = false,
    historyLength = 1,
    referrer = ''
} = {}) {
    const calls = { focus: 0, close: 0, back: 0, assign: [], open: 0 };
    if (opener) {
        opener.focus = () => { calls.focus += 1; if (focusThrows) throw new Error('focus blocked'); };
    }
    defineGlobal('navigator', {
        userAgent,
        maxTouchPoints,
        userAgentData: { mobile }
    });
    defineGlobal('opener', opener);
    defineGlobal('history', {
        length: historyLength,
        back() { calls.back += 1; }
    });
    defineGlobal('document', { referrer });
    defineGlobal('location', {
        assign(url) { calls.assign.push(url); }
    });
    defineGlobal('close', () => { calls.close += 1; });
    defineGlobal('open', () => { calls.open += 1; });
    defineGlobal('localStorage', {
        getItem() { return null; },
        setItem() {}
    });
    delete require.cache[modulePath];
    return { navigation: require(modulePath), calls };
}

{
    const opener = { closed: false };
    const { navigation, calls } = loadNavigation({ opener });
    assert.equal(navigation.returnToEtfDca(), 'opener');
    assert.equal(calls.focus, 1);
    assert.equal(calls.close, 1);
    assert.deepEqual(calls.assign, []);
    assert.equal(calls.back, 0);
    assert.equal(calls.open, 0);
}

{
    const { navigation, calls } = loadNavigation();
    assert.equal(navigation.returnToEtfDca(), 'fallback');
    assert.deepEqual(calls.assign, [ETF_URL]);
    assert.equal(calls.focus, 0);
    assert.equal(calls.close, 0);
    assert.equal(calls.back, 0);
    assert.equal(calls.open, 0);
}

{
    const opener = { closed: false };
    const { navigation, calls } = loadNavigation({ opener, focusThrows: true });
    assert.equal(navigation.returnToEtfDca(), 'fallback');
    assert.equal(calls.focus, 1);
    assert.equal(calls.close, 0);
    assert.deepEqual(calls.assign, [ETF_URL]);
    assert.equal(calls.open, 0);
}

{
    const { navigation, calls } = loadNavigation({
        mobile: true,
        historyLength: 2,
        referrer: `${ETF_URL}?ticker=006208`
    });
    assert.equal(navigation.returnToEtfDca(), 'history');
    assert.equal(calls.back, 1);
    assert.deepEqual(calls.assign, []);
    assert.equal(calls.open, 0);
}

{
    const { navigation, calls } = loadNavigation({
        mobile: true,
        historyLength: 1,
        referrer: ETF_URL
    });
    assert.equal(navigation.returnToEtfDca(), 'fallback');
    assert.equal(calls.back, 0);
    assert.deepEqual(calls.assign, [ETF_URL]);
    assert.equal(calls.open, 0);
}

{
    const { navigation, calls } = loadNavigation({
        mobile: false,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
        maxTouchPoints: 5,
        historyLength: 2,
        referrer: ETF_URL
    });
    assert.equal(navigation.returnToEtfDca(), 'history');
    assert.equal(calls.back, 1);
    assert.deepEqual(calls.assign, []);
    assert.equal(calls.open, 0);
}

{
    const { navigation, calls } = loadNavigation({
        mobile: true,
        historyLength: 3,
        referrer: 'https://example.com/unrelated'
    });
    assert.equal(navigation.returnToEtfDca(), 'fallback');
    assert.equal(calls.back, 0);
    assert.deepEqual(calls.assign, [ETF_URL]);
    assert.equal(calls.open, 0);
}

console.log('bridge navigation tests passed');
