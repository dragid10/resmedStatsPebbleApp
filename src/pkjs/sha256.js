/**
 * Lightweight SHA-256 for PebbleKit JS (PKCE code_challenge generation).
 * Pure JS, no dependencies.
 */

var K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rightRotate(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

/**
 * Compute SHA-256 hash of an ASCII string.
 * @param {string} message - ASCII string to hash
 * @returns {number[]} - Array of 32 bytes (the hash)
 */
function sha256(message) {
  // Pre-processing: convert string to bytes
  var msgBytes = [];
  for (var i = 0; i < message.length; i++) {
    msgBytes.push(message.charCodeAt(i) & 0xff);
  }

  var msgBitLen = msgBytes.length * 8;

  // Padding: append bit '1', then zeros, then 64-bit length
  msgBytes.push(0x80);
  while ((msgBytes.length % 64) !== 56) {
    msgBytes.push(0);
  }

  // Append length as 64-bit big-endian
  for (var s = 56; s >= 0; s -= 8) {
    msgBytes.push((msgBitLen / Math.pow(2, s)) & 0xff);
  }

  // Initial hash values
  var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  // Process each 64-byte chunk
  for (var offset = 0; offset < msgBytes.length; offset += 64) {
    var w = [];

    // Build message schedule
    for (var t = 0; t < 16; t++) {
      var bi = offset + t * 4;
      w[t] = (msgBytes[bi] << 24) | (msgBytes[bi + 1] << 16) |
             (msgBytes[bi + 2] << 8) | msgBytes[bi + 3];
    }
    for (var t = 16; t < 64; t++) {
      var s0 = rightRotate(w[t - 15], 7) ^ rightRotate(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      var s1 = rightRotate(w[t - 2], 17) ^ rightRotate(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }

    // Compression
    var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (var t = 0; t < 64; t++) {
      var S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      var ch = (e & f) ^ (~e & g);
      var temp1 = (h + S1 + ch + K[t] + w[t]) | 0;
      var S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var temp2 = (S0 + maj) | 0;

      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  // Produce the final hash as byte array
  var hash = [];
  var vals = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (var v = 0; v < 8; v++) {
    hash.push((vals[v] >>> 24) & 0xff);
    hash.push((vals[v] >>> 16) & 0xff);
    hash.push((vals[v] >>> 8) & 0xff);
    hash.push(vals[v] & 0xff);
  }

  return hash;
}

module.exports = sha256;
