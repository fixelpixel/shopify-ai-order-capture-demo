import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/classify.mjs';
import { loadCaptureConfig } from '../src/config.mjs';
import { mapEnricher } from '../src/enrich.mjs';
import { createJsonlLedger, readJsonl } from '../src/ledger.mjs';
import { createPipeline } from '../src/pipeline.mjs';
import { createCaptureServer, WEBHOOK_PATH } from '../src/server.mjs';
import { computeShopifyHmac } from '../src/verify.mjs';

const SECRET = 'server-test-secret';
const capture = loadCaptureConfig();
const rules = loadRules();
const fx = (ref) => JSON.parse(readFileSync(new URL(`../fixtures/orders/${ref}.json`, import.meta.url), 'utf8'));

async function startApp({ enrich, secrets = SECRET, pipelineOverride, maxBodyBytes, fetchImpl, ga4 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'server-'));
  const ledgerPath = join(dir, 'ledger.jsonl');
  let now = Date.parse('2026-10-01T12:00:00Z');
  const clock = () => now;
  const pipeline = pipelineOverride ?? createPipeline({ capture, rules, clock, enrich, includePayloads: true, ga4, fetchImpl, env: { GA4_MEASUREMENT_ID: 'G-TEST', GA4_API_SECRET: 'x' } });
  const app = createCaptureServer({ secrets, pipeline, ledger: createJsonlLedger(ledgerPath), maxBodyBytes, clock, logger: { error() {} } });
  const { port } = await app.listen(0);
  const url = `http://127.0.0.1:${port}${WEBHOOK_PATH}`;
  return {
    app,
    url,
    ledger: () => readJsonl(ledgerPath),
    setNow: (iso) => { now = Date.parse(iso); },
    async post(body, { topic = 'orders/create', webhookId = crypto.randomUUID(), secret = SECRET, hmac, raw, headers = {} } = {}) {
      const text = raw ?? JSON.stringify(body);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-topic': topic,
          'x-shopify-shop-domain': 'demo-store.example',
          ...(webhookId ? { 'x-shopify-webhook-id': webhookId } : {}),
          'x-shopify-event-id': crypto.randomUUID(),
          ...(hmac === null ? {} : { 'x-shopify-hmac-sha256': hmac ?? computeShopifyHmac(text, secret) }),
          ...headers,
        },
        body: text,
      });
      return { status: res.status, json: await res.json() };
    },
  };
}

test('end to end: a signed orders/create is accepted, classified, priced and written to the ledger', async (t) => {
  const f = fx('o08');
  const s = await startApp({ enrich: mapEnricher(new Map([[String(f.payload.id), f.graphql]])) });
  t.after(() => s.app.close());
  s.setNow('2026-09-29T13:45:04Z');
  const res = await s.post(f.payload);
  assert.deepEqual(res, { status: 200, json: { status: 'accepted' } });
  await s.app.drain();
  const [rec] = s.ledger();
  assert.equal(rec.outcome, 'captured');
  assert.equal(rec.topic, 'orders/create');
  assert.equal(rec.shop_domain, 'demo-store.example');
  assert.equal(rec.order_id, String(f.payload.id));
  assert.equal(rec.classification.channel, 'copilot');
  assert.equal(rec.classification.rule_confirmed, false);
  assert.equal(rec.ga4.decision, 'send');
  assert.equal(rec.ga4.status, 'built_dry_run');
  assert.equal(rec.ga4.payload.events[0].params.transaction_id, String(f.payload.id));
  assert.equal(rec.ga4.payload.events[0].params.ai_channel, 'copilot');
  assert.equal(rec.platforms.meta.eligible, false);
  assert.equal(rec.ga4_mode, 'dry-run');
});

test('bad signature, tampered body or missing header: 401 and nothing recorded', async (t) => {
  const s = await startApp();
  t.after(() => s.app.close());
  const body = fx('o01').payload;
  assert.equal((await s.post(body, { secret: 'wrong-secret' })).status, 401);
  const signed = JSON.stringify(body);
  assert.equal((await s.post(null, { raw: signed.replace('"90.77"', '"1.00"'), hmac: computeShopifyHmac(signed, SECRET) })).status, 401);
  assert.equal((await s.post(body, { hmac: null })).status, 401);
  await s.app.drain();
  assert.deepEqual(s.ledger(), []);
  assert.equal(s.app.stats.rejected, 3);
});

test('duplicate X-Shopify-Webhook-Id: 200 "duplicate", processed once', async (t) => {
  const s = await startApp();
  t.after(() => s.app.close());
  const body = fx('o02').payload;
  s.setNow('2026-09-26T18:20:04Z');
  assert.equal((await s.post(body, { webhookId: 'wh-dup' })).json.status, 'accepted');
  assert.equal((await s.post(body, { webhookId: 'wh-dup' })).json.status, 'duplicate');
  await s.app.drain();
  assert.deepEqual(s.ledger().map((r) => r.outcome), ['captured', 'duplicate_delivery']);
});

test('orders/create then orders/paid for one order: the purchase is captured once', async (t) => {
  const s = await startApp();
  t.after(() => s.app.close());
  const body = fx('o01').payload;
  s.setNow('2026-09-26T14:05:04Z');
  await s.post(body, { topic: 'orders/create' });
  await s.post(body, { topic: 'orders/paid' });
  await s.app.drain();
  assert.deepEqual(s.ledger().map((r) => r.outcome), ['captured', 'already_captured']);
});

test('pending order waits for orders/paid', async (t) => {
  const s = await startApp();
  t.after(() => s.app.close());
  const body = fx('o18').payload;
  s.setNow('2026-10-02T01:00:04Z');
  await s.post(body, { topic: 'orders/create' });
  s.setNow('2026-10-02T06:00:04Z');
  await s.post({ ...body, financial_status: 'paid' }, { topic: 'orders/paid' });
  await s.app.drain();
  const recs = s.ledger();
  assert.deepEqual(recs.map((r) => r.outcome), ['waiting', 'captured']);
  assert.match(recs[0].reason, /pending/);
});

test('refunds/create builds a GA4 refund with the purchase\'s client id', async (t) => {
  const f = fx('o09');
  const s = await startApp({ enrich: mapEnricher(new Map([[String(f.payload.id), f.graphql]])) });
  t.after(() => s.app.close());
  s.setNow('2026-09-30T08:10:04Z');
  await s.post(f.payload);
  s.setNow('2026-10-01T09:00:04Z');
  await s.post(f.refund, { topic: 'refunds/create' });
  await s.app.drain();
  const [purchase, refund] = s.ledger();
  assert.equal(refund.outcome, 'refund');
  assert.equal(refund.ga4.client_id, purchase.ga4.client_id);
  assert.equal(refund.ga4.payload.events[0].name, 'refund');
  assert.equal(refund.ga4.value, 34.56);
});

test('test orders and unsupported topics are acknowledged and ignored', async (t) => {
  const s = await startApp();
  t.after(() => s.app.close());
  const testOrder = fx('o21').payload;
  assert.equal((await s.post(testOrder)).json.status, 'accepted');
  assert.deepEqual((await s.post(testOrder, { topic: 'orders/updated' })).json, { status: 'ignored', topic: 'orders/updated' });
  await s.app.drain();
  assert.deepEqual(s.ledger().map((r) => r.outcome), ['ignored', 'ignored_topic']);
});

test('routing and malformed requests: 404, 405, 400, 413', async (t) => {
  const s = await startApp({ maxBodyBytes: 2048 });
  t.after(() => s.app.close());
  const base = s.url.replace(WEBHOOK_PATH, '');
  assert.equal((await fetch(`${base}/other`, { method: 'POST', body: '{}' })).status, 404);
  const get = await fetch(s.url);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await s.post({ id: 1 }, { webhookId: null })).status, 400, 'missing webhook id');
  assert.equal((await s.post(null, { raw: 'not json' })).status, 400, 'signed but not JSON');
  assert.equal((await s.post(null, { raw: JSON.stringify({ pad: 'x'.repeat(5000) }) })).status, 413);
});

test('answers 200 before processing finishes (Shopify allows 5 s for the whole request)', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await startApp({ enrich: async () => { await gate; return null; } });
  t.after(() => s.app.close());
  s.setNow('2026-09-26T18:20:04Z');
  const res = await s.post(fx('o02').payload);
  assert.equal(res.status, 200);
  assert.deepEqual(s.ledger(), [], 'nothing written yet: processing is still waiting');
  release();
  await s.app.drain();
  assert.equal(s.ledger().length, 1);
});

test('a processing error is recorded in the ledger; the delivery was still acknowledged', async (t) => {
  const s = await startApp({ pipelineOverride: { processDelivery: async () => { throw new Error('boom'); } } });
  t.after(() => s.app.close());
  assert.equal((await s.post(fx('o02').payload)).status, 200);
  await s.app.drain();
  const [rec] = s.ledger();
  assert.equal(rec.outcome, 'error');
  assert.equal(rec.reason, 'boom');
});

test('secret rotation: deliveries signed with the previous secret still verify', async (t) => {
  const s = await startApp({ secrets: ['new-secret', SECRET] });
  t.after(() => s.app.close());
  assert.equal((await s.post(fx('o02').payload, { secret: SECRET })).status, 200);
  assert.equal((await s.post(fx('o03').payload, { secret: 'new-secret' })).status, 200);
});

test('send mode posts the purchase to /mp/collect; a failed send releases the order for retry', async (t) => {
  const calls = [];
  let fail = true;
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (fail) throw new Error('network down');
    return { status: 204 };
  };
  const f = fx('o06');
  const s = await startApp({ ga4: { mode: 'send' }, fetchImpl, enrich: mapEnricher(new Map([[String(f.payload.id), f.graphql]])) });
  t.after(() => s.app.close());
  s.setNow('2026-09-28T15:30:04Z');
  await s.post(f.payload, { topic: 'orders/create' });
  fail = false;
  await s.post(f.payload, { topic: 'orders/paid' });
  await s.app.drain();
  const recs = s.ledger();
  assert.deepEqual(recs.map((r) => r.ga4?.status), ['send_failed', 'sent']);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /^https:\/\/www\.google-analytics\.com\/mp\/collect\?measurement_id=G-TEST/);
  assert.equal(calls[1].body.events[0].params.transaction_id, String(f.payload.id));
});
