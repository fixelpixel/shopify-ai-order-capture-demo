// Shopify webhook signature check.
//
// Shopify sends a base64 HMAC-SHA256 of the raw request body, keyed with the app's
// client secret, in the X-Shopify-Hmac-Sha256 header. Verify it against the raw bytes
// before parsing or trusting the payload.
// Source: https://shopify.dev/docs/apps/build/webhooks/verify-deliveries (read 2026-10-02)

import { createHmac, timingSafeEqual } from 'node:crypto';

export const HMAC_HEADER = 'x-shopify-hmac-sha256';

const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;

/** Base64 HMAC-SHA256 of the raw body. Used by the verifier, the demo and the tests. */
export function computeShopifyHmac(rawBody, secret) {
  return createHmac('sha256', secret).update(toBuffer(rawBody)).digest('base64');
}

/**
 * @param {Buffer|string} rawBody  exact bytes received (do not re-serialize parsed JSON)
 * @param {string|undefined} hmacHeader  value of X-Shopify-Hmac-Sha256
 * @param {string|string[]} secrets  app client secret; pass [current, previous] while a
 *   rotated secret takes effect (Shopify notes this can take up to an hour)
 * @returns {boolean}
 */
export function verifyShopifyWebhook(rawBody, hmacHeader, secrets) {
  const keys = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (s) => typeof s === 'string' && s.length > 0,
  );
  if (keys.length === 0) throw new Error('verifyShopifyWebhook: no app secret configured');
  if (rawBody === undefined || rawBody === null) return false;
  if (typeof hmacHeader !== 'string') return false;

  const header = hmacHeader.trim();
  if (!BASE64_SHA256.test(header)) return false;
  const received = Buffer.from(header, 'base64');
  if (received.length !== 32) return false;

  const body = toBuffer(rawBody);
  let valid = false;
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(body).digest();
    // Constant-time compare; no early return so timing does not reveal which key matched.
    if (timingSafeEqual(expected, received)) valid = true;
  }
  return valid;
}

/** Case-insensitive header lookup for plain objects and Node's IncomingHttpHeaders. */
export function headerValue(headers, name) {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function toBuffer(raw) {
  return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
}
