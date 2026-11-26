/**
 * Tests for the plugin (src/plugin/index.js) and the PKJS side that feeds it.
 * Run with `npm test`.
 */

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var h = require('./harness');
var pkg = require('../../package.json');

var PLUGIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'plugin', 'index.js'), 'utf8');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Load the plugin with a fake Pebble and the given localStorage contents. */
function loadPlugin(storage) {
  var store = Object.assign({}, storage || {});
  var handler = null;
  var sandbox = {
    Pebble: { registerSourceHandler: function (fn) { handler = fn; } },
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }
    },
    console: console
  };
  vm.createContext(sandbox);
  vm.runInContext(PLUGIN_SOURCE, sandbox, { filename: 'plugin.js' });
  return {
    request: function (request) {
      var out = {};
      handler(request, {
        data: function (d) { out.data = plain(d); },
        error: function (code, message) { out.error = code; out.message = message; }
      });
      return out;
    }
  };
}

function nights(list) {
  return { plugin_nights: JSON.stringify({ fetchedAt: 1, nights: list }) };
}

var NIGHT = { date: '2026-10-24', sleepScore: 92, ahi: 3.24, usage: 452, maskOff: 1, leak: 7.6 };

test('the plugin serves each night with every shape the manifest declares', function () {
  var out = loadPlugin(nights([NIGHT])).request({ category: 'health', item: 'cpap' });
  assert.equal(out.error, undefined);
  var night = out.data.instances[0];
  assert.equal(night.instanceId, '2026-10-24');
  assert.deepEqual(night.properties.sleep_score.numericValue, { value: 92, min: 0, max: 100 });
  assert.equal(night.properties.sleep_score.shortText.text, '92');
  assert.deepEqual(night.properties.ahi.numericValue, { value: 3.2, unit: 'events/h', min: 0 });
  assert.equal(night.properties.ahi.shortText.text, '3.2');
  assert.equal(night.properties.usage.shortText.text, '7h 32m');
  assert.equal(night.properties.usage.numericValue.value, 452);
  assert.equal(night.properties.mask_off.longText.text, '1 mask off');
  assert.equal(night.properties.leak.shortText.text, '8%');
  assert.equal(night.properties.name.shortText.text, 'Oct 24');
  assert.equal(night.properties.night.timestamp.value, Date.UTC(2026, 9, 24) / 1000);

  // Shapes must match package.json, or the Pebble app drops them
  var declared = pkg.pebble.plugin.sources[0].properties;
  Object.keys(night.properties).forEach(function (name) {
    assert.ok(declared[name], name + ' not declared');
    Object.keys(night.properties[name]).forEach(function (shape) {
      assert.ok(declared[name].indexOf(shape) !== -1, name + '.' + shape + ' not declared');
    });
  });
});

test('the plugin keeps the newest-first order and honours limit', function () {
  var list = [NIGHT, Object.assign({}, NIGHT, { date: '2026-10-23' }),
    Object.assign({}, NIGHT, { date: '2026-10-22' })];
  var plugin = loadPlugin(nights(list));
  assert.deepEqual(plugin.request({ category: 'health', item: 'cpap' }).data.instances
    .map(function (i) { return i.instanceId; }), ['2026-10-24', '2026-10-23', '2026-10-22']);
  assert.equal(plugin.request({ category: 'health', item: 'cpap', limit: 1 }).data.instances.length, 1);
});

test('the plugin serves no nights before the first sync or after bad data', function () {
  assert.deepEqual(loadPlugin({}).request({ category: 'health', item: 'cpap' }).data.instances, []);
  assert.deepEqual(loadPlugin({ plugin_nights: '{not json' })
    .request({ category: 'health', item: 'cpap' }).data.instances, []);
});

test('the plugin refuses sources it does not serve', function () {
  assert.equal(loadPlugin({}).request({ category: 'weather', item: 'location' }).error, 'INVALID_REQUEST');
});

test('a successful sync saves the nights for the plugin and refreshes it', function () {
  var env = h.loadApp();
  var refreshed = [];
  env.app.Pebble.refreshSources = function (list) { refreshed.push(list); };
  env.app.sendRecordsToWatch([
    h.sleepRecord('2026-10-23', { sleepScore: 80 }),
    h.sleepRecord('2026-10-24', { sleepScore: 92, ahi: 3.24, totalUsage: 452,
      maskPairCount: 1, leakPercentile: 7.6 })
  ]);
  var saved = JSON.parse(env.storage.plugin_nights);
  assert.deepEqual(saved.nights.map(function (n) { return n.date; }), ['2026-10-24', '2026-10-23']);
  assert.deepEqual(saved.nights[0], NIGHT);
  assert.deepEqual(plain(refreshed), [['health/cpap']]);
});

test('older Pebble apps without refreshSources still save the nights', function () {
  var env = h.loadApp();
  env.app.sendRecordsToWatch([h.sleepRecord('2026-10-24')]);
  assert.ok(env.storage.plugin_nights);
});

test('disconnecting removes the nights from the plugin', function () {
  var env = h.loadApp({ storage: h.withCachedToken(Object.assign({ resmed_connected: 'true' },
    nights([NIGHT]))) });
  env.emit('webviewclosed', { response: encodeURIComponent(JSON.stringify({ Logout: true })) });
  assert.equal(env.storage.plugin_nights, undefined);
});

test('a reinstall removes the previous account\'s nights', function () {
  var env = h.loadApp({ storage: h.withCachedToken(Object.assign({ resmed_connected: 'true' },
    nights([NIGHT]))) });
  env.emit('appmessage', { payload: { FRESH_INSTALL: 1 } });
  assert.equal(env.storage.plugin_nights, undefined);
});

// ---------------------------------------------------------------------------
// Permissions (manifest version 2)
// ---------------------------------------------------------------------------

function covered(host, domains) {
  return domains.some(function (d) { return host === d || host.slice(-(d.length + 1)) === '.' + d; });
}

test('every myAir host is a declared Internet domain', function () {
  var internet = pkg.pebble.usesPermissions.filter(function (p) { return p.name === 'Internet'; })[0];
  var domains = internet.parameters.domains;
  var env = h.loadApp();
  var hosts = [];
  Object.keys(env.app.REGION_CONFIG).forEach(function (region) {
    var c = env.app.REGION_CONFIG[region];
    ['okta_url', 'metadata_url', 'redirect_url'].forEach(function (k) {
      hosts.push(new URL(c[k]).hostname);
    });
  });
  // From ResMed's metadata files (instanceInfo appSyncUrl / restUrl), checked 2026-11-26
  hosts.push('graphql.prd.hyperdrive.myair.resmed.com', 'rest.prd.hyperdrive.myair.resmed.com',
    'graphql.hyperdrive.resmed.eu', 'rest.hyperdrive.resmed.eu');
  hosts.forEach(function (host) { assert.ok(covered(host, domains), host + ' not declared'); });
  assert.ok(internet.reason && typeof internet.required === 'boolean');
});

test('the plugin guards its source with its own read permission', function () {
  var plugin = pkg.pebble.plugin;
  assert.deepEqual(plugin.definesPermissions.map(function (p) { return p.name; }), ['ReadSleepStats']);
  assert.deepEqual(plugin.sources[0].callerPermissions, ['ReadSleepStats']);
});
