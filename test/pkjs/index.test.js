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
