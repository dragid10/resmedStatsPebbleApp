/**
 * Unit tests for the phone companion (src/pkjs/index.js).
 * Run with `npm test`.
 */

var test = require('node:test');
var assert = require('node:assert/strict');
var h = require('./harness');

/** Objects built inside the sandbox have its prototypes; compare as JSON. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function urlsHit(env) {
  return env.requests.map(function (r) {
    return r.url.replace(/^https:\/\/[^/]+/, '').replace(/\?.*$/, '');
  });
}

// ---------------------------------------------------------------------------
// Formatting and message sequence
// ---------------------------------------------------------------------------

test('formatDateForWatch turns ISO dates into "Mon D"', function () {
  var env = h.loadApp();
  assert.equal(env.app.formatDateForWatch('2026-10-24'), 'Oct 24');
  assert.equal(env.app.formatDateForWatch('2026-01-05T08:00:00Z'), 'Jan 5');
});

test('sendRecordsToWatch sends newest 7 nights in order, then DATA_COMPLETE', function () {
  var env = h.loadApp();
  var items = [];
  for (var day = 10; day <= 18; day++) {
    items.push(h.sleepRecord('2026-10-' + day, { sleepScore: day }));
  }
  env.app.sendRecordsToWatch(items);

  assert.deepEqual(plain(env.sent[0]), { TOTAL_DAYS: 7 });
  var dayMessages = env.sent.slice(1, 8);
  assert.deepEqual(dayMessages.map(function (m) { return m.RECORD_DATE; }),
    ['Oct 18', 'Oct 17', 'Oct 16', 'Oct 15', 'Oct 14', 'Oct 13', 'Oct 12']);
  assert.deepEqual(dayMessages.map(function (m) { return m.DAY_INDEX; }), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(plain(env.sent[8]), { DATA_COMPLETE: 1 });
  assert.equal(env.sent.length, 9);
});

test('sendRecordsToWatch scales AHI by 10, rounds leak, and defaults missing fields to 0', function () {
  var env = h.loadApp();
  env.app.sendRecordsToWatch([
    h.sleepRecord('2026-10-24', { ahi: 3.24, leakPercentile: 7.6 }),
    { startDate: '2026-10-23' }
  ]);
  assert.equal(env.sent[1].AHI_X10, 32);
  assert.equal(env.sent[1].LEAK_PCT, 8);
  assert.deepEqual(plain(env.sent[2]), {
    DAY_INDEX: 1, RECORD_DATE: 'Oct 23', SLEEP_SCORE: 0, AHI_X10: 0,
    USAGE_MINS: 0, MASK_COUNT: 0, LEAK_PCT: 0
  });
});

test('extractCountryFromIdToken reads myAirCountryId and falls back to US', function () {
  var env = h.loadApp();
  var payload = Buffer.from(JSON.stringify({ myAirCountryId: 'CA' }))
    .toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(env.app.extractCountryFromIdToken('h.' + payload + '.s'), 'CA');
  assert.equal(env.app.extractCountryFromIdToken('not-a-jwt'), 'US');
});

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

test('getCachedToken returns a token until 5 minutes before expiry', function () {
  var env = h.loadApp({ storage: h.withCachedToken() });
  assert.equal(env.app.getCachedToken().accessToken, 'cached-token');

  env.storage.resmed_token_expiry = String(Date.now() + 4 * 60 * 1000);
  assert.equal(env.app.getCachedToken(), null);
});

// ---------------------------------------------------------------------------
// Fetch flow and retries
// ---------------------------------------------------------------------------

test('a cached token goes straight to GraphQL and marks the account connected', function () {
  var env = h.loadApp({
    storage: h.withCachedToken(),
    routes: [{ match: /graphql/, respond: function () {
      return h.graphqlOk([h.sleepRecord('2026-10-24')]);
    } }]
  });
  env.app.fetchAndSendSleepData();

  assert.deepEqual(urlsHit(env), ['/graphql']);
  assert.equal(env.requests[0].headers.Authorization, 'Bearer cached-token');
  assert.deepEqual(plain(env.sent[env.sent.length - 1]), { DATA_COMPLETE: 1 });
  assert.equal(env.storage.resmed_connected, 'true');
});

test('a 401 on a cached token retries with a fresh login instead of failing', function () {
  var graphqlCalls = 0;
  var env = h.loadApp({
    storage: h.withCachedToken(),
    routes: h.oktaLoginRoutes().concat([{ match: /graphql/, respond: function () {
      graphqlCalls++;
      return graphqlCalls === 1 ? { status: 401 } : h.graphqlOk([h.sleepRecord('2026-10-24')]);
    } }])
  });
  env.app.fetchAndSendSleepData();
  assert.deepEqual(env.runTimers(), [2000]);

  assert.deepEqual(urlsHit(env), [
    '/graphql',
    '/api/v1/authn', '/oauth2/aus4ccsxvnidQgLmA297/v1/authorize',
    '/oauth2/aus4ccsxvnidQgLmA297/v1/token', '/graphql'
  ]);
  assert.equal(env.requests[4].headers.Authorization, 'Bearer fresh-token');
  assert.deepEqual(env.errorsSent(), []);
  assert.equal(env.storage.resmed_access_token, 'fresh-token');
});

test('network errors retry twice with backoff, then report the error', function () {
  var env = h.loadApp({
    storage: h.withCachedToken(),
    routes: [{ match: /./, respond: function () { return { error: 'network' }; } }]
  });
  env.app.fetchAndSendSleepData();
  assert.deepEqual(env.runTimers(), [2000, 5000]);

  assert.equal(env.requests.length, 3);
  assert.deepEqual(env.errorsSent(), ['Network error']);
  assert.equal(env.app.isDataFetchInProgress, false);
});

test('a wrong password is reported right away without retrying', function () {
  var env = h.loadApp({
    storage: h.CREDENTIALS,
    routes: [{ match: /authn/, respond: function () { return { status: 401 }; } }]
  });
  env.app.fetchAndSendSleepData();

  assert.equal(env.timers.length, 0);
  assert.deepEqual(env.errorsSent(), ['Login failed (401)']);
});

test('isPermanentFetchError only skips retries for errors a retry cannot fix', function () {
  var env = h.loadApp();
  ['Login failed: LOCKED_OUT', 'Login failed (401)', 'No CPAP data found',
   'Rate limited. Try later.', 'MFA login not supported yet (MFA_ENROLL)',
   'Account locked. Unlock it on myAir', 'Password expired. Change it on myAir',
   'Invalid region'].forEach(function (msg) {
    assert.equal(env.app.isPermanentFetchError(msg), true, msg);
  });
  ['Network error', 'Request timeout', 'Session expired. Try again.', 'API error (502)',
   'Could not get auth code', 'Auth code error (500)', 'Token error'].forEach(function (msg) {
    assert.equal(env.app.isPermanentFetchError(msg), false, msg);
  });
});

test('Okta statuses we cannot complete name the status and are not retried', function () {
  [['MFA_REQUIRED', 'MFA login not supported yet (MFA_REQUIRED)'],
   ['MFA_ENROLL', 'MFA login not supported yet (MFA_ENROLL)'],
   ['LOCKED_OUT', 'Account locked. Unlock it on myAir'],
   ['PASSWORD_EXPIRED', 'Password expired. Change it on myAir'],
   ['RECOVERY', 'Login failed: RECOVERY'],
   [undefined, 'Login failed: unknown']].forEach(function (pair) {
    var env = h.loadApp({
      storage: h.CREDENTIALS,
      routes: [{ match: /authn/, respond: function () {
        return { status: 200, body: JSON.stringify({ status: pair[0], stateToken: 'st' }) };
      } }]
    });
    env.app.fetchAndSendSleepData();
    assert.equal(env.timers.length, 0, String(pair[0]));
    assert.deepEqual(env.errorsSent(), [pair[1]]);
    assert.ok(pair[1].length <= 60, pair[1]);
  });
});

test('a password-expiry warning is skipped and login continues', function () {
  var routes = h.oktaLoginRoutes();
  routes[0] = { match: /\/api\/v1\/authn$/, respond: function () {
    return { status: 200, body: JSON.stringify({
      status: 'PASSWORD_WARN', stateToken: 'st',
      _links: { skip: { href: 'https://resmed-ext-1.okta.com/api/v1/authn/skip' } }
    }) };
  } };
  routes.unshift({ match: /\/authn\/skip$/, respond: function (req) {
    assert.deepEqual(JSON.parse(req.body), { stateToken: 'st' });
    return { status: 200, body: JSON.stringify({ status: 'SUCCESS', sessionToken: 'sess' }) };
  } });
  var env = h.loadApp({
    storage: h.CREDENTIALS,
    routes: routes.concat([{ match: /graphql/, respond: function () {
      return h.graphqlOk([h.sleepRecord('2026-10-24')]);
    } }])
  });
  env.app.fetchAndSendSleepData();

  assert.deepEqual(urlsHit(env), [
    '/api/v1/authn', '/api/v1/authn/skip', '/oauth2/aus4ccsxvnidQgLmA297/v1/authorize',
    '/oauth2/aus4ccsxvnidQgLmA297/v1/token', '/graphql'
  ]);
  assert.deepEqual(env.errorsSent(), []);
});

test('a second password-expiry warning is reported instead of looping', function () {
  var env = h.loadApp({
    storage: h.CREDENTIALS,
    routes: [{ match: /authn/, respond: function () {
      return { status: 200, body: JSON.stringify({
        status: 'PASSWORD_WARN', stateToken: 'st',
        _links: { skip: { href: 'https://resmed-ext-1.okta.com/api/v1/authn/skip' } }
      }) };
    } }]
  });
  env.app.fetchAndSendSleepData();
  assert.equal(env.requests.length, 2);
  assert.deepEqual(env.errorsSent(), ['Login failed: PASSWORD_WARN']);
});

test('a non-200 authorize response is reported with its status', function () {
  var routes = h.oktaLoginRoutes();
  routes[1] = { match: /\/v1\/authorize\?/, respond: function () {
    return { status: 403, body: '' };
  } };
  var env = h.loadApp({ storage: h.CREDENTIALS, routes: routes });
  env.app.fetchAndSendSleepData();
  env.runTimers();
  assert.deepEqual(env.errorsSent(), ['Auth code error (403)']);
});

test('a fetch stuck past the stale limit no longer blocks new requests', function () {
  var env = h.loadApp({
    storage: h.withCachedToken(),
    routes: [{ match: /./, respond: function () { return { error: 'network' }; } }]
  });
  env.app.isDataFetchInProgress = true;
  env.app.fetchStartedAt = Date.now() - env.app.FETCH_STALE_MS - 1;
  env.app.fetchAndSendSleepData();
  assert.equal(env.requests.length, 1);
});

test('a second REQUEST_DATA while a fetch is in flight is ignored', function () {
  var env = h.loadApp({
    storage: h.withCachedToken(),
    routes: [{ match: /./, respond: function () { return { error: 'network' }; } }]
  });
  env.emit('appmessage', { payload: { REQUEST_DATA: 1 } });
  env.emit('appmessage', { payload: { REQUEST_DATA: 1 } });
  assert.equal(env.requests.length, 1);
});

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

test('ready with credentials waits for the watch to ask instead of fetching', function () {
  var env = h.loadApp({ storage: h.withCachedToken() });
  env.emit('ready');
  assert.equal(env.requests.length, 0);
  assert.equal(env.sent.length, 0);
});

test('ready without credentials tells the watch to log in', function () {
  var env = h.loadApp();
  env.emit('ready');
  assert.deepEqual(env.errorsSent(), ['Open Settings to log in']);
});

test('FRESH_INSTALL after a successful connection clears stored credentials', function () {
  var env = h.loadApp({ storage: h.withCachedToken({ resmed_connected: 'true' }) });
  env.emit('appmessage', { payload: { FRESH_INSTALL: 1 } });
  assert.equal(env.storage.resmed_email, undefined);
  assert.equal(env.storage.resmed_password, undefined);
  assert.equal(env.storage.resmed_access_token, undefined);
});

test('FRESH_INSTALL before any successful connection keeps credentials', function () {
  var env = h.loadApp({ storage: h.withCachedToken() });
  env.emit('appmessage', { payload: { FRESH_INSTALL: 1 } });
  assert.equal(env.storage.resmed_email, 'alex@example.com');
  assert.equal(env.storage.resmed_access_token, undefined);
});

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

function closeWith(env, payload) {
  env.emit('webviewclosed', { response: encodeURIComponent(JSON.stringify(payload)) });
}

test('saving settings stores them and forwards them to the watch', function () {
  var env = h.loadApp({ storage: h.CREDENTIALS });
  closeWith(env, {
    COLORBLIND_MODE: true, TEXT_INDICATORS: false, SYNC_INTERVAL: 8,
    SHOW_EVENTS: true, SHOW_USAGE: false, SHOW_MASK_OFF: true, SHOW_LEAK: false
  });
  assert.deepEqual(plain(env.sent[0]), {
    COLORBLIND_MODE: 1, TEXT_INDICATORS: 0, SYNC_INTERVAL: 8,
    SHOW_EVENTS: 1, SHOW_USAGE: 0, SHOW_MASK_OFF: 1, SHOW_LEAK: 0
  });
  assert.equal(env.storage.setting_sync_interval, '8');
  assert.equal(env.storage.setting_show_usage, 'false');
});

test('disconnecting clears credentials and sends the watch to the setup screen', function () {
  var env = h.loadApp({ storage: h.withCachedToken({ resmed_connected: 'true' }) });
  closeWith(env, { Logout: true });
  assert.equal(env.storage.resmed_email, undefined);
  assert.equal(env.storage.resmed_connected, undefined);
  assert.deepEqual(env.errorsSent(), ['Open Settings to log in']);
});

test('logging in with Clay values stores credentials and fetches immediately', function () {
  var env = h.loadApp({
    routes: h.oktaLoginRoutes().concat([{ match: /graphql/, respond: function () {
      return h.graphqlOk([h.sleepRecord('2026-10-24')]);
    } }])
  });
  closeWith(env, {
    Email: { value: 'alex@example.com' }, Password: { value: 'hunter2' }, Region: { value: 'NA' }
  });
  assert.equal(env.storage.resmed_email, 'alex@example.com');
  assert.equal(env.storage.resmed_connected, 'true');
  assert.deepEqual(plain(env.sent[env.sent.length - 1]), { DATA_COMPLETE: 1 });
});

test('saving a login shows "Logging in" on the watch before the fetch', function () {
  var env = h.loadApp({
    routes: [{ match: /authn/, respond: function () { return { status: 401 }; } }]
  });
  closeWith(env, {
    Email: { value: 'alex@example.com' }, Password: { value: 'hunter2' }, Region: { value: 'EU' }
  });
  assert.deepEqual(plain(env.sent[0]), { LOGGING_IN: 1 });
  assert.match(env.requests[0].url, /^https:\/\/id\.resmed\.eu\/api\/v1\/authn$/);
  assert.deepEqual(env.errorsSent(), ['Login failed (401)']);
});

test('saving a login abandons a fetch still running with the old credentials', function () {
  var authnBodies = [];
  var env = h.loadApp({
    storage: h.CREDENTIALS,
    routes: [{ match: /authn/, respond: function (req) {
      authnBodies.push(JSON.parse(req.body).password);
      return { error: 'network' };
    } }]
  });
  env.app.fetchAndSendSleepData();
  assert.equal(env.timers.length, 1);
  closeWith(env, {
    Email: { value: 'alex@example.com' }, Password: { value: 'new-pass' }, Region: { value: 'NA' }
  });
  env.runTimers();

  // The old fetch's pending retry is dropped; only the new login retries
  assert.deepEqual(authnBodies, ['hunter2', 'new-pass', 'new-pass', 'new-pass']);
  assert.deepEqual(env.errorsSent(), ['Network error']);
});

test('settings that are already URL-decoded still log in when the password has a %', function () {
  var env = h.loadApp({
    routes: [{ match: /authn/, respond: function () { return { status: 401 }; } }]
  });
  env.emit('webviewclosed', { response: JSON.stringify({
    Email: { value: 'alex@example.com' }, Password: { value: '100%sure' }, Region: { value: 'NA' }
  }) });
  assert.equal(env.storage.resmed_password, '100%sure');
});

test('an unreadable settings response is reported to the watch', function () {
  var env = h.loadApp();
  env.emit('webviewclosed', { response: encodeURIComponent('{not json') });
  assert.deepEqual(env.errorsSent(), ['Could not read settings. Try again']);
});

test('an invalid email is rejected without being stored', function () {
  var env = h.loadApp();
  closeWith(env, { Email: { value: 'not-an-email' }, Password: { value: 'x' } });
  assert.equal(env.storage.resmed_email, undefined);
  assert.deepEqual(env.errorsSent(), ['Invalid email format']);
});

// ---------------------------------------------------------------------------
// Email-code (MFA) login
// ---------------------------------------------------------------------------

var EU_OKTA = 'https://id.resmed.eu';
var VERIFY_URL = EU_OKTA + '/api/v1/authn/factors/emf123/verify';

function mfaRequired(factorOverrides) {
  return { status: 200, body: JSON.stringify({
    status: 'MFA_REQUIRED', stateToken: 'st-1',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    _embedded: { factors: [Object.assign({
      id: 'emf123', factorType: 'email', _links: { verify: { href: VERIFY_URL } }
    }, factorOverrides || {})] }
  }) };
}

/** EU routes: authn asks for a code; verify sends it, then accepts `goodCode`. */
function euMfaRoutes(goodCode, calls) {
  var login = h.oktaLoginRoutes();
  return [
    { match: /\/authn\/factors\/emf123\/verify/, respond: function (req) {
      var body = JSON.parse(req.body);
      calls.push({ url: req.url, body: body });
      if (body.passCode === undefined) {
        return { status: 200, body: JSON.stringify({ status: 'MFA_CHALLENGE', stateToken: 'st-1' }) };
      }
      if (body.passCode !== goodCode) return { status: 403, body: '{}' };
      return { status: 200, body: JSON.stringify({ status: 'SUCCESS', sessionToken: 'sess' }) };
    } },
    { match: /\/api\/v1\/authn$/, respond: function () { return mfaRequired(); } },
    login[1], login[2],
    { match: /graphql/, respond: function () { return h.graphqlOk([h.sleepRecord('2026-10-24')]); } }
  ];
}

var EU_LOGIN = {
  Email: { value: 'alex@example.com' }, Password: { value: 'hunter2' }, Region: { value: 'EU' }
};

test('an EU login that needs an email code sends the code and asks for it', function () {
  var calls = [];
  var env = h.loadApp({ routes: euMfaRoutes('123456', calls) });
  closeWith(env, EU_LOGIN);

  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].body), { stateToken: 'st-1' });
  assert.match(calls[0].url, /\?rememberDevice=true$/);
  assert.equal(env.timers.length, 0);
  assert.deepEqual(env.errorsSent(), ['Code emailed. Enter it in the phone app']);

  env.emit('showConfiguration');
  var page = decodeURIComponent(env.app.Pebble.openedUrl.replace(/^data:text\/html,/, ''));
  assert.match(page, /Check your email/);
  assert.match(page, /id="code"/);
});

test('entering the emailed code finishes the login and loads data', function () {
  var calls = [];
  var env = h.loadApp({ routes: euMfaRoutes('123456', calls) });
  closeWith(env, EU_LOGIN);
  closeWith(env, { MfaCode: ' 123 456 ' });

  assert.deepEqual(plain(calls[1].body), { stateToken: 'st-1', passCode: '123456' });
  assert.equal(env.storage.resmed_mfa_pending, undefined);
  assert.equal(env.storage.resmed_access_token, 'fresh-token');
  assert.equal(env.storage.resmed_connected, 'true');
  assert.deepEqual(plain(env.sent[env.sent.length - 1]), { DATA_COMPLETE: 1 });
});

test('a wrong code keeps the challenge open so the user can try again', function () {
  var calls = [];
  var env = h.loadApp({ routes: euMfaRoutes('123456', calls) });
  closeWith(env, EU_LOGIN);
  closeWith(env, { MfaCode: '999999' });

  assert.deepEqual(env.errorsSent().slice(-1), ['Wrong code. Try again in the phone app']);
  assert.notEqual(env.storage.resmed_mfa_pending, undefined);

  closeWith(env, { MfaCode: '123456' });
  assert.equal(env.storage.resmed_connected, 'true');
});

test('a background refresh that hits the code check does not email a code', function () {
  var calls = [];
  var env = h.loadApp({
    storage: Object.assign({}, h.CREDENTIALS, { resmed_region: 'EU' }),
    routes: euMfaRoutes('123456', calls)
  });
  env.emit('appmessage', { payload: { REQUEST_DATA: 1 } });

  assert.equal(calls.length, 0);
  assert.deepEqual(env.errorsSent(), ['Code needed. Open the phone app']);

  env.emit('showConfiguration');
  var page = decodeURIComponent(env.app.Pebble.openedUrl.replace(/^data:text\/html,/, ''));
  assert.match(page, /Email me a code/);
});

test('a background refresh while a code is pending keeps that code valid', function () {
  var calls = [];
  var env = h.loadApp({ routes: euMfaRoutes('123456', calls) });
  closeWith(env, EU_LOGIN);
  var authnCount = env.requests.filter(function (r) { return /\/authn$/.test(r.url); }).length;

  env.emit('appmessage', { payload: { REQUEST_DATA: 1 } });
  assert.equal(env.requests.filter(function (r) { return /\/authn$/.test(r.url); }).length,
    authnCount);
  assert.deepEqual(env.errorsSent().slice(-1), ['Code emailed. Enter it in the phone app']);
});

test('a verify link off the region\'s Okta host is not followed', function () {
  var env = h.loadApp({
    routes: [{ match: /authn$/, respond: function () {
      return mfaRequired({ _links: { verify: { href: 'https://evil.example/verify' } } });
    } }]
  });
  closeWith(env, EU_LOGIN);
  assert.equal(env.requests.length, 1);
  assert.deepEqual(env.errorsSent(), ['MFA login not supported yet (MFA_REQUIRED)']);
});

test('an expired code challenge asks the user to start over', function () {
  var env = h.loadApp({ storage: Object.assign({}, h.CREDENTIALS, {
    resmed_region: 'EU',
    resmed_mfa_pending: JSON.stringify({
      stateToken: 'st-1', verifyUrl: VERIFY_URL, expiresAt: Date.now() - 1, codeSent: true
    })
  }) });
  closeWith(env, { MfaCode: '123456' });
  assert.equal(env.requests.length, 0);
  assert.deepEqual(env.errorsSent().slice(-1), ['Code expired. Open the phone app']);
});

test('disconnecting clears a pending code challenge', function () {
  var calls = [];
  var env = h.loadApp({ routes: euMfaRoutes('123456', calls) });
  closeWith(env, EU_LOGIN);
  closeWith(env, { Logout: true });
  assert.equal(env.storage.resmed_mfa_pending, undefined);
});

test('MFA messages never trigger the watch\'s "not configured" wipe', function () {
  var env = h.loadApp();
  ['MSG_CODE_SENT', 'MSG_CODE_NEEDED', 'MSG_CODE_WRONG', 'MSG_CODE_EXPIRED'].forEach(function (k) {
    var msg = env.app[k];
    assert.ok(msg.indexOf('Settings') === -1 && msg.indexOf('log in') === -1, msg);
    assert.ok(msg.length <= 60, msg);
    assert.equal(env.app.isPermanentFetchError(msg), true, msg);
  });
});

// ---------------------------------------------------------------------------
// Token handling after login
// ---------------------------------------------------------------------------

test('an escaped auth code from Okta is unescaped before the token exchange', function () {
  var routes = h.oktaLoginRoutes();
  routes[1] = { match: /\/v1\/authorize\?/, respond: function () {
    return { status: 200, body: "<script>data.code = 'ab\\x2Dcd\\x5Fef';</script>" };
  } };
  var env = h.loadApp({ storage: h.CREDENTIALS, routes: routes.concat([
    { match: /graphql/, respond: function () { return h.graphqlOk([h.sleepRecord('2026-10-24')]); } }
  ]) });
  env.app.fetchAndSendSleepData();
  var tokenReq = env.requests.filter(function (r) { return /\/v1\/token$/.test(r.url); })[0];
  assert.match(tokenReq.body, /code=ab-cd_ef&/);
});

test('an account with no CPAP machine reports it and stays connected', function () {
  var env = h.loadApp({
    storage: h.withCachedToken(),
    routes: [{ match: /graphql/, respond: function () {
      return { status: 200, body: JSON.stringify({ errors: [{
        errorType: 'myAir:result', extensions: { errorCode: 'equipmentNotAssigned' }
      }] }) };
    } }]
  });
  env.app.fetchAndSendSleepData();
  assert.equal(env.timers.length, 0);
  assert.deepEqual(env.errorsSent(), ['No CPAP machine linked to this myAir account']);
  assert.equal(env.storage.resmed_connected, 'true');
  assert.equal(env.storage.resmed_access_token, 'cached-token');
});

test('a retry after a transient API error keeps the cached token', function () {
  var calls = 0;
  var env = h.loadApp({
    storage: h.withCachedToken(),
    routes: [{ match: /graphql/, respond: function () {
      calls++;
      return calls === 1 ? { status: 502 } : h.graphqlOk([h.sleepRecord('2026-10-24')]);
    } }]
  });
  env.app.fetchAndSendSleepData();
  env.runTimers();
  assert.deepEqual(urlsHit(env), ['/graphql', '/graphql']);
  assert.equal(env.storage.resmed_connected, 'true');
});

test('EU logins keep a refresh token and use it instead of a new emailed code', function () {
  var calls = [];
  var routes = euMfaRoutes('123456', calls);
  routes[3] = { match: /\/v1\/token$/, respond: function (req) {
    if (/grant_type=refresh_token/.test(req.body)) {
      return { status: 200, body: JSON.stringify({ access_token: 'refreshed', expires_in: 3600 }) };
    }
    return { status: 200, body: JSON.stringify({
      access_token: 'fresh-token', id_token: 'a.b.c', refresh_token: 'rt-1', expires_in: 3600
    }) };
  } };
  var env = h.loadApp({ routes: routes });
  closeWith(env, EU_LOGIN);
  closeWith(env, { MfaCode: '123456' });
  assert.match(env.requests.filter(function (r) { return /authorize/.test(r.url); })[0].url,
    /scope=openid%20profile%20email%20offline_access/);
  assert.equal(env.storage.resmed_refresh_token, 'rt-1');
  assert.equal(env.storage.resmed_password, undefined, 'password is dropped once a refresh token works');

  // Access token expires: the next refresh uses the refresh token, no authn
  env.storage.resmed_token_expiry = String(Date.now() - 1);
  var before = env.requests.length;
  env.emit('appmessage', { payload: { REQUEST_DATA: 1 } });
  assert.deepEqual(urlsHit({ requests: env.requests.slice(before) }),
    ['/oauth2/aus2uznux2sYKTsEg417/v1/token', '/graphql']);
  assert.equal(env.storage.resmed_access_token, 'refreshed');
});

test('a rejected refresh token falls back to a full login', function () {
  var env = h.loadApp({
    storage: Object.assign({}, h.CREDENTIALS, { resmed_region: 'EU', resmed_refresh_token: 'old' }),
    routes: [
      { match: /\/v1\/token$/, respond: function () { return { status: 400, body: '{}' }; } },
      { match: /\/api\/v1\/authn$/, respond: function () { return { status: 401 }; } }
    ]
  });
  env.app.fetchAndSendSleepData();
  assert.equal(env.storage.resmed_refresh_token, undefined);
  assert.deepEqual(env.errorsSent(), ['Login failed (401)']);
});

test('NA logins also ask for a refresh token', function () {
  var env = h.loadApp({ storage: h.CREDENTIALS, routes: h.oktaLoginRoutes().concat([
    { match: /graphql/, respond: function () { return h.graphqlOk([h.sleepRecord('2026-10-24')]); } }
  ]) });
  env.app.fetchAndSendSleepData();
  var authorize = env.requests.filter(function (r) { return /authorize/.test(r.url); })[0];
  assert.match(authorize.url, /offline_access/);
});

test('with the password dropped, a rejected refresh token asks the user to log in again', function () {
  var env = h.loadApp({
    storage: { resmed_email: 'alex@example.com', resmed_region: 'EU',
               resmed_refresh_token: 'old', resmed_connected: 'true' },
    routes: [{ match: /\/v1\/token$/, respond: function () { return { status: 400, body: '{}' }; } }]
  });
  env.app.fetchAndSendSleepData();
  assert.equal(env.requests.length, 1);
  assert.equal(env.timers.length, 0);
  assert.deepEqual(env.errorsSent(), ['Open Settings to log in']);
  assert.equal(env.storage.resmed_refresh_token, undefined);
  assert.equal(env.storage.resmed_connected, undefined);
});

test('the password is kept when Okta returns no refresh token', function () {
  var env = h.loadApp({ storage: h.CREDENTIALS, routes: h.oktaLoginRoutes().concat([
    { match: /graphql/, respond: function () { return h.graphqlOk([h.sleepRecord('2026-10-24')]); } }
  ]) });
  env.app.fetchAndSendSleepData();
  assert.equal(env.storage.resmed_password, 'hunter2');
  assert.equal(env.storage.resmed_refresh_token, undefined);
});

test('an NA refresh token replaces the password and renews the login', function () {
  var routes = h.oktaLoginRoutes();
  routes[2] = { match: /\/v1\/token$/, respond: function (req) {
    if (/grant_type=refresh_token/.test(req.body)) {
      return { status: 200, body: JSON.stringify({ access_token: 'refreshed', refresh_token: 'rt-2', expires_in: 3600 }) };
    }
    return { status: 200, body: JSON.stringify({
      access_token: 'fresh-token', id_token: 'a.b.c', refresh_token: 'rt-1', expires_in: 3600
    }) };
  } };
  var env = h.loadApp({ storage: h.CREDENTIALS, routes: routes.concat([
    { match: /graphql/, respond: function () { return h.graphqlOk([h.sleepRecord('2026-10-24')]); } }
  ]) });
  env.app.fetchAndSendSleepData();
  assert.equal(env.storage.resmed_password, undefined);

  env.storage.resmed_token_expiry = String(Date.now() - 1);
  var before = env.requests.length;
  env.app.fetchAndSendSleepData();
  assert.deepEqual(urlsHit({ requests: env.requests.slice(before) }),
    ['/oauth2/aus4ccsxvnidQgLmA297/v1/token', '/graphql']);
  assert.equal(env.storage.resmed_refresh_token, 'rt-2');
});

test('an expired code challenge is deleted from storage', function () {
  var env = h.loadApp({ storage: { resmed_mfa_pending: JSON.stringify({
    stateToken: 'st-1', verifyUrl: VERIFY_URL, expiresAt: Date.now() - 1, codeSent: true
  }) } });
  assert.equal(env.app.getPendingMfa(), null);
  assert.equal(env.storage.resmed_mfa_pending, undefined);
});

// ---------------------------------------------------------------------------
// API metadata and device registration
// ---------------------------------------------------------------------------

/** Cached token, but no cached metadata and no registered device. */
function unregisteredStorage(extra) {
  var storage = h.withCachedToken(extra);
  delete storage.resmed_device_id;
  delete storage.resmed_api_config_NA;
  delete storage.resmed_registered_NA;
  return storage;
}

function graphqlRoute() {
  return { match: /graphql/, respond: function () {
    return h.graphqlOk([h.sleepRecord('2026-10-24')]);
  } };
}

test('a new install reads the metadata, registers its own handset ID, then fetches', function () {
  var env = h.loadApp({ storage: unregisteredStorage(), routes: [graphqlRoute()] });
  env.app.fetchAndSendSleepData();

  assert.deepEqual(urlsHit(env),
    ['/v2/metadata.json', '/V1/Patient/RegisterApplication', '/graphql']);
  var deviceId = env.storage.resmed_device_id;
  assert.match(deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  var register = env.requests[1];
  assert.equal(register.url, 'https://rest.NA.example/V1/Patient/RegisterApplication');
  assert.equal(register.method, 'POST');
  assert.equal(register.headers['x-api-key'], 'rest-key-NA');
  assert.equal(register.headers.rmdhandsetid, deviceId);
  assert.equal(register.headers.Authorization, 'Bearer cached-token');

  var graphql = env.requests[2];
  assert.equal(graphql.url, 'https://appsync.NA.example/graphql');
  assert.equal(graphql.headers['x-api-key'], 'appsync-key-NA');
  assert.equal(graphql.headers.rmdhandsetid, deviceId);

  assert.equal(env.storage.resmed_registered_NA, 'alex@example.com|' + deviceId);
  assert.deepEqual(plain(env.sent[env.sent.length - 1]), { DATA_COMPLETE: 1 });
});

test('two installs get different handset IDs', function () {
  var ids = [1, 2].map(function () {
    var env = h.loadApp({ storage: unregisteredStorage(), routes: [graphqlRoute()] });
    env.app.fetchAndSendSleepData();
    return env.storage.resmed_device_id;
  });
  assert.notEqual(ids[0], ids[1]);
});

test('the EU region reads the EU metadata file', function () {
  var storage = unregisteredStorage({ resmed_region: 'EU' });
  delete storage.resmed_api_config_EU;
  delete storage.resmed_registered_EU;
  var env = h.loadApp({ storage: storage, routes: [graphqlRoute()] });
  env.app.fetchAndSendSleepData();
  assert.match(env.requests[0].url, /^https:\/\/assets\.hyperdrive\.resmed\.eu\/.*product=myAir%20EU$/);
  assert.equal(env.requests[2].url, 'https://appsync.EU.example/graphql');
  assert.ok(env.storage.resmed_registered_EU);
});

test('metadata older than a day is read again', function () {
  var stale = JSON.parse(h.apiConfig('NA'));
  stale.fetchedAt = Date.now() - 25 * 60 * 60 * 1000;
  var env = h.loadApp({
    storage: h.withCachedToken({ resmed_api_config_NA: JSON.stringify(stale) }),
    routes: [graphqlRoute()]
  });
  env.app.fetchAndSendSleepData();
  assert.deepEqual(urlsHit(env), ['/v2/metadata.json', '/graphql']);
  assert.ok(JSON.parse(env.storage.resmed_api_config_NA).fetchedAt > stale.fetchedAt);
});

test('if the metadata file is unreachable, a stale copy is used', function () {
  var stale = JSON.parse(h.apiConfig('NA'));
  stale.fetchedAt = 0;
  var env = h.loadApp({
    storage: h.withCachedToken({ resmed_api_config_NA: JSON.stringify(stale) }),
    routes: [{ match: /metadata/, respond: function () { return { status: 503 }; } }, graphqlRoute()]
  });
  env.app.fetchAndSendSleepData();
  assert.deepEqual(urlsHit(env), ['/v2/metadata.json', '/graphql']);
  assert.deepEqual(plain(env.sent[env.sent.length - 1]), { DATA_COMPLETE: 1 });
});

test('with no metadata at all, the fetch retries and then reports the error', function () {
  var env = h.loadApp({
    storage: unregisteredStorage(),
    routes: [{ match: /metadata/, respond: function () { return { error: 'network' }; } }]
  });
  env.app.fetchAndSendSleepData();
  env.runTimers();
  assert.deepEqual(urlsHit(env),
    ['/v2/metadata.json', '/v2/metadata.json', '/v2/metadata.json']);
  assert.deepEqual(env.errorsSent(), ['Network error']);
});

test('a failed registration still fetches and is tried again next time', function () {
  var registerStatus = 500;
  var env = h.loadApp({
    storage: unregisteredStorage(),
    routes: [{ match: /RegisterApplication/, respond: function () {
      return { status: registerStatus, body: '{}' };
    } }, graphqlRoute()]
  });
  env.app.fetchAndSendSleepData();
  assert.deepEqual(plain(env.sent[env.sent.length - 1]), { DATA_COMPLETE: 1 });
  assert.equal(env.storage.resmed_registered_NA, undefined);

  registerStatus = 200;
  var before = env.requests.length;
  env.app.fetchAndSendSleepData();
  assert.deepEqual(urlsHit({ requests: env.requests.slice(before) }),
    ['/V1/Patient/RegisterApplication', '/graphql']);
  assert.ok(env.storage.resmed_registered_NA);
});

test('a GraphQL error makes the retry register the device again', function () {
  var calls = 0;
  var env = h.loadApp({
    storage: h.withCachedToken(),
    routes: [{ match: /graphql/, respond: function () {
      calls++;
      if (calls === 1) {
        return { status: 200, body: JSON.stringify({ errors: [{ errorType: 'myAir:result' }] }) };
      }
      return h.graphqlOk([h.sleepRecord('2026-10-24')]);
    } }]
  });
  env.app.fetchAndSendSleepData();
  env.runTimers();
  assert.deepEqual(urlsHit(env),
    ['/graphql', '/V1/Patient/RegisterApplication', '/graphql']);
  assert.deepEqual(plain(env.sent[env.sent.length - 1]), { DATA_COMPLETE: 1 });
});

test('logging in to a different account registers the device for it', function () {
  var env = h.loadApp({
    storage: h.withCachedToken({ resmed_email: 'other@example.com' }),
    routes: [graphqlRoute()]
  });
  env.app.fetchAndSendSleepData();
  assert.deepEqual(urlsHit(env), ['/V1/Patient/RegisterApplication', '/graphql']);
  assert.equal(env.storage.resmed_registered_NA, 'other@example.com|' + h.DEVICE_ID);
});

test('disconnecting forgets device registrations', function () {
  var env = h.loadApp({ storage: h.withCachedToken({ resmed_connected: 'true' }) });
  closeWith(env, { Logout: true });
  assert.equal(env.storage.resmed_registered_NA, undefined);
  assert.equal(env.storage.resmed_registered_EU, undefined);
});
