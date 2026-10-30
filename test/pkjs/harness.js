/**
 * Loads src/pkjs/index.js in a sandbox with fake PebbleKit JS globals
 * (Pebble, localStorage, XMLHttpRequest, timers) so its logic can be
 * unit-tested in Node without a phone.
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SRC_DIR = path.join(__dirname, '..', '..', 'src', 'pkjs');
var INDEX_SOURCE = fs.readFileSync(path.join(SRC_DIR, 'index.js'), 'utf8');

function createLocalStorage(initial) {
  var store = Object.assign({}, initial || {});
  return {
    store: store,
    getItem: function (key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem: function (key, value) { store[key] = String(value); },
    removeItem: function (key) { delete store[key]; }
  };
}

/**
 * Create a sandboxed copy of the phone app.
 *
 * `routes` is a list of { match: RegExp, respond: function (req) -> response }
 * checked in order for each XHR. A response is { status, body } for a reply,
 * or { error: 'network' | 'timeout' }.
 */
function loadApp(options) {
  options = options || {};
  var listeners = {};
  var sentMessages = [];
  var requests = [];
  var timers = [];
  // Tests' own routes win; metadata and device registration just succeed
  var routes = (options.routes || []).concat(defaultRoutes());
  var localStorage = createLocalStorage(options.storage);

  function FakeXHR() {
    this.headers = {};
    this.timeout = 0;
  }
  FakeXHR.prototype.open = function (method, url) {
    this.method = method;
    this.url = url;
  };
  FakeXHR.prototype.setRequestHeader = function (name, value) {
    this.headers[name] = value;
  };
  FakeXHR.prototype.send = function (body) {
    var req = { method: this.method, url: this.url, headers: this.headers, body: body };
    requests.push(req);
    var route = null;
    for (var i = 0; i < routes.length; i++) {
      if (routes[i].match.test(this.url)) { route = routes[i]; break; }
    }
    if (!route) throw new Error('No fake route for ' + this.method + ' ' + this.url);
    var response = route.respond(req);
    if (response.error === 'network') { this.onerror(); return; }
    if (response.error === 'timeout') { this.ontimeout(); return; }
    this.status = response.status;
    this.responseText = response.body || '';
    this.onload();
  };

  var Pebble = {
    addEventListener: function (name, fn) { listeners[name] = fn; },
    sendAppMessage: function (message, onSuccess) {
      sentMessages.push(message);
      if (onSuccess) onSuccess();
    },
    openURL: function (url) { Pebble.openedUrl = url; }
  };

  function FakeClay() {}
  FakeClay.prototype.generateUrl = function () { return 'clay://config'; };

  function fakeRequire(name) {
    if (name === '@rebble/clay') return FakeClay;
    if (name === './config') return require(path.join(SRC_DIR, 'config.js'));
    if (name === './sha256') return require(path.join(SRC_DIR, 'sha256.js'));
    throw new Error('Unexpected require: ' + name);
  }

  var sandbox = {
    require: fakeRequire,
    Pebble: Pebble,
    localStorage: localStorage,
    XMLHttpRequest: FakeXHR,
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    console: console,
    Date: Date,
    Math: Math,
    JSON: JSON,
    encodeURIComponent: encodeURIComponent,
    decodeURIComponent: decodeURIComponent,
    parseInt: parseInt,
    String: String,
    Object: Object
  };
  vm.createContext(sandbox);
  vm.runInContext(INDEX_SOURCE, sandbox, { filename: 'index.js' });

  return {
    app: sandbox,
    storage: localStorage.store,
    sent: sentMessages,
    requests: requests,
    timers: timers,
    emit: function (name, event) { listeners[name](event || {}); },
    /** Run pending timers (including ones they schedule) and return their delays. */
    runTimers: function () {
      var delays = [];
      while (timers.length) {
        var t = timers.shift();
        delays.push(t.ms);
        t.fn();
      }
      return delays;
    },
    errorsSent: function () {
      return sentMessages.filter(function (m) { return m.ERROR_MSG !== undefined; })
        .map(function (m) { return m.ERROR_MSG; });
    }
  };
}

// -- Canned ResMed responses --

/** ResMed's public metadata file for a region, as getApiConfig reads it. */
function metadataOk(region) {
  var config = JSON.parse(apiConfig(region));
  delete config.fetchedAt;
  return { status: 200, body: JSON.stringify({ instanceInfo: config }) };
}

function defaultRoutes() {
  return [
    { match: /\/v2\/metadata\.json\?/, respond: function (req) {
      return metadataOk(/resmed\.eu/.test(req.url) ? 'EU' : 'NA');
    } },
    { match: /\/V1\/Patient\/RegisterApplication$/, respond: function () {
      return { status: 200, body: '{}' };
    } }
  ];
}

function sleepRecord(startDate, overrides) {
  return Object.assign({
    startDate: startDate, totalUsage: 425, sleepScore: 88,
    ahi: 3.24, maskPairCount: 1, leakPercentile: 7.6
  }, overrides || {});
}

function graphqlOk(items) {
  return { status: 200, body: JSON.stringify({
    data: { getPatientWrapper: { sleepRecords: { items: items } } }
  }) };
}

/** Routes for a full, successful Okta login. */
function oktaLoginRoutes() {
  return [
    { match: /\/api\/v1\/authn$/, respond: function () {
      return { status: 200, body: JSON.stringify({ status: 'SUCCESS', sessionToken: 'sess' }) };
    } },
    { match: /\/v1\/authorize\?/, respond: function () {
      return { status: 200, body: "<script>data.code = 'authcode';</script>" };
    } },
    { match: /\/v1\/token$/, respond: function () {
      return { status: 200, body: JSON.stringify({
        access_token: 'fresh-token', id_token: 'a.b.c', expires_in: 3600
      }) };
    } }
  ];
}

var DEVICE_ID = '11111111-2222-4333-8444-555555555555';

/** What getApiConfig stores after reading a region's metadata file. */
function apiConfig(region) {
  return JSON.stringify({
    appSyncUrl: 'https://appsync.' + region + '.example/graphql',
    appSyncApiKey: 'appsync-key-' + region,
    restUrl: 'https://rest.' + region + '.example',
    restApiKey: 'rest-key-' + region,
    fetchedAt: Date.now()
  });
}

/**
 * Logged-in storage. API metadata is cached and the device is already
 * registered in both regions, so most tests see only login and GraphQL calls.
 */
var CREDENTIALS = {
  resmed_email: 'alex@example.com',
  resmed_password: 'hunter2',
  resmed_region: 'NA',
  resmed_device_id: DEVICE_ID,
  resmed_api_config_NA: apiConfig('NA'),
  resmed_api_config_EU: apiConfig('EU'),
  resmed_registered_NA: 'alex@example.com|' + DEVICE_ID,
  resmed_registered_EU: 'alex@example.com|' + DEVICE_ID
};

/** Credentials plus a cached token valid for another hour. */
function withCachedToken(extra) {
  return Object.assign({}, CREDENTIALS, {
    resmed_access_token: 'cached-token',
    resmed_id_token: 'a.b.c',
    resmed_token_expiry: String(Date.now() + 3600 * 1000)
  }, extra || {});
}

module.exports = {
  loadApp: loadApp,
  sleepRecord: sleepRecord,
  graphqlOk: graphqlOk,
  oktaLoginRoutes: oktaLoginRoutes,
  CREDENTIALS: CREDENTIALS,
  DEVICE_ID: DEVICE_ID,
  apiConfig: apiConfig,
  metadataOk: metadataOk,
  withCachedToken: withCachedToken
};
