/**
 * ResMed Stats plugin: serves the CPAP nights the app last fetched, so any
 * watchface or app (and the Index assistant) can show them.
 *
 * The app's PKJS (src/pkjs/index.js) signs in to myAir and fetches; it saves
 * the nights under 'plugin_nights' in localStorage, which this plugin shares.
 * The plugin never sees credentials and makes no network requests.
 *
 * Source health/cpap: one instance per night, newest first, so instances[0]
 * is last night. See https://developer.repebble.com/guides/plugins/preview/
 */

var STORAGE_KEY_PLUGIN_NIGHTS = 'plugin_nights';
var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var REFRESH_MS = 60 * 60 * 1000;

function savedNights() {
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY_PLUGIN_NIGHTS) || 'null');
    return saved && Array.isArray(saved.nights) ? saved.nights : [];
  } catch (e) {
    return [];
  }
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function dateLabel(isoDate) {
  var parts = String(isoDate || '').split('-');
  var month = parseInt(parts[1], 10) - 1;
  var day = parseInt(parts[2], 10);
  if (!(month >= 0 && month < 12) || !(day > 0)) return String(isoDate || '');
  return MONTH_NAMES[month] + ' ' + day;
}

/** "7h 32m" from minutes */
function usageText(minutes) {
  var m = Math.max(0, Math.round(minutes || 0));
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function number(value, unit, min, max) {
  var shape = { value: value };
  if (unit) shape.unit = unit;
  if (min !== undefined) shape.min = min;
  if (max !== undefined) shape.max = max;
  return shape;
}

function nightInstance(night) {
  var label = dateLabel(night.date);
  var score = Math.round(night.sleepScore || 0);
  var ahi = round1(night.ahi || 0);
  var usage = Math.round(night.usage || 0);
  var maskOff = Math.round(night.maskOff || 0);
  var leak = Math.round(night.leak || 0);
  var properties = {
    name: { shortText: { text: label }, longText: { text: 'Night of ' + label } },
    sleep_score: { numericValue: number(score, null, 0, 100), shortText: { text: String(score) },
                   longText: { text: 'Sleep score ' + score } },
    ahi: { numericValue: number(ahi, 'events/h', 0), shortText: { text: ahi.toFixed(1) },
           longText: { text: ahi.toFixed(1) + ' events an hour' } },
    usage: { numericValue: number(usage, 'min', 0), shortText: { text: usageText(usage) },
             longText: { text: usageText(usage) + ' of use' } },
    mask_off: { numericValue: number(maskOff, null, 0), shortText: { text: String(maskOff) },
                longText: { text: maskOff + (maskOff === 1 ? ' mask off' : ' masks off') } },
    leak: { numericValue: number(leak, '%', 0, 100), shortText: { text: leak + '%' },
            longText: { text: leak + '% leak' } }
  };
  var seconds = Math.floor(Date.parse(night.date + 'T00:00:00Z') / 1000);
  if (isFinite(seconds)) properties.night = { timestamp: { value: seconds } };
  return { instanceId: String(night.date), properties: properties };
}

function instances(limit) {
  var max = limit > 0 ? limit : 200;
  return savedNights().filter(function (night) {
    return night && night.date;
  }).slice(0, max).map(nightInstance);
}

Pebble.registerSourceHandler(function (request, respond) {
  if (!request || request.category !== 'health' || request.item !== 'cpap') {
    respond.error('INVALID_REQUEST', 'ResMed Stats serves health/cpap only.');
    return;
  }
  var list = instances(request.limit);
  if (!list.length) {
    // Apps show this instead of an empty reading
    respond.error('PLUGIN_UNAVAILABLE', 'Open ResMed Stats on your watch to sign in and sync.');
    return;
  }
  respond.data({
    validUntilMs: Date.now() + REFRESH_MS,
    instances: list
  });
});

// For unit tests in node
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nightInstance: nightInstance, instances: instances, usageText: usageText,
                     dateLabel: dateLabel };
}
