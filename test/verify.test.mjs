import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { computeShopifyHmac, headerValue, HMAC_HEADER, verifyShopifyWebhook } from '../src/verify.mjs';

const SECRET = 'test-secret-1';
const BODY = JSON.stringify({ id: 990000000101, total_price: '90.77', note: 'ünïcödé' });

test('header name is X-Shopify-Hmac-Sha256 (lowercased by Node)', () => {
  assert.equal(HMAC_HEADER, 'x-shopify-hmac-sha256');
});

test('computeShopifyHmac is base64 HMAC-SHA256 of the raw body', () => {
  const expected = createHmac('sha256', SECRET).update(Buffer.from(BODY, 'utf8')).digest('base64');
  assert.equal(computeShopifyHmac(BODY, SECRET), expected);
  assert.equal(computeShopifyHmac(Buffer.from(BODY), SECRET), expected);
});

test('valid signature passes (string and Buffer body)', () => {
  const sig = computeShopifyHmac(BODY, SECRET);
  assert.equal(verifyShopifyWebhook(BODY, sig, SECRET), true);
  assert.equal(verifyShopifyWebhook(Buffer.from(BODY), sig, SECRET), true);
  assert.equal(verifyShopifyWebhook(BODY, `  ${sig} `, SECRET), true, 'surrounding whitespace is trimmed');
});

test('wrong secret fails', () => {
  assert.equal(verifyShopifyWebhook(BODY, computeShopifyHmac(BODY, 'other-secret'), SECRET), false);
});

test('tampered body fails, even by one byte', () => {
  const sig = computeShopifyHmac(BODY, SECRET);
  assert.equal(verifyShopifyWebhook(BODY.replace('90.77', '90.78'), sig, SECRET), false);
  assert.equal(verifyShopifyWebhook(BODY + ' ', sig, SECRET), false);
  // Re-serialising parsed JSON changes bytes: always verify the raw body.
  assert.equal(verifyShopifyWebhook(JSON.stringify(JSON.parse(BODY), null, 1), sig, SECRET), false);
});

test('missing, malformed or wrong-length header fails', () => {
  assert.equal(verifyShopifyWebhook(BODY, undefined, SECRET), false);
  assert.equal(verifyShopifyWebhook(BODY, '', SECRET), false);
  assert.equal(verifyShopifyWebhook(BODY, 'not base64 at all!', SECRET), false);
  assert.equal(verifyShopifyWebhook(BODY, Buffer.alloc(16).toString('base64'), SECRET), false);
  const hex = createHmac('sha256', SECRET).update(BODY).digest('hex');
  assert.equal(verifyShopifyWebhook(BODY, hex, SECRET), false, 'hex digest is not accepted');
});

test('null body fails', () => {
  assert.equal(verifyShopifyWebhook(null, computeShopifyHmac('', SECRET), SECRET), false);
});

test('secret rotation: either of [current, previous] verifies', () => {
  const oldSig = computeShopifyHmac(BODY, 'old-secret');
  const newSig = computeShopifyHmac(BODY, 'new-secret');
  assert.equal(verifyShopifyWebhook(BODY, oldSig, ['new-secret', 'old-secret']), true);
  assert.equal(verifyShopifyWebhook(BODY, newSig, ['new-secret', 'old-secret']), true);
  assert.equal(verifyShopifyWebhook(BODY, oldSig, ['new-secret']), false);
});

test('no secret configured throws instead of silently passing', () => {
  assert.throws(() => verifyShopifyWebhook(BODY, 'x', ''), /no app secret/);
  assert.throws(() => verifyShopifyWebhook(BODY, 'x', []), /no app secret/);
});

test('headerValue is case-insensitive', () => {
  assert.equal(headerValue({ 'X-Shopify-Hmac-SHA256': 'abc' }, 'x-shopify-hmac-sha256'), 'abc');
  assert.equal(headerValue({ 'x-shopify-topic': ['orders/create', 'x'] }, 'X-Shopify-Topic'), 'orders/create');
  assert.equal(headerValue(undefined, 'x'), undefined);
});
