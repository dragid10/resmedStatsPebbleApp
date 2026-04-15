/**
 * ResMed CPAP Stats — PebbleKit JS Phone Companion
 *
 * Runs on the paired phone and handles:
 *   1. Clay settings page for myAir credential entry
 *   2. Okta OAuth2 + PKCE authentication with ResMed
 *   3. GraphQL queries to fetch CPAP sleep records
 *   4. Sending data to the watch via AppMessage
 *
 * Credentials are stored ONLY in the phone's localStorage —
 * nothing is sent to any cloud or external server beyond ResMed's own API.
 *
 * Auth flow ported from ~/coding/sleep-dashboard/collectors/resmed.py
 */

var Clay = require('@rebble/clay');
var clayConfig = require('./config');
var sha256 = require('./sha256');

/**
 * Clay custom function — runs inside the config page's browser context.
 * Intercepts the submit button to validate credentials against Okta
 * before closing the page. Shows "Login successful!" or an error
 * directly in the config page on the phone.
 */
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
var XHR_TIMEOUT_MS = 30000;

/** Delay before retrying a failed AppMessage send (milliseconds). */
var APPMESSAGE_RETRY_DELAY_MS = 200;

/** Maximum length of error messages sent to the watch. */
var ERROR_MSG_MAX_LENGTH = 60;

/** Short month names for formatting dates on the watch display. */
var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** localStorage keys for persisted credentials. */
var STORAGE_KEY_EMAIL = 'resmed_email';
var STORAGE_KEY_PASSWORD = 'resmed_password';
var STORAGE_KEY_REGION = 'resmed_region';

/** Default region if none is configured. */
var DEFAULT_REGION = 'NA';

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
    product: 'myAir EU'
  }
};

// ---------------------------------------------------------------------------
// PKCE Helpers — Generate code_verifier and code_challenge for OAuth2
// ---------------------------------------------------------------------------

/** Characters allowed in a PKCE code verifier (RFC 7636). */
var PKCE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** Length of the generated PKCE code verifier. */
var PKCE_VERIFIER_LENGTH = 128;

/** Characters used for generating random OAuth state parameters. */
var STATE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Length of the generated OAuth state parameter. */
var STATE_LENGTH = 16;

/** Base64 encoding character set. */
var BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Generate a random PKCE code verifier string.
 * Uses Math.random() since PebbleKit JS lacks crypto.getRandomValues().
 */
function generateCodeVerifier() {
  var verifier = '';
  for (var i = 0; i < PKCE_VERIFIER_LENGTH; i++) {
    verifier += PKCE_CHARSET.charAt(Math.floor(Math.random() * PKCE_CHARSET.length));
  }
  return verifier;
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
  // Convert standard base64 to base64url (replace +/ with -_, strip padding)
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

/** Generate a random state parameter for the OAuth2 authorize request. */
function generateOAuthState() {
  var state = '';
  for (var i = 0; i < STATE_LENGTH; i++) {
    state += STATE_CHARSET.charAt(Math.floor(Math.random() * STATE_CHARSET.length));
  }
  return state;
}

// ---------------------------------------------------------------------------
// JWT Decoding — Extract claims from Okta id_token
// ---------------------------------------------------------------------------

/**
 * Decode a base64url-encoded string to a regular string.
 * Used to decode the JWT payload segment.
 */
function decodeBase64url(encoded) {
  // Add padding if needed
  var paddingNeeded = 4 - (encoded.length % 4);
  if (paddingNeeded !== 4) {
    for (var i = 0; i < paddingNeeded; i++) encoded += '=';
  }
  // Convert base64url to standard base64
  encoded = encoded.replace(/-/g, '+').replace(/_/g, '/');

  // Decode base64 to bytes
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

  // Convert bytes to string
  var decoded = '';
  for (var i = 0; i < bytes.length; i++) {
    decoded += String.fromCharCode(bytes[i]);
  }
  return decoded;
}

/**
 * Extract the myAirCountryId claim from a JWT id_token.
 * The country code is required for the GraphQL API's rmdcountry header.
 * Falls back to 'US' if the claim is missing or the token can't be decoded.
 */
function extractCountryFromIdToken(idToken) {
  try {
    var jwtSegments = idToken.split('.');
    var payloadJson = decodeBase64url(jwtSegments[1]);
    var payload = JSON.parse(payloadJson);
    return payload.myAirCountryId || 'US';
  } catch (e) {
    console.log('Failed to decode id_token JWT: ' + e);
    return 'US';
  }
}

// ---------------------------------------------------------------------------
// XHR Helper — Wrapper around XMLHttpRequest with timeout and error handling
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request using XMLHttpRequest.
 * @param {string} url - Request URL
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string|null} body - Request body (null for GET)
 * @param {Object|null} headers - Key-value pairs of request headers
 * @param {Function} callback - Called with (error, statusCode, responseText)
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
// Watch Communication — Send messages to the Pebble watch
// ---------------------------------------------------------------------------

/**
 * Send an error message to the watch for display.
 * Truncates to ERROR_MSG_MAX_LENGTH chars to fit in AppMessage buffer.
 */
function sendErrorToWatch(errorMessage) {
  console.log('Sending error to watch: ' + errorMessage);
  Pebble.sendAppMessage(
    { 'ERROR_MSG': errorMessage.substring(0, ERROR_MSG_MAX_LENGTH) },
    function () { console.log('Error message delivered to watch'); },
    function () { console.log('Failed to deliver error message to watch'); }
  );
}

// -- Sequential AppMessage Queue --
// Pebble can only process one AppMessage at a time. Messages are queued
// and sent one-by-one, waiting for each ACK before sending the next.

var pendingMessages = [];
var isMessageInFlight = false;

/** Add a message to the send queue and start processing if idle. */
function enqueueWatchMessage(message) {
  pendingMessages.push(message);
  processMessageQueue();
}

/** Send the next queued message if no message is currently in flight. */
function processMessageQueue() {
  if (isMessageInFlight || pendingMessages.length === 0) return;

  isMessageInFlight = true;
  var message = pendingMessages.shift();

  Pebble.sendAppMessage(message,
    function () {
      // Success — send next message
      isMessageInFlight = false;
      processMessageQueue();
    },
    function (error) {
      // Failure — put message back and retry after a short delay
      console.log('AppMessage send failed, retrying: ' + JSON.stringify(error));
      pendingMessages.unshift(message);
      isMessageInFlight = false;
      setTimeout(processMessageQueue, APPMESSAGE_RETRY_DELAY_MS);
    }
  );
}

// ---------------------------------------------------------------------------
// Okta Authentication — OAuth2 Authorization Code + PKCE
// ---------------------------------------------------------------------------

/**
 * Authenticate with ResMed's Okta SSO and obtain access + id tokens.
 *
 * Three-step OAuth2 flow:
 *   1. POST credentials to Okta /authn → sessionToken
 *   2. GET /authorize with PKCE + sessionToken → authorization code
 *      (uses response_mode=okta_post_message to avoid redirect issues)
 *   3. POST /token with code + code_verifier → access_token + id_token
 *
 * @param {string} email - myAir account email
 * @param {string} password - myAir account password
 * @param {string} region - 'NA' or 'EU'
 * @param {Function} callback - Called with (error, accessToken, idToken, regionConfig)
 */
function authenticateWithOkta(email, password, region, callback) {
  var regionConfig = REGION_CONFIG[region];
  if (!regionConfig) {
    callback('Invalid region: ' + region);
    return;
  }

  var oktaBaseUrl = regionConfig.okta_url;
  var authServerId = regionConfig.auth_server_id;

  // -- Step 1: Primary authentication (get session token) --
  console.log('Auth step 1/3: Authenticating with Okta...');

  var credentialsPayload = JSON.stringify({ username: email, password: password });

  makeHttpRequest(
    oktaBaseUrl + '/api/v1/authn',
    'POST',
    credentialsPayload,
    { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    function (networkError, httpStatus, responseBody) {
      if (networkError) { callback('Network error: ' + networkError); return; }
      if (httpStatus === 429) { callback('Rate limited. Try later.'); return; }
      if (httpStatus !== 200) { callback('Login failed (' + httpStatus + ')'); return; }

      var authnResponse;
      try { authnResponse = JSON.parse(responseBody); }
      catch (e) { callback('Bad auth response'); return; }

      if (authnResponse.status === 'MFA_REQUIRED') {
        callback('MFA not supported. Disable MFA on myAir.');
        return;
      }
      if (authnResponse.status !== 'SUCCESS') {
        callback('Auth status: ' + authnResponse.status);
        return;
      }

      var sessionToken = authnResponse.sessionToken;
      console.log('Auth step 1/3: Got session token');

      // -- Step 2: Exchange session token for authorization code via PKCE --
      console.log('Auth step 2/3: Getting authorization code...');

      var codeVerifier = generateCodeVerifier();
      var codeChallenge = generateCodeChallenge(codeVerifier);

      var authorizeUrl = oktaBaseUrl + '/oauth2/' + authServerId + '/v1/authorize?' +
        'client_id=' + encodeURIComponent(regionConfig.client_id) +
        '&response_type=code' +
        '&scope=' + encodeURIComponent('openid profile email') +
        '&redirect_uri=' + encodeURIComponent(regionConfig.redirect_url) +
        '&state=' + generateOAuthState() +
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
          if (networkError) { callback('Auth code error: ' + networkError); return; }

          // Parse the authorization code from the HTML response body.
          // Okta embeds it in JavaScript when using response_mode=okta_post_message.
          var authCodeMatch = responseBody.match(/data\.code\s*=\s*'([^']+)'/);
          if (!authCodeMatch) {
            authCodeMatch = responseBody.match(/code=([^"&\s]+)/);
          }
          if (!authCodeMatch) {
            authCodeMatch = responseBody.match(/"code"\s*:\s*"([^"]+)"/);
          }
          if (!authCodeMatch) {
            console.log('Could not find auth code in response (first 500 chars): ' +
                        responseBody.substring(0, 500));
            callback('Could not get auth code');
            return;
          }

          var authorizationCode = authCodeMatch[1];
          console.log('Auth step 2/3: Got authorization code (length: ' +
                      authorizationCode.length + ')');

          // -- Step 3: Exchange authorization code for access token --
          console.log('Auth step 3/3: Exchanging code for tokens...');

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
              if (networkError) { callback('Token error: ' + networkError); return; }
              if (httpStatus !== 200) {
                console.log('Token exchange failed (' + httpStatus + '): ' +
                            responseBody.substring(0, 300));
                // Parse the error description if available
                var tokenErrMsg = 'Login failed. Try again.';
                try {
                  var errData = JSON.parse(responseBody);
                  if (errData.error_description) {
                    tokenErrMsg = errData.error_description.substring(0, 55);
                  }
                } catch (ignored) {}
                callback(tokenErrMsg);
                return;
              }

              var tokenResponse;
              try { tokenResponse = JSON.parse(responseBody); }
              catch (e) { callback('Bad token response'); return; }

              console.log('Auth step 3/3: Authentication successful');
              callback(null, tokenResponse.access_token, tokenResponse.id_token || '', regionConfig);
            }
          );
        }
      );
    }
  );
}

// ---------------------------------------------------------------------------
// GraphQL — Fetch sleep records from the myAir AppSync API
// ---------------------------------------------------------------------------

/**
 * Format a Date object as an ISO date string (YYYY-MM-DD).
 * Required for the GraphQL startMonth/endMonth parameters.
 */
function formatIsoDate(date) {
  var year = date.getFullYear();
  var month = ('0' + (date.getMonth() + 1)).slice(-2);
  var day = ('0' + date.getDate()).slice(-2);
  return year + '-' + month + '-' + day;
}

/**
 * Fetch CPAP sleep records from the myAir GraphQL API.
 *
 * @param {string} accessToken - OAuth2 access token from Okta
 * @param {string} idToken - JWT id_token containing myAirCountryId claim
 * @param {Object} regionConfig - Region-specific API configuration
 * @param {Function} callback - Called with (error, sleepRecordItems)
 */
function fetchSleepRecords(accessToken, idToken, regionConfig, callback) {
  var countryCode = extractCountryFromIdToken(idToken);

  // Build date range: today minus MAX_DAYS
  var today = new Date();
  var rangeStart = new Date(today.getTime() - MAX_DAYS * MS_PER_DAY);
  var startDate = formatIsoDate(rangeStart);
  var endDate = formatIsoDate(today);

  // GraphQL query for sleep records
  var graphqlQuery =
    'query GetPatientSleepRecords { getPatientWrapper { ' +
    'sleepRecords(startMonth: "' + startDate + '", endMonth: "' + endDate + '") { ' +
    'items { startDate totalUsage sleepScore ahi maskPairCount leakPercentile __typename } ' +
    '__typename } __typename } }';

  // Required headers for the myAir AppSync API
  // (includes device metadata headers that the API expects)
  var requestHeaders = {
    'Authorization': 'Bearer ' + accessToken,
    'x-api-key': regionConfig.api_key,
    'Content-Type': 'application/json',
    'rmdhandsetid': '02c1c662-c289-41fd-a9ae-196ff15b5166',
    'rmdlanguage': 'en',
    'rmdhandsetmodel': 'PebbleApp',
    'rmdhandsetosversion': '1.0.0',
    'rmdproduct': regionConfig.product,
    'rmdappversion': '1.0.0',
    'rmdhandsetplatform': 'Web',
    'rmdcountry': countryCode,
    'accept-language': 'en-US,en;q=0.9'
  };

  var requestBody = JSON.stringify({ query: graphqlQuery });

  console.log('Fetching sleep records (' + startDate + ' to ' + endDate + ')...');

  makeHttpRequest(
    regionConfig.graphql_url,
    'POST',
    requestBody,
    requestHeaders,
    function (networkError, httpStatus, responseBody) {
      if (networkError) { callback('Network error: ' + networkError); return; }
      if (httpStatus !== 200) { callback('API error (' + httpStatus + ')'); return; }

      var apiResponse;
      try { apiResponse = JSON.parse(responseBody); }
      catch (e) { callback('Bad API response'); return; }

      if (apiResponse.errors) {
        console.log('GraphQL errors: ' + JSON.stringify(apiResponse.errors));
        callback('API error');
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
// Data Formatting & Transmission — Prepare and send records to watch
// ---------------------------------------------------------------------------

/**
 * Format an ISO date string (e.g. "2024-04-14T...") into a short
 * display string (e.g. "Apr 14") for the watch screen.
 */
function formatDateForWatch(isoDateString) {
  try {
    var datePart = isoDateString.split('T')[0];
    var dateSegments = datePart.split('-');
    var monthIndex = parseInt(dateSegments[1], 10) - 1;
    var dayOfMonth = parseInt(dateSegments[2], 10);
    return MONTH_NAMES[monthIndex] + ' ' + dayOfMonth;
  } catch (e) {
    // Fallback: return the raw month-day portion
    return isoDateString.substring(5, 10);
  }
}

/**
 * Send an array of sleep record items to the watch via AppMessage.
 *
 * Records are sorted most-recent-first and sent one at a time through
 * the sequential message queue. The watch receives:
 *   1. TOTAL_DAYS message (how many records to expect)
 *   2. One message per day with all stats
 *   3. DATA_COMPLETE signal
 */
function sendRecordsToWatch(sleepRecordItems) {
  // Sort by date descending (most recent night first)
  sleepRecordItems.sort(function (a, b) {
    return (b.startDate || '').localeCompare(a.startDate || '');
  });

  // Limit to MAX_DAYS records
  var recordsToSend = sleepRecordItems.slice(0, MAX_DAYS);
  var totalDays = recordsToSend.length;

  console.log('Sending ' + totalDays + ' days of sleep data to watch');

  // First: tell the watch how many days to expect
  enqueueWatchMessage({ 'TOTAL_DAYS': totalDays });

  // Then: send each day's data as a separate message
  for (var dayIndex = 0; dayIndex < totalDays; dayIndex++) {
    var record = recordsToSend[dayIndex];

    // AHI is sent as integer × 10 to avoid floating point
    // (e.g., AHI of 3.2 → 32)
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

  // Finally: signal that all data has been sent
  enqueueWatchMessage({ 'DATA_COMPLETE': 1 });
}

// ---------------------------------------------------------------------------
// Main Orchestration — Coordinate auth, fetch, and send
// ---------------------------------------------------------------------------

/** Guard flag to prevent concurrent data fetches. */
var isDataFetchInProgress = false;

/**
 * Main data fetch function. Loads credentials from localStorage,
 * authenticates with Okta, queries GraphQL, and sends results to watch.
 */
function fetchAndSendSleepData() {
  if (isDataFetchInProgress) {
    console.log('Data fetch already in progress, skipping');
    return;
  }

  var email = localStorage.getItem(STORAGE_KEY_EMAIL);
  var password = localStorage.getItem(STORAGE_KEY_PASSWORD);
  var region = localStorage.getItem(STORAGE_KEY_REGION) || DEFAULT_REGION;

  if (!email || !password) {
    sendErrorToWatch('Open Settings to log in');
    return;
  }

  isDataFetchInProgress = true;
  console.log('Starting data fetch (region: ' + region + ')');

  authenticateWithOkta(email, password, region,
    function (authError, accessToken, idToken, regionConfig) {
      if (authError) {
        isDataFetchInProgress = false;
        sendErrorToWatch(authError);
        return;
      }

      fetchSleepRecords(accessToken, idToken, regionConfig,
        function (fetchError, sleepRecordItems) {
          isDataFetchInProgress = false;
          if (fetchError) {
            sendErrorToWatch(fetchError);
            return;
          }

          sendRecordsToWatch(sleepRecordItems);
        }
      );
    }
  );
}

// ---------------------------------------------------------------------------
// Pebble Event Listeners
// ---------------------------------------------------------------------------

/** App ready — fetch data if credentials exist, otherwise prompt setup. */
Pebble.addEventListener('ready', function () {
  console.log('PebbleKit JS ready');

  var savedEmail = localStorage.getItem(STORAGE_KEY_EMAIL);
  if (savedEmail) {
    fetchAndSendSleepData();
  } else {
    sendErrorToWatch('Open Settings to log in');
  }
});

/** Watch requested data refresh (SELECT button or wakeup trigger). */
Pebble.addEventListener('appmessage', function (event) {
  console.log('Received message from watch: ' + JSON.stringify(event.payload));

  // If the watch reports a fresh install (no cached data on watch flash),
  // clear any stale credentials left over from a previous install.
  // PebbleKit JS localStorage persists across uninstall, but the watch's
  // persistent storage is wiped, so we use the watch as source of truth.
  if (event.payload.FRESH_INSTALL !== undefined) {
    console.log('Fresh install detected — clearing stale credentials');
    localStorage.removeItem(STORAGE_KEY_EMAIL);
    localStorage.removeItem(STORAGE_KEY_PASSWORD);
    localStorage.removeItem(STORAGE_KEY_REGION);
  }

  if (event.payload.REQUEST_DATA !== undefined) {
    fetchAndSendSleepData();
  }
});

/**
 * User opened the settings page.
 * If already logged in, show a "Connected" page with a disconnect button.
 * If not logged in, show the Clay login form.
 */
Pebble.addEventListener('showConfiguration', function () {
  var savedEmail = localStorage.getItem(STORAGE_KEY_EMAIL);

  if (savedEmail) {
    // Already connected — show status page with settings
    var maskedEmail = savedEmail.charAt(0) + '***@' + savedEmail.split('@')[1];

    // Load current settings from localStorage
    var currentColorblind = localStorage.getItem('setting_colorblind') === 'true';
    var currentSyncInterval = localStorage.getItem('setting_sync_interval') || '4';

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

      // -- Status card --
      '<div class="card card-center">' +
      '<div class="check">&#10003;</div>' +
      '<h2>Connected to myAir</h2>' +
      '<div class="email">' + maskedEmail + '</div>' +
      '<div class="info">Pulling your CPAP sleep stats for the past week.</div>' +
      '<div class="privacy">Credentials stored locally on this phone only.</div>' +
      '</div>' +

      // -- Settings card --
      '<div class="card">' +
      '<h3>Settings</h3>' +

      '<div class="setting-row">' +
      '<div><div class="setting-label">Colorblind Mode</div>' +
      '<div class="setting-desc">Use patterns instead of red/yellow/green</div></div>' +
      '<label class="toggle"><input type="checkbox" id="colorblind"' +
      (currentColorblind ? ' checked' : '') + '><span class="slider"></span></label>' +
      '</div>' +

      '<div class="setting-row">' +
      '<div><div class="setting-label">Sync Interval</div>' +
      '<div class="setting-desc">How often to refresh data</div></div>' +
      '<select id="sync-interval">' +
      '<option value="4"' + (currentSyncInterval === '4' ? ' selected' : '') + '>4 hours</option>' +
      '<option value="6"' + (currentSyncInterval === '6' ? ' selected' : '') + '>6 hours</option>' +
      '<option value="8"' + (currentSyncInterval === '8' ? ' selected' : '') + '>8 hours</option>' +
      '<option value="12"' + (currentSyncInterval === '12' ? ' selected' : '') + '>12 hours</option>' +
      '</select>' +
      '</div>' +

      '</div>' +

      // -- Buttons --
      '<button class="btn btn-save" onclick="saveSettings()">Save Settings</button>' +
      '<button class="btn btn-danger" onclick="disconnect()">Disconnect Account</button>' +

      '<script>' +
      'function saveSettings(){' +
      'var cb=document.getElementById("colorblind").checked;' +
      'var si=document.getElementById("sync-interval").value;' +
      'document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify({' +
      'COLORBLIND_MODE:cb,SYNC_INTERVAL:parseInt(si)}));' +
      '}' +
      'function disconnect(){' +
      'if(confirm("Disconnect your ResMed account? Your credentials will be removed.")){' +
      'document.location="pebblejs://close#"+encodeURIComponent(JSON.stringify({Logout:true}));' +
      '}}' +
      '</script></body></html>';

    Pebble.openURL('data:text/html,' + encodeURIComponent(connectedPage));
  } else {
    // Not logged in — show the Clay login form
    Pebble.openURL(clay.generateUrl());
  }
});

/**
 * User saved settings — extract credentials, store locally, and fetch data.
 * Credentials are intentionally NOT forwarded to the watch via AppMessage.
 */
Pebble.addEventListener('webviewclosed', function (event) {
  if (!event || !event.response || event.response === '') return;

  try {
    // Guard against non-JSON responses (e.g. user hit back button)
    var decodedCheck = decodeURIComponent(event.response);
    if (!decodedCheck || decodedCheck.charAt(0) !== '{') {
      console.log('Settings closed without saving (non-JSON response)');
      return;
    }
    var decodedResponse = decodeURIComponent(event.response);
    var parsed = JSON.parse(decodedResponse);

    // -- Handle logout (from the "Connected" status page) --
    var logoutFlag = parsed.Logout;
    if (typeof logoutFlag === 'object' && logoutFlag !== null) {
      logoutFlag = logoutFlag.value;
    }
    if (logoutFlag === true || logoutFlag === 1 || logoutFlag === '1') {
      localStorage.removeItem(STORAGE_KEY_EMAIL);
      localStorage.removeItem(STORAGE_KEY_PASSWORD);
      localStorage.removeItem(STORAGE_KEY_REGION);
      console.log('Credentials cleared — user disconnected');
      sendErrorToWatch('Open Settings to log in');
      return;
    }

    // -- Handle settings update (from connected page) --
    if (parsed.COLORBLIND_MODE !== undefined || parsed.SYNC_INTERVAL !== undefined) {
      var colorblind = parsed.COLORBLIND_MODE === true ? 1 : 0;
      var syncHours = parsed.SYNC_INTERVAL || 4;

      // Persist settings locally
      localStorage.setItem('setting_colorblind', '' + (colorblind === 1));
      localStorage.setItem('setting_sync_interval', '' + syncHours);

      // Send settings to the watch
      Pebble.sendAppMessage({
        'COLORBLIND_MODE': colorblind,
        'SYNC_INTERVAL': syncHours
      },
        function () { console.log('Settings sent to watch'); },
        function () { console.log('Failed to send settings to watch'); }
      );

      console.log('Settings updated (colorblind: ' + colorblind +
                   ', sync: ' + syncHours + 'h)');
      return;
    }

    // -- Handle empty response (user closed without action) --
    if (Object.keys(parsed).length === 0) {
      console.log('Settings closed with no changes');
      return;
    }

    // -- Handle new login (from the Clay login form) --
    var email = parsed.Email;
    var password = parsed.Password;
    var region = parsed.Region;

    // Unwrap Clay select/input objects
    if (typeof email === 'object' && email !== null) email = email.value;
    if (typeof password === 'object' && password !== null) password = password.value;
    if (typeof region === 'object' && region !== null) region = region.value;

    if (email) localStorage.setItem(STORAGE_KEY_EMAIL, '' + email);
    if (password) localStorage.setItem(STORAGE_KEY_PASSWORD, '' + password);
    if (region) localStorage.setItem(STORAGE_KEY_REGION, '' + region);

    console.log('Credentials saved (email: ' + (email ? 'set' : 'empty') +
                ', region: ' + (region || DEFAULT_REGION) + ')');

    // Fetch data with the new credentials
    fetchAndSendSleepData();
  } catch (parseError) {
    console.log('Error parsing settings response: ' + parseError);
  }
});
