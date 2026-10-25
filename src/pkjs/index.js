/**
 * ResMed CPAP Stats — PebbleKit JS Phone Companion
 *
 * Runs on the paired phone and handles:
 *   1. Clay settings page for myAir credential entry
 *   2. Okta OAuth2 + PKCE authentication with ResMed
 *   3. GraphQL queries to fetch CPAP sleep records
 *   4. Sending data to the watch via AppMessage
 *
 * Security notes:
 *   - Credentials are stored in the phone's localStorage (platform limitation
 *     — PebbleKit JS has no keychain/keystore API). Credentials are NEVER
 *     sent over Bluetooth to the watch.
 *   - Access tokens are cached and reused until they expire to minimize
 *     the number of times credentials are sent to Okta.
 *   - TLS certificate pinning is not available in PebbleKit JS's
 *     XMLHttpRequest — this is an accepted platform limitation.
 *   - No debug logging in production builds.
 *
 * Auth flow based on https://github.com/prestomation/resmed_myair_sensors
 */

var Clay = require('@rebble/clay');
var clayConfig = require('./config');
var sha256 = require('./sha256');

// Initialize Clay without a custom function (custom functions crash the
// config page on some Pebble phone app versions). Login validation happens
// in the webviewclosed handler instead.
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of days of sleep data to fetch and send. */
var MAX_DAYS = 7;

/** Number of milliseconds in one day (for date range calculations). */
var MS_PER_DAY = 24 * 60 * 60 * 1000;

/** XHR request timeout in milliseconds. */
var XHR_TIMEOUT_MS = 15000;

/** Delay before retrying a failed AppMessage send (milliseconds). */
var APPMESSAGE_RETRY_DELAY_MS = 200;

/** Maximum length of error messages sent to the watch. */
var ERROR_MSG_MAX_LENGTH = 60;

/** Short month names for formatting dates on the watch display. */
var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** localStorage keys for persisted data. */
var STORAGE_KEY_EMAIL = 'resmed_email';
var STORAGE_KEY_PASSWORD = 'resmed_password';
var STORAGE_KEY_REGION = 'resmed_region';
var STORAGE_KEY_ACCESS_TOKEN = 'resmed_access_token';
var STORAGE_KEY_TOKEN_EXPIRY = 'resmed_token_expiry';
var STORAGE_KEY_ID_TOKEN = 'resmed_id_token';
var STORAGE_KEY_DEVICE_ID = 'resmed_device_id';
var STORAGE_KEY_CONNECTED = 'resmed_connected';  // 'true' only after a successful data fetch
var STORAGE_KEY_MFA = 'resmed_mfa_pending';       // JSON: email-code login waiting for a code
var STORAGE_KEY_REFRESH_TOKEN = 'resmed_refresh_token';

/** Error that sends the watch to its "set up on your phone" screen. */
var MSG_LOGIN_AGAIN = 'Open Settings to log in';

/** Error for an account whose login works but has no CPAP machine linked. */
var MSG_NO_DEVICE = 'No CPAP machine linked to this myAir account';

/** Errors for an email-code (MFA) login. None may contain "Settings" or
 *  "log in": the watch treats those as "not configured" and wipes its cache. */
var MSG_CODE_SENT = 'Code emailed. Enter it in the phone app';
var MSG_CODE_NEEDED = 'Code needed. Open the phone app';
var MSG_CODE_WRONG = 'Wrong code. Try again in the phone app';
var MSG_CODE_EXPIRED = 'Code expired. Open the phone app';

/** Fallback lifetime of an Okta MFA transaction if it doesn't say. */
var MFA_DEFAULT_LIFETIME_MS = 5 * 60 * 1000;

/** Default region if none is configured. */
var DEFAULT_REGION = 'NA';

/**
 * Maximum credential length — reject inputs longer than this
 * to prevent memory issues and potential injection. (Finding #11)
 */
var MAX_CREDENTIAL_LENGTH = 256;

// ---------------------------------------------------------------------------
// Region Configuration
// ---------------------------------------------------------------------------
// Reverse-engineered from the myAir web app. Each region uses a separate
// Okta tenant and AWS AppSync GraphQL endpoint.
// Source: https://github.com/prestomation/resmed_myair_sensors

var REGION_CONFIG = {
  'NA': {
    okta_url: 'https://resmed-ext-1.okta.com',
    auth_server_id: 'aus4ccsxvnidQgLmA297',
    client_id: '0oa4ccq1v413ypROi297',
    api_key: 'da2-cenztfjrezhwphdqtwtbpqvzui',
    graphql_url: 'https://graphql.myair-prd.dht.live/graphql',
    redirect_url: 'https://myair.resmed.com',
    product: 'myAir'
  },
  'EU': {
    okta_url: 'https://id.resmed.eu',
    auth_server_id: 'aus2uznux2sYKTsEg417',
    client_id: '0oa2uz04d2Pks2NgR417',
    api_key: 'da2-o66oo6xdnfh5hlfuw5yw5g2dtm',
    graphql_url: 'https://graphql.hyperdrive.resmed.eu/graphql',
    redirect_url: 'https://myair.resmed.eu',
    product: 'myAir EU',
    // EU logins need an emailed code each time, so keep a refresh token
    // to get new access tokens without logging in again
    use_refresh_token: true
  }
};

// ---------------------------------------------------------------------------
// Entropy & PKCE — Improved PRNG for security-sensitive values
// ---------------------------------------------------------------------------
// PebbleKit JS lacks crypto.getRandomValues(). We improve on raw
// Math.random() by mixing multiple entropy sources through SHA-256.
// This isn't a true CSPRNG but is significantly harder to predict
// than raw Math.random() output. (Finding #2)

/** Counter incremented each time entropy is consumed. */
var entropyCounter = 0;

/** Previous hash output, fed back as additional entropy. */
var lastEntropyHash = '';

/**
 * Generate a random string using SHA-256 mixed entropy.
 * Combines timestamp, counter, Math.random(), and previous hash
 * to produce output that resists PRNG state reconstruction.
 */
function generateSecureRandom(length, charset) {
  var result = '';
  while (result.length < length) {
    // Mix multiple entropy sources through SHA-256
    var seed = Date.now() + ':' + (entropyCounter++) + ':' +
               Math.random() + ':' + lastEntropyHash + ':' +
               result.length;
    var hashBytes = sha256(seed);
    lastEntropyHash = bytesToHex(hashBytes);

    // Use hash bytes to select characters from charset
    for (var i = 0; i < hashBytes.length && result.length < length; i++) {
      result += charset.charAt(hashBytes[i] % charset.length);
    }
  }
  return result;
}

/** Convert a byte array to hex string (for entropy feedback). */
function bytesToHex(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    hex += ('0' + bytes[i].toString(16)).slice(-2);
  }
  return hex;
}

/** Characters allowed in a PKCE code verifier (RFC 7636). */
var PKCE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** Length of the generated PKCE code verifier. */
var PKCE_VERIFIER_LENGTH = 128;

/** Characters used for generating random OAuth state parameters. */
var STATE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Length of the generated OAuth state parameter. */
var STATE_LENGTH = 32;

/** Base64 encoding character set. */
var BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Generate a PKCE code verifier using mixed-entropy PRNG. */
function generateCodeVerifier() {
  return generateSecureRandom(PKCE_VERIFIER_LENGTH, PKCE_CHARSET);
}

/** Generate an OAuth state parameter using mixed-entropy PRNG. */
function generateOAuthState() {
  return generateSecureRandom(STATE_LENGTH, STATE_CHARSET);
}

/**
 * Encode a byte array as a base64url string (no padding).
 * Used to encode the SHA-256 hash of the code verifier.
 */
function bytesToBase64url(bytes) {
  var result = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var byte1 = bytes[i];
    var byte2 = (i + 1 < bytes.length) ? bytes[i + 1] : 0;
    var byte3 = (i + 2 < bytes.length) ? bytes[i + 2] : 0;

    result += BASE64_CHARS.charAt(byte1 >> 2);
    result += BASE64_CHARS.charAt(((byte1 & 3) << 4) | (byte2 >> 4));
    if (i + 1 < bytes.length) {
      result += BASE64_CHARS.charAt(((byte2 & 15) << 2) | (byte3 >> 6));
    }
    if (i + 2 < bytes.length) {
      result += BASE64_CHARS.charAt(byte3 & 63);
    }
  }
  return result.replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Generate a PKCE code challenge from a code verifier.
 * code_challenge = base64url(SHA-256(code_verifier))
 */
function generateCodeChallenge(codeVerifier) {
  var hashBytes = sha256(codeVerifier);
  return bytesToBase64url(hashBytes);
}

// ---------------------------------------------------------------------------
// Per-Installation Device ID (Finding #9)
// ---------------------------------------------------------------------------
// Generate a unique device UUID per installation to avoid correlating
// all users under a single hardcoded rmdhandsetid.

function getOrCreateDeviceId() {
  var deviceId = localStorage.getItem(STORAGE_KEY_DEVICE_ID);
  if (!deviceId) {
    // Generate a UUID v4 format using our improved PRNG
    var hex = bytesToHex(sha256(Date.now() + ':' + Math.random() + ':' + entropyCounter++));
    deviceId = hex.substring(0, 8) + '-' + hex.substring(8, 12) + '-4' +
               hex.substring(13, 16) + '-' + hex.substring(16, 20) + '-' +
               hex.substring(20, 32);
    localStorage.setItem(STORAGE_KEY_DEVICE_ID, deviceId);
  }
  return deviceId;
}

// ---------------------------------------------------------------------------
// JWT Decoding — Extract claims from Okta id_token
// ---------------------------------------------------------------------------

/**
 * Decode a base64url-encoded string to a regular string.
 * Used to decode the JWT payload segment.
 */
function decodeBase64url(encoded) {
  var paddingNeeded = 4 - (encoded.length % 4);
  if (paddingNeeded !== 4) {
    for (var i = 0; i < paddingNeeded; i++) encoded += '=';
  }
  encoded = encoded.replace(/-/g, '+').replace(/_/g, '/');

  var bytes = [];
  for (var i = 0; i < encoded.length; i += 4) {
    var b1 = BASE64_CHARS.indexOf(encoded.charAt(i));
    var b2 = BASE64_CHARS.indexOf(encoded.charAt(i + 1));
    var b3 = BASE64_CHARS.indexOf(encoded.charAt(i + 2));
    var b4 = BASE64_CHARS.indexOf(encoded.charAt(i + 3));

    bytes.push((b1 << 2) | (b2 >> 4));
    if (b3 !== -1 && encoded.charAt(i + 2) !== '=') {
      bytes.push(((b2 & 15) << 4) | (b3 >> 2));
    }
    if (b4 !== -1 && encoded.charAt(i + 3) !== '=') {
      bytes.push(((b3 & 3) << 6) | b4);
    }
  }

  var decoded = '';
  for (var i = 0; i < bytes.length; i++) {
    decoded += String.fromCharCode(bytes[i]);
  }
  return decoded;
}

/**
 * Extract the myAirCountryId claim from the JWT id_token.
 * The country code is required for the GraphQL API's rmdcountry header.
 * Falls back to 'US' if the claim is missing or the token can't be decoded.
 *
 * Note: JWT signature is not verified (Finding #5 accepted risk —
 * PebbleKit JS lacks the crypto primitives for JWKS verification).
 * The issuer is logged for debugging but not used as a gate.
 */
function extractCountryFromIdToken(idToken) {
  try {
    var jwtSegments = idToken.split('.');
    if (jwtSegments.length !== 3) return 'US';

    var payloadJson = decodeBase64url(jwtSegments[1]);
    var payload = JSON.parse(payloadJson);

    // Log issuer for debugging (Finding #5)
    if (payload.iss) {
    }

    return payload.myAirCountryId || 'US';
  } catch (e) {
    return 'US';
  }
}

// ---------------------------------------------------------------------------
// HTML Escaping (Finding #8)
// ---------------------------------------------------------------------------
// Industry-standard approach: escape all characters that have special
// meaning in HTML to prevent XSS when inserting user data into HTML strings.
// Covers the OWASP recommended set for HTML body context.

/**
 * Escape a string for safe insertion into HTML.
 * Replaces &, <, >, ", and ' with their HTML entity equivalents.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Input Validation (Finding #11)
// ---------------------------------------------------------------------------

/** Basic email format validation. */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (email.length > MAX_CREDENTIAL_LENGTH) return false;
  // Check for null bytes or control characters
  if (/[\x00-\x1f]/.test(email)) return false;
  // Basic email format: something@something.something
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Basic password validation — just length and character safety. */
function isValidPassword(password) {
  if (!password || typeof password !== 'string') return false;
  if (password.length > MAX_CREDENTIAL_LENGTH) return false;
  if (password.length < 1) return false;
  // Check for null bytes
  if (/\x00/.test(password)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// XHR Helper
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request using XMLHttpRequest.
 * Note: TLS certificate pinning is not available in PebbleKit JS's
 * XMLHttpRequest implementation — this is an accepted platform limitation.
 * (Finding #7)
 */
function makeHttpRequest(url, method, body, headers, callback) {
  var xhr = new XMLHttpRequest();
  xhr.onload = function () {
    callback(null, xhr.status, xhr.responseText);
  };
  xhr.onerror = function () {
    callback('Network error', 0, '');
  };
  xhr.ontimeout = function () {
    callback('Request timeout', 0, '');
  };
  xhr.open(method, url);
  xhr.timeout = XHR_TIMEOUT_MS;

  if (headers) {
    for (var headerName in headers) {
      if (headers.hasOwnProperty(headerName)) {
        xhr.setRequestHeader(headerName, headers[headerName]);
      }
    }
  }

  xhr.send(body || null);
}

// ---------------------------------------------------------------------------
// Watch Communication
// ---------------------------------------------------------------------------

/** Send an error message to the watch for display. */
function sendErrorToWatch(errorMessage) {
  Pebble.sendAppMessage(
    { 'ERROR_MSG': errorMessage.substring(0, ERROR_MSG_MAX_LENGTH) },
    function () {},
    function () {}
  );
}

// -- Sequential AppMessage Queue --
var pendingMessages = [];
var isMessageInFlight = false;

function enqueueWatchMessage(message) {
  pendingMessages.push(message);
  processMessageQueue();
}

function processMessageQueue() {
  if (isMessageInFlight || pendingMessages.length === 0) return;

  isMessageInFlight = true;
  var message = pendingMessages.shift();

  Pebble.sendAppMessage(message,
    function () {
      isMessageInFlight = false;
      processMessageQueue();
    },
    function () {
      // Retry after a short delay
      pendingMessages.unshift(message);
      isMessageInFlight = false;
      setTimeout(processMessageQueue, APPMESSAGE_RETRY_DELAY_MS);
    }
  );
}

// ---------------------------------------------------------------------------
// Token Cache (Findings #1 and #14)
// ---------------------------------------------------------------------------
// Cache the access token and reuse it until it expires, reducing the number
// of times credentials are sent to Okta. Also serves as partial mitigation
// for the plaintext password storage issue — credentials are only sent
// when the token expires, not on every data refresh.

/**
 * Get a cached access token if it hasn't expired.
 * Returns { accessToken, idToken } or null if expired/missing.
 */
function getCachedToken() {
  var token = localStorage.getItem(STORAGE_KEY_ACCESS_TOKEN);
  var expiry = localStorage.getItem(STORAGE_KEY_TOKEN_EXPIRY);
  var idToken = localStorage.getItem(STORAGE_KEY_ID_TOKEN);

  if (token && expiry && idToken) {
    var expiryTime = parseInt(expiry, 10);
    // Check with 5-minute buffer before actual expiry
    if (Date.now() < expiryTime - 300000) {
      return { accessToken: token, idToken: idToken };
    }
  }
  return null;
}

/** Cache an access token with its expiry time. */
function cacheToken(accessToken, idToken, expiresInSeconds) {
  localStorage.setItem(STORAGE_KEY_ACCESS_TOKEN, accessToken);
  localStorage.setItem(STORAGE_KEY_ID_TOKEN, idToken);
  localStorage.setItem(STORAGE_KEY_TOKEN_EXPIRY,
    '' + (Date.now() + expiresInSeconds * 1000));
}

/** Clear the cached token (on logout or auth failure). */
function clearRefreshToken() {
  localStorage.removeItem(STORAGE_KEY_REFRESH_TOKEN);
}

function clearCachedToken() {
  localStorage.removeItem(STORAGE_KEY_ACCESS_TOKEN);
  localStorage.removeItem(STORAGE_KEY_TOKEN_EXPIRY);
  localStorage.removeItem(STORAGE_KEY_ID_TOKEN);
}

// ---------------------------------------------------------------------------
// Okta Authentication — OAuth2 Authorization Code + PKCE
// ---------------------------------------------------------------------------

/**
 * Authenticate with ResMed's Okta SSO and obtain access + id tokens.
 *
 * Uses cached tokens when available to minimize credential exposure.
 * When re-authentication is needed, performs the 3-step OAuth2 flow:
 *   1. POST credentials to Okta /authn → sessionToken
 *   2. GET /authorize with PKCE + sessionToken → authorization code
 *   3. POST /token with code + code_verifier → access_token + id_token
 */
function authenticateWithOkta(email, password, region, interactive, callback) {
  var regionConfig = REGION_CONFIG[region];
  if (!regionConfig) {
    callback('Invalid region');
    return;
  }

  // Try cached token first (Finding #14)
  var cached = getCachedToken();
  if (cached) {
    callback(null, cached.accessToken, cached.idToken, regionConfig);
    return;
  }

  var refreshToken = regionConfig.use_refresh_token &&
    localStorage.getItem(STORAGE_KEY_REFRESH_TOKEN);
  if (refreshToken) {
    refreshAccessToken(refreshToken, regionConfig, function (refreshError, accessToken, idToken) {
      if (!refreshError) { callback(null, accessToken, idToken, regionConfig); return; }
      if (refreshError !== 'Refresh rejected') { callback(refreshError); return; }
      clearRefreshToken();
      if (!password) {
        // The password was deleted once the refresh token worked; the user
        // has to log in again (with a new emailed code anyway)
        localStorage.removeItem(STORAGE_KEY_CONNECTED);
        callback(MSG_LOGIN_AGAIN);
        return;
      }
      authenticateWithOkta(email, password, region, interactive, callback);
    });
    return;
  }

  // -- Step 1: Primary authentication (get session token) --

  var credentialsPayload = JSON.stringify({ username: email, password: password });

  postOktaAuthn(regionConfig, regionConfig.okta_url + '/api/v1/authn', credentialsPayload,
    { interactive: interactive },
    function (authnError, sessionToken) {
      if (authnError) { callback(authnError); return; }
      exchangeSessionToken(sessionToken, regionConfig, callback);
    }
  );
}

/**
 * POST to an Okta authn endpoint and resolve the response to a session token.
 * A password-expiry warning is skipped once (the password still works).
 * An email-code challenge is saved for the settings page; the code is only
 * emailed for an `interactive` login, so background refreshes never spam
 * the inbox. Any other non-SUCCESS status becomes an error naming it.
 */
function postOktaAuthn(regionConfig, url, payload, options, callback) {
  makeHttpRequest(
    url,
    'POST',
    payload,
    { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    function (networkError, httpStatus, responseBody) {
      if (networkError) { callback('Network error'); return; }
      if (httpStatus === 429) { callback('Rate limited. Try later.'); return; }
      if (httpStatus !== 200) { callback('Login failed (' + httpStatus + ')'); return; }

      var authnResponse;
      try { authnResponse = JSON.parse(responseBody); }
      catch (e) { callback('Bad auth response'); return; }

      var status = authnResponse.status;
      if (status === 'SUCCESS' && authnResponse.sessionToken) {
        callback(null, authnResponse.sessionToken);
        return;
      }

      var skipLink = authnResponse._links && authnResponse._links.skip;
      if (status === 'PASSWORD_WARN' && !options.skipped && skipLink &&
          isOktaUrl(regionConfig, skipLink.href) && authnResponse.stateToken) {
        postOktaAuthn(regionConfig, skipLink.href,
          JSON.stringify({ stateToken: authnResponse.stateToken }),
          { interactive: options.interactive, skipped: true }, callback);
        return;
      }

      var emailFactor = status === 'MFA_REQUIRED' && findEmailFactor(regionConfig, authnResponse);
      if (emailFactor) {
        savePendingMfa({
          stateToken: authnResponse.stateToken,
          verifyUrl: emailFactor._links.verify.href,
          expiresAt: Date.parse(authnResponse.expiresAt) || Date.now() + MFA_DEFAULT_LIFETIME_MS,
          codeSent: false
        });
        if (options.interactive) {
          sendMfaCode(callback);
        } else {
          callback(MSG_CODE_NEEDED);
        }
        return;
      }

      callback(authnStatusMessage(status));
    }
  );
}

/** True if `url` is on this region's Okta host (we only follow Okta's own links). */
function isOktaUrl(regionConfig, url) {
  return typeof url === 'string' && url.indexOf(regionConfig.okta_url + '/') === 0;
}

/** The email factor from an MFA_REQUIRED response, if it has a usable one. */
function findEmailFactor(regionConfig, authnResponse) {
  var factors = authnResponse._embedded && authnResponse._embedded.factors;
  if (!factors || !authnResponse.stateToken) return null;
  for (var i = 0; i < factors.length; i++) {
    var factor = factors[i];
    if (factor.factorType === 'email' && factor._links && factor._links.verify &&
        isOktaUrl(regionConfig, factor._links.verify.href)) {
      return factor;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Email-code (MFA) login
// ---------------------------------------------------------------------------
// EU myAir accounts get an Okta email challenge after the password. The
// challenge (stateToken + verify URL) is kept in localStorage while the user
// switches to their inbox, then the settings page asks for the code.

/** The pending email-code login, or null if there is none or it expired. */
function getPendingMfa() {
  try {
    var pending = JSON.parse(localStorage.getItem(STORAGE_KEY_MFA));
    if (pending && pending.stateToken && pending.verifyUrl && Date.now() < pending.expiresAt) {
      return pending;
    }
  } catch (e) {}
  // Don't keep an expired or unreadable challenge around
  clearPendingMfa();
  return null;
}

function savePendingMfa(pending) {
  localStorage.setItem(STORAGE_KEY_MFA, JSON.stringify(pending));
}

function clearPendingMfa() {
  localStorage.removeItem(STORAGE_KEY_MFA);
}

/** Verify URL with rememberDevice, so Okta can skip the code next time. */
function mfaVerifyUrl(pending) {
  return pending.verifyUrl + (pending.verifyUrl.indexOf('?') === -1 ? '?' : '&') +
    'rememberDevice=true';
}

/** Ask Okta to email a code for the pending challenge. Always ends in an error message. */
function sendMfaCode(callback) {
  var pending = getPendingMfa();
  if (!pending) { callback(MSG_CODE_EXPIRED); return; }

  makeHttpRequest(
    mfaVerifyUrl(pending),
    'POST',
    JSON.stringify({ stateToken: pending.stateToken }),
    { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    function (networkError, httpStatus) {
      if (networkError) { callback('Network error'); return; }
      if (httpStatus === 429) { callback('Rate limited. Try later.'); return; }
      if (httpStatus !== 200) {
        clearPendingMfa();
        callback(MSG_CODE_EXPIRED);
        return;
      }
      pending.codeSent = true;
      savePendingMfa(pending);
      callback(MSG_CODE_SENT);
    }
  );
}

/**
 * Submit the emailed code. On success the resulting tokens are cached, so
 * the normal fetch that follows goes straight to the API.
 */
function verifyMfaCode(code, callback) {
  var pending = getPendingMfa();
  var regionConfig = REGION_CONFIG[localStorage.getItem(STORAGE_KEY_REGION) || DEFAULT_REGION];
  if (!pending || !regionConfig) { clearPendingMfa(); callback(MSG_CODE_EXPIRED); return; }

  makeHttpRequest(
    mfaVerifyUrl(pending),
    'POST',
    JSON.stringify({ stateToken: pending.stateToken, passCode: code }),
    { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    function (networkError, httpStatus, responseBody) {
      if (networkError) { callback('Network error'); return; }
      if (httpStatus === 429) { callback('Rate limited. Try later.'); return; }
      // Okta answers a wrong code with 403 and keeps the challenge open
      if (httpStatus === 403) { callback(MSG_CODE_WRONG); return; }

      var result = null;
      try { result = JSON.parse(responseBody); } catch (e) {}
      if (httpStatus !== 200 || !result || result.status !== 'SUCCESS' || !result.sessionToken) {
        clearPendingMfa();
        callback(MSG_CODE_EXPIRED);
        return;
      }

      clearPendingMfa();
      exchangeSessionToken(result.sessionToken, regionConfig, function (tokenError) {
        callback(tokenError || null);
      });
    }
  );
}

/**
 * Watch-sized error for an Okta authn status we can't complete.
 * Names the status so user reports tell us what Okta asked for.
 * Finding #10: Don't instruct users to disable MFA.
 */
function authnStatusMessage(status) {
  if (status && status.indexOf('MFA_') === 0) {
    return 'MFA login not supported yet (' + status + ')';
  }
  if (status === 'LOCKED_OUT') return 'Account locked. Unlock it on myAir';
  if (status === 'PASSWORD_EXPIRED') return 'Password expired. Change it on myAir';
  return 'Login failed: ' + (status || 'unknown');
}

/**
 * Undo JavaScript string escapes. Okta's okta_post_message page writes the
 * code as a JS string literal with characters like - and _ escaped
 * (e.g. \x2D), so a code containing them must be unescaped before use.
 */
function unescapeJsString(value) {
  return value.replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|(.))/g,
    function (whole, hex2, hex4, literal) {
      if (hex2) return String.fromCharCode(parseInt(hex2, 16));
      if (hex4) return String.fromCharCode(parseInt(hex4, 16));
      return literal;
    });
}

/**
 * Steps 2 and 3 of the login: exchange an Okta session token for an
 * authorization code (PKCE), then for access + id tokens.
 */
function exchangeSessionToken(sessionToken, regionConfig, callback) {
  var oktaBaseUrl = regionConfig.okta_url;
  var authServerId = regionConfig.auth_server_id;

  // -- Step 2: Exchange session token for authorization code via PKCE --

  var codeVerifier = generateCodeVerifier();
  var codeChallenge = generateCodeChallenge(codeVerifier);

  // Generate and store state for CSRF validation (Finding #4)
  var oauthState = generateOAuthState();

  var authorizeUrl = oktaBaseUrl + '/oauth2/' + authServerId + '/v1/authorize?' +
    'client_id=' + encodeURIComponent(regionConfig.client_id) +
    '&response_type=code' +
    '&scope=' + encodeURIComponent('openid profile email' +
      (regionConfig.use_refresh_token ? ' offline_access' : '')) +
    '&redirect_uri=' + encodeURIComponent(regionConfig.redirect_url) +
    '&state=' + encodeURIComponent(oauthState) +
    '&code_challenge_method=S256' +
    '&code_challenge=' + encodeURIComponent(codeChallenge) +
    '&sessionToken=' + encodeURIComponent(sessionToken) +
    '&response_mode=okta_post_message';

  makeHttpRequest(
    authorizeUrl,
    'GET',
    null,
    { 'Accept': 'text/html' },
    function (networkError, httpStatus, responseBody) {
      if (networkError) { callback('Auth code error'); return; }
      if (httpStatus !== 200) { callback('Auth code error (' + httpStatus + ')'); return; }

      // Parse authorization code from HTML response
      var authCodeMatch = responseBody.match(/data\.code\s*=\s*'([^']+)'/);
      if (!authCodeMatch) {
        authCodeMatch = responseBody.match(/code=([^"&\s]+)/);
      }
      if (!authCodeMatch) {
        authCodeMatch = responseBody.match(/"code"\s*:\s*"([^"]+)"/);
      }
      if (!authCodeMatch) {
        // Finding #6: Don't log the response body
        callback('Could not get auth code');
        return;
      }

      var authorizationCode = unescapeJsString(authCodeMatch[1]);

      // Validate OAuth state to prevent CSRF (Finding #4)
      var stateMatch = responseBody.match(/data\.state\s*=\s*'([^']+)'/) ||
                       responseBody.match(/state=([^"&\s]+)/);
      if (stateMatch && unescapeJsString(stateMatch[1]) !== oauthState) {
        callback('Auth security check failed');
        return;
      }


      // -- Step 3: Exchange authorization code for access token --

      var tokenRequestBody =
        'grant_type=authorization_code' +
        '&code=' + encodeURIComponent(authorizationCode) +
        '&redirect_uri=' + encodeURIComponent(regionConfig.redirect_url) +
        '&client_id=' + encodeURIComponent(regionConfig.client_id) +
        '&code_verifier=' + encodeURIComponent(codeVerifier);

      makeHttpRequest(
        oktaBaseUrl + '/oauth2/' + authServerId + '/v1/token',
        'POST',
        tokenRequestBody,
        { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        function (networkError, httpStatus, responseBody) {
          if (networkError) { callback('Token error'); return; }
          if (httpStatus !== 200) {
            // Finding #6: Don't log response body — parse error safely
            var tokenErrMsg = 'Login failed. Try again.';
            try {
              var errData = JSON.parse(responseBody);
              if (errData.error_description) {
                // Truncate and sanitize for watch display
                tokenErrMsg = errData.error_description.substring(0, 55);
              }
            } catch (ignored) {}
            clearCachedToken();
            callback(tokenErrMsg);
            return;
          }

          handleTokenResponse(responseBody, regionConfig, callback);
        }
      );
    }
  );
}

/** Cache the tokens from a successful /token response and pass them on. */
function handleTokenResponse(responseBody, regionConfig, callback) {
  var tokenResponse;
  try { tokenResponse = JSON.parse(responseBody); }
  catch (e) { callback('Bad token response'); return; }

  var accessToken = tokenResponse.access_token;
  var idToken = tokenResponse.id_token || localStorage.getItem(STORAGE_KEY_ID_TOKEN) || '';
  var expiresIn = tokenResponse.expires_in || 3600;
  if (!accessToken) { callback('Bad token response'); return; }

  // Cache the token to avoid re-authenticating on every request
  cacheToken(accessToken, idToken, expiresIn);
  if (regionConfig.use_refresh_token && tokenResponse.refresh_token) {
    localStorage.setItem(STORAGE_KEY_REFRESH_TOKEN, tokenResponse.refresh_token);
    // The refresh token replaces the password from here on: a password
    // login would need a new emailed code anyway, so don't keep it
    localStorage.removeItem(STORAGE_KEY_PASSWORD);
  }

  callback(null, accessToken, idToken, regionConfig);
}

/**
 * Get a new access token from a stored refresh token, skipping the
 * password + emailed code. Fails with 'Refresh rejected' when Okta no
 * longer accepts the refresh token, so the caller logs in again.
 */
function refreshAccessToken(refreshToken, regionConfig, callback) {
  var tokenRequestBody =
    'grant_type=refresh_token' +
    '&refresh_token=' + encodeURIComponent(refreshToken) +
    '&client_id=' + encodeURIComponent(regionConfig.client_id) +
    '&scope=' + encodeURIComponent('openid profile email offline_access');

  makeHttpRequest(
    regionConfig.okta_url + '/oauth2/' + regionConfig.auth_server_id + '/v1/token',
    'POST',
    tokenRequestBody,
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    function (networkError, httpStatus, responseBody) {
      if (networkError) { callback('Token error'); return; }
      if (httpStatus === 400 || httpStatus === 401) { callback('Refresh rejected'); return; }
      if (httpStatus !== 200) { callback('Token error (' + httpStatus + ')'); return; }
      handleTokenResponse(responseBody, regionConfig, callback);
    }
  );
}

// ---------------------------------------------------------------------------
// GraphQL — Fetch sleep records from the myAir AppSync API
// ---------------------------------------------------------------------------

function formatIsoDate(date) {
  var year = date.getFullYear();
  var month = ('0' + (date.getMonth() + 1)).slice(-2);
  var day = ('0' + date.getDate()).slice(-2);
  return year + '-' + month + '-' + day;
}

function fetchSleepRecords(accessToken, idToken, regionConfig, callback) {
  var countryCode = extractCountryFromIdToken(idToken);
  var deviceId = getOrCreateDeviceId();

  var today = new Date();
  var rangeStart = new Date(today.getTime() - MAX_DAYS * MS_PER_DAY);
  var startDate = formatIsoDate(rangeStart);
  var endDate = formatIsoDate(today);

  // Query must include patient { firstName } — the API returns
  // myAir:result errors without it (matches the official web app query)
  var graphqlQuery =
    'query GetPatientSleepRecords { getPatientWrapper { ' +
    'patient { firstName __typename } ' +
    'sleepRecords(startMonth: "' + startDate + '", endMonth: "' + endDate + '") { ' +
    'items { startDate totalUsage sleepScore ahi maskPairCount leakPercentile __typename } ' +
    '__typename } __typename } }';

  var requestHeaders = {
    'Authorization': 'Bearer ' + accessToken,
    'x-api-key': regionConfig.api_key,
    'Content-Type': 'application/json',
    // TODO: Finding #9 — per-install UUID caused myAir:result errors,
    // needs further investigation. Using hardcoded ID for now.
    'rmdhandsetid': '02c1c662-c289-41fd-a9ae-196ff15b5166',
    'rmdlanguage': 'en',
    'rmdhandsetmodel': 'Chrome',
    'rmdhandsetosversion': '131.0.0.0',
    'rmdproduct': regionConfig.product,
    'rmdappversion': '1.0.0',
    'rmdhandsetplatform': 'Web',
    'rmdcountry': countryCode,
    'accept-language': 'en-US,en;q=0.9'
  };

  var requestBody = JSON.stringify({ query: graphqlQuery });


  makeHttpRequest(
    regionConfig.graphql_url,
    'POST',
    requestBody,
    requestHeaders,
    function (networkError, httpStatus, responseBody) {
      if (networkError) { callback('Network error'); return; }

      // If we get a 401, the cached token is stale — clear it so next
      // attempt re-authenticates with credentials
      if (httpStatus === 401) {
        clearCachedToken();
        callback('Session expired. Try again.');
        return;
      }
      if (httpStatus !== 200) { callback('API error (' + httpStatus + ')'); return; }

      var apiResponse;
      try { apiResponse = JSON.parse(responseBody); }
      catch (e) { callback('Bad API response'); return; }

      if (apiResponse.errors) {
        if (JSON.stringify(apiResponse.errors).indexOf('equipmentNotAssigned') !== -1) {
          callback(MSG_NO_DEVICE);
          return;
        }
        var errType = apiResponse.errors[0] ? apiResponse.errors[0].errorType || apiResponse.errors[0].message || 'unknown' : 'unknown';
        callback('API error: ' + errType.substring(0, 40));
        return;
      }

      try {
        var sleepRecordItems = apiResponse.data.getPatientWrapper.sleepRecords.items;
        if (!sleepRecordItems || sleepRecordItems.length === 0) {
          callback('No CPAP data found');
          return;
        }
        callback(null, sleepRecordItems);
      } catch (e) {
        callback('Unexpected API response');
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Data Formatting & Transmission
// ---------------------------------------------------------------------------

function formatDateForWatch(isoDateString) {
  try {
    var datePart = isoDateString.split('T')[0];
    var dateSegments = datePart.split('-');
    var monthIndex = parseInt(dateSegments[1], 10) - 1;
    var dayOfMonth = parseInt(dateSegments[2], 10);
    return MONTH_NAMES[monthIndex] + ' ' + dayOfMonth;
  } catch (e) {
    return isoDateString.substring(5, 10);
  }
}

function sendRecordsToWatch(sleepRecordItems) {
  sleepRecordItems.sort(function (a, b) {
    return (b.startDate || '').localeCompare(a.startDate || '');
  });

  var recordsToSend = sleepRecordItems.slice(0, MAX_DAYS);
  var totalDays = recordsToSend.length;


  enqueueWatchMessage({ 'TOTAL_DAYS': totalDays });

  for (var dayIndex = 0; dayIndex < totalDays; dayIndex++) {
    var record = recordsToSend[dayIndex];
    var ahiTimesTen = Math.round((record.ahi || 0) * 10);

    enqueueWatchMessage({
      'DAY_INDEX': dayIndex,
      'RECORD_DATE': formatDateForWatch(record.startDate || ''),
      'SLEEP_SCORE': record.sleepScore || 0,
      'AHI_X10': ahiTimesTen,
      'USAGE_MINS': record.totalUsage || 0,
      'MASK_COUNT': record.maskPairCount || 0,
      'LEAK_PCT': Math.round(record.leakPercentile || 0)
    });
  }

  enqueueWatchMessage({ 'DATA_COMPLETE': 1 });
}

// ---------------------------------------------------------------------------
// Main Orchestration
// ---------------------------------------------------------------------------

var isDataFetchInProgress = false;

/** When the in-flight fetch started (ms), so a stuck one can't block forever. */
var fetchStartedAt = 0;

/**
 * Bumped whenever a fetch is abandoned (new login, stuck fetch). Attempts
 * from an older generation drop their results instead of reporting them.
 */
var fetchGeneration = 0;

/**
 * Longer than the slowest possible fetch: 3 attempts of 3 timed-out
 * requests each, plus the retry delays.
 */
var FETCH_STALE_MS = 3 * 3 * XHR_TIMEOUT_MS + 10000;

/** Delays before each retry of a failed fetch (milliseconds). */
var FETCH_RETRY_DELAYS_MS = [2000, 5000];

/**
 * Errors that retrying won't fix (bad credentials, account setup, no data).
 * Everything else (network blips, timeouts, 5xx, a token the server
 * rejected) is treated as transient and retried with a fresh login.
 */
function isPermanentFetchError(message) {
  return message === 'Login failed (401)' ||
    message.indexOf('Login failed: ') === 0 ||
    message === 'Invalid region' ||
    message === 'No CPAP data found' ||
    message === MSG_NO_DEVICE ||
    message === MSG_LOGIN_AGAIN ||
    message.indexOf('MFA') === 0 ||
    message.indexOf('Account locked') === 0 ||
    message.indexOf('Password expired') === 0 ||
    message.indexOf('Code ') === 0 ||
    message === MSG_CODE_WRONG ||
    message.indexOf('Rate limited') === 0;
}

/**
 * Start a login + fetch. `restart` abandons any fetch already in flight,
 * which a newly saved login needs: the old fetch is using old credentials.
 * A restart is also the user acting in the settings page, so it may email
 * a login code; background refreshes only say a code is needed.
 */
function fetchAndSendSleepData(restart) {
  if (isDataFetchInProgress && !restart &&
      Date.now() - fetchStartedAt < FETCH_STALE_MS) {
    return;
  }
  fetchGeneration++;
  isDataFetchInProgress = false;

  var email = localStorage.getItem(STORAGE_KEY_EMAIL);
  var password = localStorage.getItem(STORAGE_KEY_PASSWORD);
  var region = localStorage.getItem(STORAGE_KEY_REGION) || DEFAULT_REGION;

  var canRefresh = !!(REGION_CONFIG[region] && REGION_CONFIG[region].use_refresh_token &&
    localStorage.getItem(STORAGE_KEY_REFRESH_TOKEN));
  if (!email || (!password && !canRefresh)) {
    sendErrorToWatch(MSG_LOGIN_AGAIN);
    return;
  }

  // A background refresh must not start a new login while the user is
  // fetching an emailed code: that would invalidate the code
  var pendingMfa = getPendingMfa();
  if (!restart && pendingMfa && !getCachedToken()) {
    sendErrorToWatch(pendingMfa.codeSent ? MSG_CODE_SENT : MSG_CODE_NEEDED);
    return;
  }

  isDataFetchInProgress = true;
  fetchStartedAt = Date.now();
  attemptFetch(email, password, region, 0, fetchGeneration, !!restart);
}

/** One attempt at login + fetch; retries transient failures with backoff. */
function attemptFetch(email, password, region, attempt, generation, interactive) {
  function isAbandoned() {
    return generation !== fetchGeneration;
  }
  if (isAbandoned()) return;

  function fail(message) {
    if (isAbandoned()) return;
    if (message === MSG_NO_DEVICE || message === 'No CPAP data found') {
      // The login itself worked; don't send the user back to the login form
      localStorage.setItem(STORAGE_KEY_CONNECTED, 'true');
    }
    if (attempt < FETCH_RETRY_DELAYS_MS.length && !isPermanentFetchError(message)) {
      // Keep the cached token: a token the API rejects is already cleared
      // by its 401 handler, and logging in again can cost the user a new
      // emailed code
      setTimeout(function () {
        attemptFetch(email, password, region, attempt + 1, generation, interactive);
      }, FETCH_RETRY_DELAYS_MS[attempt]);
      return;
    }
    isDataFetchInProgress = false;
    sendErrorToWatch(message);
  }

  authenticateWithOkta(email, password, region, interactive,
    function (authError, accessToken, idToken, regionConfig) {
      if (authError) { fail(authError); return; }
      if (isAbandoned()) return;

      fetchSleepRecords(accessToken, idToken, regionConfig,
        function (fetchError, sleepRecordItems) {
          if (fetchError) { fail(fetchError); return; }
          if (isAbandoned()) return;
          isDataFetchInProgress = false;
          localStorage.setItem(STORAGE_KEY_CONNECTED, 'true');
          sendRecordsToWatch(sleepRecordItems);
        }
      );
    }
  );
}

// ---------------------------------------------------------------------------
// Pebble Event Listeners
// ---------------------------------------------------------------------------

// MOCK_MODE: set to true to send fake data for screenshots, false for production
var MOCK_MODE = false;

function sendMockData() {
  var mockRecords = [
    { date: 'Apr 15', score: 92, ahi: 8,  usage: 452, mask: 1, leak: 8  },
    { date: 'Apr 14', score: 85, ahi: 12, usage: 421, mask: 0, leak: 12 },
    { date: 'Apr 13', score: 78, ahi: 23, usage: 398, mask: 2, leak: 18 },
    { date: 'Apr 12', score: 88, ahi: 5,  usage: 445, mask: 1, leak: 6  },
    { date: 'Apr 11', score: 45, ahi: 32, usage: 180, mask: 4, leak: 35 },
    { date: 'Apr 10', score: 95, ahi: 3,  usage: 480, mask: 0, leak: 4  },
    { date: 'Apr 9',  score: 0,  ahi: 0,  usage: 0,   mask: 0, leak: 0  },
  ];

  enqueueWatchMessage({ 'TOTAL_DAYS': mockRecords.length });
  for (var i = 0; i < mockRecords.length; i++) {
    var r = mockRecords[i];
    enqueueWatchMessage({
      'DAY_INDEX': i,
      'RECORD_DATE': r.date,
      'SLEEP_SCORE': r.score,
      'AHI_X10': r.ahi,
      'USAGE_MINS': r.usage,
      'MASK_COUNT': r.mask,
      'LEAK_PCT': r.leak
    });
  }
  enqueueWatchMessage({ 'DATA_COMPLETE': 1 });
}

Pebble.addEventListener('ready', function () {
  if (MOCK_MODE) {
    sendMockData();
    return;
  }

  // With credentials, wait for the watch's REQUEST_DATA: it only asks when
  // its cache is stale, and resends if this JS wasn't running yet
  var savedEmail = localStorage.getItem(STORAGE_KEY_EMAIL);
  if (!savedEmail) {
    sendErrorToWatch('Open Settings to log in');
  }
});

Pebble.addEventListener('appmessage', function (event) {
  // Finding #6: Don't log the full payload

  if (event.payload.FRESH_INSTALL !== undefined) {
    // Only clear credentials on fresh install if credentials haven't
    // been entered in this JS session. This prevents the cycle where:
    // user logs in → fetch fails → watch has no data → next launch
    // sends FRESH_INSTALL → clears the credentials we just entered.
    var hasCredentials = localStorage.getItem(STORAGE_KEY_EMAIL);
    var wasConnected = localStorage.getItem(STORAGE_KEY_CONNECTED) === 'true';

    if (hasCredentials && !wasConnected) {
      // Credentials exist but never successfully connected — keep them
      // so the user doesn't have to re-enter after a transient API error
      clearCachedToken();
    } else if (!hasCredentials) {
      // No credentials at all — nothing to clear
    } else {
      // Was previously connected — this is a genuine reinstall
      localStorage.removeItem(STORAGE_KEY_EMAIL);
      localStorage.removeItem(STORAGE_KEY_PASSWORD);
      localStorage.removeItem(STORAGE_KEY_REGION);
      localStorage.removeItem(STORAGE_KEY_CONNECTED);
      clearCachedToken();
      clearRefreshToken();
      clearPendingMfa();
    }
  }

  if (event.payload.REQUEST_DATA !== undefined) {
    fetchAndSendSleepData();
  }
});

/**
 * Page asking for the emailed login code. If no code was sent yet (a
 * background refresh found the challenge), it offers to send one first.
 */
function buildMfaCodePage(codeSent) {
  return '<!DOCTYPE html><html><head>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' +
    'body{font-family:-apple-system,sans-serif;background:#1a1a1a;color:#fff;margin:0;padding:20px;box-sizing:border-box;}' +
    '.card{background:#2a2a2a;border-radius:12px;padding:20px;margin:16px 0;}' +
    'h2{margin:0 0 6px;font-size:20px;}' +
    '.info{color:#bbb;font-size:14px;line-height:1.5;margin:8px 0 16px;}' +
    'input{width:100%;box-sizing:border-box;background:#3a3a3a;color:#fff;border:1px solid #555;border-radius:6px;padding:12px;font-size:22px;letter-spacing:4px;text-align:center;}' +
    '.btn{display:block;width:100%;padding:14px;border:none;border-radius:8px;font-size:16px;font-weight:bold;cursor:pointer;margin:8px 0;box-sizing:border-box;}' +
    '.btn-save{background:#4A90D9;color:#fff;}' +
    '.btn-plain{background:#3a3a3a;color:#fff;}' +
    '.btn-danger{background:#d9534f;color:#fff;}' +
    '</style></head><body>' +
    '<div class="card"><h2>Check your email</h2>' +
    (codeSent
      ? '<div class="info">ResMed emailed you a verification code. Enter it below. ' +
        'This page closes when you tap Verify and your watch shows the result.</div>' +
        '<input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="Code">' +
        '<button class="btn btn-save" onclick="verify()">Verify</button>' +
        '<button class="btn btn-plain" onclick="send({MfaResend:true})">Send a new code</button>'
      : '<div class="info">ResMed needs a verification code to sign you in again. ' +
        'This page closes when you tap the button. Reopen it to enter the code from your email.</div>' +
        '<button class="btn btn-save" onclick="send({MfaResend:true})">Email me a code</button>') +
    '</div>' +
    '<button class="btn btn-danger" onclick="send({Logout:true})">Use a different account</button>' +
    '<script>' +
    'function send(o){document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify(o));}' +
    'function verify(){var c=document.getElementById("code").value.replace(/\\s+/g,"");' +
    'if(c){send({MfaCode:c});}}' +
    '</script></body></html>';
}

/**
 * Settings page — shows different content based on login state.
 */
Pebble.addEventListener('showConfiguration', function () {
  var savedEmail = localStorage.getItem(STORAGE_KEY_EMAIL);
  var isConnected = localStorage.getItem(STORAGE_KEY_CONNECTED) === 'true';
  var pendingMfa = getPendingMfa();

  if (savedEmail && pendingMfa) {
    Pebble.openURL('data:text/html,' + encodeURIComponent(buildMfaCodePage(pendingMfa.codeSent)));
  } else if (savedEmail && isConnected) {
    // Successfully connected — show status page with settings
    var maskedEmail = escapeHtml(savedEmail.charAt(0) + '***@' + savedEmail.split('@')[1]);

    var currentColorblind = localStorage.getItem('setting_colorblind') === 'true';
    var currentSyncInterval = localStorage.getItem('setting_sync_interval') || '4';
    var showEvents = localStorage.getItem('setting_show_events') !== 'false';
    var showUsage = localStorage.getItem('setting_show_usage') !== 'false';
    var showMaskOff = localStorage.getItem('setting_show_mask_off') !== 'false';
    var showLeak = localStorage.getItem('setting_show_leak') !== 'false';
    var textIndicators = localStorage.getItem('setting_text_indicators') === 'true';

    var connectedPage = '<!DOCTYPE html><html><head>' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>' +
      'body{font-family:-apple-system,sans-serif;background:#1a1a1a;color:#fff;margin:0;padding:20px;box-sizing:border-box;}' +
      '.card{background:#2a2a2a;border-radius:12px;padding:20px;margin:16px 0;}' +
      '.card-center{text-align:center;}' +
      '.check{font-size:40px;color:#4CAF50;margin-bottom:8px;}' +
      'h2{margin:0 0 6px;font-size:20px;}' +
      'h3{margin:0 0 12px;font-size:16px;color:#aaa;font-weight:normal;}' +
      '.email{color:#aaa;font-size:14px;margin-bottom:12px;}' +
      '.info{color:#bbb;font-size:13px;line-height:1.5;margin:8px 0;}' +
      '.privacy{color:#888;font-size:11px;margin:12px 0;line-height:1.4;}' +
      '.setting-row{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid #3a3a3a;}' +
      '.setting-row:last-child{border-bottom:none;}' +
      '.setting-label{font-size:15px;}' +
      '.setting-desc{font-size:12px;color:#888;margin-top:4px;}' +
      'select{background:#3a3a3a;color:#fff;border:1px solid #555;border-radius:6px;padding:8px 12px;font-size:14px;}' +
      '.toggle{position:relative;width:50px;height:28px;cursor:pointer;}' +
      '.toggle input{opacity:0;width:0;height:0;}' +
      '.slider{position:absolute;top:0;left:0;right:0;bottom:0;background:#555;border-radius:14px;transition:.3s;}' +
      '.slider:before{content:"";position:absolute;height:22px;width:22px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.3s;}' +
      '.toggle input:checked+.slider{background:#4CAF50;}' +
      '.toggle input:checked+.slider:before{transform:translateX(22px);}' +
      '.btn{display:block;width:100%;padding:14px;border:none;border-radius:8px;font-size:16px;font-weight:bold;cursor:pointer;margin:8px 0;box-sizing:border-box;}' +
      '.btn-save{background:#4A90D9;color:#fff;}' +
      '.btn-danger{background:#d9534f;color:#fff;}' +
      '</style></head><body>' +

      '<div class="card card-center">' +
      '<div class="check">&#10003;</div>' +
      '<h2>Connected to myAir</h2>' +
      '<div class="email">' + maskedEmail + '</div>' +
      '<div class="info">Pulling your CPAP sleep stats for the past week.</div>' +
      '<div class="privacy">Credentials stored locally on this phone only. This app is not HIPAA compliant and does not intend to be.</div>' +
      '</div>' +

      '<div class="card">' +
      '<h3>Settings</h3>' +
      '<div class="setting-row">' +
      '<div><div class="setting-label">Colorblind Mode</div>' +
      '<div class="setting-desc">Monochrome display, no color meaning</div></div>' +
      '<label class="toggle"><input type="checkbox" id="colorblind"' +
      (currentColorblind ? ' checked' : '') + '><span class="slider"></span></label></div>' +

      '<div class="setting-row">' +
      '<div><div class="setting-label">Simple Mode</div>' +
      '<div class="setting-desc">Show Good/OK/Poor instead of numbers</div></div>' +
      '<label class="toggle"><input type="checkbox" id="text-indicators"' +
      (textIndicators ? ' checked' : '') + '><span class="slider"></span></label></div>' +

      '<div class="setting-row">' +
      '<div><div class="setting-label">Sync Interval</div>' +
      '<div class="setting-desc">Refresh on open if data is older than this</div></div>' +
      '<select id="sync-interval">' +
      '<option value="4"' + (currentSyncInterval === '4' ? ' selected' : '') + '>4 hours</option>' +
      '<option value="6"' + (currentSyncInterval === '6' ? ' selected' : '') + '>6 hours</option>' +
      '<option value="8"' + (currentSyncInterval === '8' ? ' selected' : '') + '>8 hours</option>' +
      '<option value="12"' + (currentSyncInterval === '12' ? ' selected' : '') + '>12 hours</option>' +
      '</select></div></div>' +

      '<div class="card">' +
      '<h3>Visible Stats</h3>' +
      '<div class="setting-desc" style="margin-bottom:12px;">Overall score is always shown. Choose which details to display below it.</div>' +

      '<div class="setting-row"><div class="setting-label">Events (AHI)</div>' +
      '<label class="toggle"><input type="checkbox" id="show-events"' +
      (showEvents ? ' checked' : '') + '><span class="slider"></span></label></div>' +

      '<div class="setting-row"><div class="setting-label">Usage</div>' +
      '<label class="toggle"><input type="checkbox" id="show-usage"' +
      (showUsage ? ' checked' : '') + '><span class="slider"></span></label></div>' +

      '<div class="setting-row"><div class="setting-label">Mask Off</div>' +
      '<label class="toggle"><input type="checkbox" id="show-mask-off"' +
      (showMaskOff ? ' checked' : '') + '><span class="slider"></span></label></div>' +

      '<div class="setting-row"><div class="setting-label">Leak</div>' +
      '<label class="toggle"><input type="checkbox" id="show-leak"' +
      (showLeak ? ' checked' : '') + '><span class="slider"></span></label></div></div>' +

      '<button class="btn btn-save" onclick="saveSettings()">Save Settings</button>' +
      '<button class="btn btn-danger" onclick="disconnect()">Disconnect Account</button>' +

      '<script>' +
      'function saveSettings(){' +
      'var cb=document.getElementById("colorblind").checked;' +
      'var ti=document.getElementById("text-indicators").checked;' +
      'var si=document.getElementById("sync-interval").value;' +
      'var se=document.getElementById("show-events").checked;' +
      'var su=document.getElementById("show-usage").checked;' +
      'var sm=document.getElementById("show-mask-off").checked;' +
      'var sl=document.getElementById("show-leak").checked;' +
      'document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify({' +
      'COLORBLIND_MODE:cb,TEXT_INDICATORS:ti,SYNC_INTERVAL:parseInt(si),' +
      'SHOW_EVENTS:se,SHOW_USAGE:su,SHOW_MASK_OFF:sm,SHOW_LEAK:sl}));}' +
      'function disconnect(){' +
      'if(confirm("Disconnect your ResMed account? Your credentials will be removed.")){' +
      'document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify({Logout:true}));}}' +
      '</script></body></html>';

    Pebble.openURL('data:text/html,' + encodeURIComponent(connectedPage));
  } else {
    Pebble.openURL(clay.generateUrl());
  }
});

/**
 * Handle settings page close — process login, logout, or settings changes.
 */
Pebble.addEventListener('webviewclosed', function (event) {
  if (!event || !event.response || event.response === '') return;

  try {
    var decodedCheck;
    try {
      decodedCheck = decodeURIComponent(event.response);
    } catch (decodeError) {
      // Some phone apps hand back the response already decoded, and a
      // literal % (e.g. in a password) then fails to decode again
      decodedCheck = event.response;
    }
    if (!decodedCheck || decodedCheck.charAt(0) !== '{') return;

    var parsed = JSON.parse(decodedCheck);

    // -- Handle logout --
    var logoutFlag = parsed.Logout;
    if (typeof logoutFlag === 'object' && logoutFlag !== null) logoutFlag = logoutFlag.value;
    if (logoutFlag === true || logoutFlag === 1 || logoutFlag === '1') {
      localStorage.removeItem(STORAGE_KEY_EMAIL);
      localStorage.removeItem(STORAGE_KEY_PASSWORD);
      localStorage.removeItem(STORAGE_KEY_REGION);
      localStorage.removeItem(STORAGE_KEY_CONNECTED);
      clearCachedToken();
      clearRefreshToken();
      clearPendingMfa();
      sendErrorToWatch('Open Settings to log in');
      return;
    }

    // -- Handle email-code login (MFA) --
    if (parsed.MfaResend === true) {
      Pebble.sendAppMessage({ 'LOGGING_IN': 1 }, function () {}, function () {});
      fetchAndSendSleepData(true);
      return;
    }
    if (parsed.MfaCode !== undefined) {
      var code = String(parsed.MfaCode).replace(/\s+/g, '');
      if (!/^[0-9]{4,10}$/.test(code)) {
        sendErrorToWatch(MSG_CODE_WRONG);
        return;
      }
      Pebble.sendAppMessage({ 'LOGGING_IN': 1 }, function () {}, function () {});
      // Abandon any fetch in flight; it can only end in "code needed"
      fetchGeneration++;
      isDataFetchInProgress = false;
      verifyMfaCode(code, function (verifyError) {
        if (verifyError) { sendErrorToWatch(verifyError); return; }
        fetchAndSendSleepData(true);
      });
      return;
    }

    // -- Handle settings update --
    if (parsed.COLORBLIND_MODE !== undefined || parsed.SYNC_INTERVAL !== undefined) {
      var colorblind = parsed.COLORBLIND_MODE === true ? 1 : 0;
      var textIndicators = parsed.TEXT_INDICATORS === true ? 1 : 0;
      var syncHours = parsed.SYNC_INTERVAL || 4;
      var showEvents = parsed.SHOW_EVENTS === true ? 1 : 0;
      var showUsage = parsed.SHOW_USAGE === true ? 1 : 0;
      var showMaskOff = parsed.SHOW_MASK_OFF === true ? 1 : 0;
      var showLeak = parsed.SHOW_LEAK === true ? 1 : 0;

      localStorage.setItem('setting_colorblind', '' + (colorblind === 1));
      localStorage.setItem('setting_text_indicators', '' + (textIndicators === 1));
      localStorage.setItem('setting_sync_interval', '' + syncHours);
      localStorage.setItem('setting_show_events', '' + (showEvents === 1));
      localStorage.setItem('setting_show_usage', '' + (showUsage === 1));
      localStorage.setItem('setting_show_mask_off', '' + (showMaskOff === 1));
      localStorage.setItem('setting_show_leak', '' + (showLeak === 1));

      Pebble.sendAppMessage({
        'COLORBLIND_MODE': colorblind,
        'TEXT_INDICATORS': textIndicators,
        'SYNC_INTERVAL': syncHours,
        'SHOW_EVENTS': showEvents,
        'SHOW_USAGE': showUsage,
        'SHOW_MASK_OFF': showMaskOff,
        'SHOW_LEAK': showLeak
      }, function () {}, function () {});

      return;
    }

    // -- Handle empty response --
    if (Object.keys(parsed).length === 0) return;

    // -- Handle new login --
    var email = parsed.Email;
    var password = parsed.Password;
    var region = parsed.Region;

    if (typeof email === 'object' && email !== null) email = email.value;
    if (typeof password === 'object' && password !== null) password = password.value;
    if (typeof region === 'object' && region !== null) region = region.value;

    // Finding #11: Validate credentials before storing
    if (email && !isValidEmail(email)) {
      sendErrorToWatch('Invalid email format');
      return;
    }
    if (password && !isValidPassword(password)) {
      sendErrorToWatch('Invalid password');
      return;
    }

    if (email) localStorage.setItem(STORAGE_KEY_EMAIL, '' + email);
    if (password) localStorage.setItem(STORAGE_KEY_PASSWORD, '' + password);
    if (region) localStorage.setItem(STORAGE_KEY_REGION, '' + region);

    // Clear stale tokens and connected flag — will be set after successful fetch
    clearCachedToken();
    clearRefreshToken();
    localStorage.removeItem(STORAGE_KEY_CONNECTED);

    if (localStorage.getItem(STORAGE_KEY_EMAIL) &&
        localStorage.getItem(STORAGE_KEY_PASSWORD)) {
      // Swap the watch's setup prompt for a "Logging in" screen right away
      Pebble.sendAppMessage({ 'LOGGING_IN': 1 }, function () {}, function () {});
    }

    // Restart: a fetch already in flight is still using the old credentials
    fetchAndSendSleepData(true);
  } catch (parseError) {
    // Never fail silently, or the watch sits on its last screen forever
    sendErrorToWatch('Could not read settings. Try again');
  }
});
