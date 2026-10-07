import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyOrder, loadRules } from '../src/classify.mjs';
import { loadCaptureConfig } from '../src/config.mjs';
import {
  buildPurchasePayload, buildRefundPayload, decideGa4, MP_LIMITS, mpUrl, parseGaClientId, PARTIAL_REPORTING_NOTE,
  postToGa4, resolveGa4Mode, syntheticClientId, validateMpPayload,
} from '../src/ga4.mjs';

const capture = loadCaptureConfig();
const rules = loadRules();
const fx = (ref) => JSON.parse(readFileSync(new URL(`../fixtures/orders/${ref}.json`, import.meta.url), 'utf8'));
const SHOP = 'demo-store.example';

function build(ref, opts = {}) {
  const f = fx(ref);
  const order = opts.order ?? f.payload;
  const classification = classifyOrder(order, { rules, enrichment: f.graphql, capture });
  const now = opts.now ?? Date.parse(order.created_at) + 5000;
  const built = buildPurchasePayload(order, classification, { capture: opts.capture ?? capture, shopDomain: SHOP, now });
  return { f, order, classification, built, now };
}

test('documented MP limits', () => {
  assert.deepEqual({ ...MP_LIMITS }, {
    maxEventsPerRequest: 25, maxParamsPerEvent: 25, maxNameLength: 40, maxParamValueLength: 100,
    maxItemCustomParams: 10, maxBodyBytes: 130_000, maxBackdateHours: 72,
  });
});

test('parseGaClientId reduces the _ga cookie to the client id', () => {
  assert.equal(parseGaClientId('GA1.1.1234567890.1700000000'), '1234567890.1700000000');
  assert.equal(parseGaClientId('GA1.2.42.99'), '42.99');
  assert.equal(parseGaClientId('1234567890.1700000000'), '1234567890.1700000000');
  assert.equal(parseGaClientId(' GA1.1.1.2 '), '1.2');
  for (const bad of [null, undefined, '', 'GA1.1.abc.def', 'GS1.1.1700000000.1.1', '12345']) assert.equal(parseGaClientId(bad), null);
});

test('synthetic client id is deterministic per shop + order and looks like a GA id', () => {
  const a = syntheticClientId(SHOP, 1);
  assert.match(a, /^\d{10}\.\d{10}$/);
  assert.equal(syntheticClientId(SHOP, 1), a);
  assert.notEqual(syntheticClientId(SHOP, 2), a);
  assert.notEqual(syntheticClientId('other.example', 1), a);
});

test('purchase payload: transaction_id = order id, value = items without shipping/tax, channel params', () => {
  const { order, built } = build('o01');
  const { payload } = built;
  assert.deepEqual(Object.keys(payload), ['client_id', 'timestamp_micros', 'events']);
  assert.equal(payload.client_id, parseGaClientId(order.note_attributes.find((a) => a.name === '_ga').value));
  assert.equal(payload.timestamp_micros, Date.parse(order.created_at) * 1000);
  assert.equal(payload.events.length, 1);
  const { name, params } = payload.events[0];
  assert.equal(name, 'purchase');
  assert.equal(params.transaction_id, String(order.id));
  assert.equal(typeof params.transaction_id, 'string');
  assert.equal(params.currency, 'USD');
  assert.equal(params.value, 77.1, '59.00 - 5.90 discount + 24.00; no tax, no shipping');
  assert.equal(params.tax, 6.17);
  assert.equal(params.shipping, 7.5);
  assert.equal(params.coupon, 'WELCOME10');
  assert.equal(params.ai_channel, 'web');
  assert.equal(params.ai_label_status, 'confirmed');
  assert.equal(params.ai_checkout, 'store');
  assert.equal(params.client_id_source, 'ga_cookie');
  assert.equal(params.capture_source, 'server_mp');
  assert.deepEqual(params.items[0], {
    item_id: 'DEMO-LIN-01', item_name: 'Linen Shirt', item_variant: 'M / Sand', item_brand: 'Demo Goods Co.',
    price: 53.1, discount: 5.9, quantity: 1,
  });
  const itemsValue = params.items.reduce((s, i) => s + i.price * i.quantity, 0);
  assert.equal(Math.round(itemsValue * 100), Math.round(params.value * 100));
  assert.deepEqual(built.problems, []);
});

test('no captured _ga: deterministic synthetic client_id, flagged, with the partial-reporting note', () => {
  const { order, built } = build('o06');
  assert.equal(built.client_id_source, 'synthetic');
  assert.equal(built.payload.client_id, syntheticClientId(SHOP, order.id));
  assert.equal(built.payload.events[0].params.client_id_source, 'synthetic');
  assert.ok(built.notes.includes(PARTIAL_REPORTING_NOTE));
  assert.equal(built.payload.events[0].params.ai_label_status, 'unconfirmed');
});

test('an unparseable _ga value falls back to synthetic with a note', () => {
  const base = fx('o01').payload;
  const order = { ...base, note_attributes: [{ name: '_ga', value: 'garbage' }] };
  const { built } = build('o01', { order });
  assert.equal(built.client_id_source, 'synthetic');
  assert.match(built.notes[0], /not a GA client id/);
});

test('multi-currency: shop money by default, presentment money when configured', () => {
  const shop = build('o10').built.payload.events[0].params;
  assert.equal(shop.currency, 'USD');
  const pres = build('o10', { capture: { ...capture, money_source: 'presentment' } }).built.payload.events[0].params;
  assert.equal(pres.currency, 'CAD');
  assert.ok(pres.value > shop.value);
});

test('long item names are truncated to 100 characters and noted', () => {
  const { built } = build('o23');
  const item = built.payload.events[0].params.items[0];
  assert.equal(item.item_name.length, 100);
  assert.ok(built.notes.some((n) => n.includes('truncated')));
  assert.deepEqual(built.problems, []);
});

test('numeric captured session id is passed as session_id', () => {
  const base = fx('o01').payload;
  const order = { ...base, note_attributes: [...base.note_attributes, { name: 'ga_session_id', value: '1790000000' }] };
  assert.equal(build('o01', { order }).built.payload.events[0].params.session_id, 1790000000);
});

test('order without id is refused: transaction_id must never be empty', () => {
  const { payload } = fx('o01');
  const classification = { channel: 'web', confidence: 'medium', rule_confirmed: true, checkout: 'store' };
  for (const id of [undefined, null, '', '  ']) {
    assert.throws(() => buildPurchasePayload({ ...payload, id }, classification, { capture, shopDomain: SHOP }), /transaction_id/);
  }
});

test('validateMpPayload flags each documented limit', () => {
  const ok = { client_id: '1.2', events: [{ name: 'purchase', params: { transaction_id: 't1', value: 1, currency: 'USD', items: [{ item_id: 'a' }] } }] };
  assert.deepEqual(validateMpPayload(ok), []);
  const p = (mutate) => {
    const c = structuredClone(ok);
    mutate(c);
    return validateMpPayload(c).join(' | ');
  };
  assert.match(p((c) => delete c.client_id), /client_id is missing/);
  assert.match(p((c) => { c.events = Array.from({ length: 26 }, () => ok.events[0]); }), /26 events > 25/);
  assert.match(p((c) => { for (let i = 0; i < 25; i++) c.events[0].params[`p${i}`] = 1; }), /params > 25/);
  assert.match(p((c) => { c.events[0].params['1bad'] = 1; }), /invalid parameter name/);
  assert.match(p((c) => { c.events[0].params['x'.repeat(41)] = 1; }), /invalid parameter name/);
  assert.match(p((c) => { c.events[0].params.note = 'x'.repeat(101); }), /longer than 100/);
  assert.match(p((c) => { c.events[0].params.transaction_id = ''; }), /transaction_id must be a non-empty string/);
  assert.match(p((c) => { delete c.events[0].params.currency; }), /currency is required/);
  assert.match(p((c) => { c.events[0].name = '_bad'; }), /not a valid event name/);
  assert.match(p((c) => { c.events[0].params.items = [{}]; }), /item_id or item_name is required/);
  assert.match(p((c) => { for (let i = 0; i < 11; i++) c.events[0].params.items[0][`c${i}`] = 'v'; }), /11 custom params > 10/);
  assert.match(p((c) => { c.events[0].params.items = Array.from({ length: 2000 }, (_, i) => ({ item_id: `id-${i}`, item_name: 'n'.repeat(60) })); }), /must be under 130000/);
  // session_id is exempt from the 100-character cap
  assert.deepEqual(validateMpPayload({ ...ok, events: [{ ...ok.events[0], params: { ...ok.events[0].params, session_id: 'x'.repeat(120) } }] }), []);
});

test('decideGa4: direct checkout is sent even with a synthetic client id', () => {
  const { classification, built, now } = build('o06');
  assert.equal(classification.checkout, 'direct');
  const d = decideGa4({ classification, built, capture, now });
  assert.equal(d.action, 'send');
  assert.match(d.reason, /GA4 tags do not fire/);
});

test('decideGa4: store checkout sends only with a captured client id', () => {
  const withCid = build('o03');
  assert.equal(decideGa4({ ...withCid, capture }).action, 'send');
  const noCid = build('o05');
  const d = decideGa4({ ...noCid, capture });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /across different client_ids is not documented/);
});

test('decideGa4: unknown checkout follows its own policy', () => {
  const shop = build('o13');
  assert.equal(shop.classification.checkout, 'unknown');
  assert.equal(decideGa4({ ...shop, capture }).action, 'skip');
  const always = { ...capture, ga4: { ...capture.ga4, policy: { ...capture.ga4.policy, unknown: 'send' } } };
  assert.equal(decideGa4({ ...shop, capture: always }).action, 'send');
  const never = { ...capture, ga4: { ...capture.ga4, policy: { ...capture.ga4.policy, direct: 'never' } } };
  assert.equal(decideGa4({ ...build('o06'), capture: never }).action, 'skip');
});

test('decideGa4: no backfill beyond the 72-hour backdating window', () => {
  const b = build('o08');
  const created = Date.parse(b.order.created_at);
  assert.equal(decideGa4({ ...b, capture, now: created + 71.9 * 3_600_000 }).action, 'send');
  const late = decideGa4({ ...b, capture, now: created + 72.1 * 3_600_000 });
  assert.equal(late.action, 'skip');
  assert.match(late.reason, /backdates at most 72 h/);
});

test('decideGa4: a payload that breaks MP limits is not sent', () => {
  const b = build('o06');
  const d = decideGa4({ ...b, built: { ...b.built, problems: ['x'] }, capture });
  assert.equal(d.action, 'skip');
});

test('resolveGa4Mode: dry-run unless both env vars AND a flag are present', () => {
  const env = { GA4_MEASUREMENT_ID: 'G-TEST', GA4_API_SECRET: 's' };
  assert.equal(resolveGa4Mode({ argv: [], env }).mode, 'dry-run');
  assert.equal(resolveGa4Mode({ argv: ['--send'], env: {} }).mode, 'dry-run');
  assert.equal(resolveGa4Mode({ argv: ['--send'], env: { GA4_MEASUREMENT_ID: 'G-TEST' } }).mode, 'dry-run');
  assert.equal(resolveGa4Mode({ argv: ['--send'], env }).mode, 'send');
  assert.equal(resolveGa4Mode({ argv: ['--validate'], env }).mode, 'validate');
  assert.equal(resolveGa4Mode({ argv: ['--validate', '--send'], env }).mode, 'validate', 'validate wins over send');
  assert.equal(resolveGa4Mode({ argv: ['--validate'], env: {} }).mode, 'dry-run');
});

test('mpUrl: /mp/collect, /debug/mp/collect and the EU host', () => {
  assert.equal(mpUrl({ mode: 'send', measurementId: 'G-1', apiSecret: 's' }), 'https://www.google-analytics.com/mp/collect?measurement_id=G-1&api_secret=s');
  assert.equal(mpUrl({ mode: 'validate', measurementId: 'G-1', apiSecret: 's' }), 'https://www.google-analytics.com/debug/mp/collect?measurement_id=G-1&api_secret=s');
  assert.match(mpUrl({ mode: 'send', measurementId: 'G-1', apiSecret: 's', region: 'eu' }), /^https:\/\/region1\.google-analytics\.com\/mp\/collect/);
});

test('postToGa4 posts JSON; validate mode adds ENFORCE_RECOMMENDATIONS and returns messages', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, json: async () => ({ validationMessages: [{ fieldPath: 'events', validationCode: 'NAME_INVALID' }] }) };
  };
  const env = { GA4_MEASUREMENT_ID: 'G-TEST', GA4_API_SECRET: 'sec' };
  const { built } = build('o06');
  const v = await postToGa4(built.payload, { mode: 'validate', env, fetchImpl });
  assert.match(calls[0].url, /\/debug\/mp\/collect\?measurement_id=G-TEST&api_secret=sec$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body).validation_behavior, 'ENFORCE_RECOMMENDATIONS');
  assert.equal(v.validation_messages[0].validationCode, 'NAME_INVALID');
  const s = await postToGa4(built.payload, { mode: 'send', env, fetchImpl });
  assert.match(calls[1].url, /\/mp\/collect\?/);
  assert.doesNotMatch(calls[1].url, /debug/);
  assert.equal(JSON.parse(calls[1].init.body).validation_behavior, undefined);
  assert.equal(s.status, 200);
});

test('postToGa4 refuses to post in dry-run or without credentials', async () => {
  const fetchImpl = async () => assert.fail('fetch must not be called');
  await assert.rejects(postToGa4({}, { mode: 'dry-run', env: { GA4_MEASUREMENT_ID: 'G', GA4_API_SECRET: 's' }, fetchImpl }), /refuses/);
  await assert.rejects(postToGa4({}, { mode: 'send', env: {}, fetchImpl }), /required/);
});

test('refund payload: value from successful refund transactions, keyed by the order id', () => {
  const { refund } = fx('o09');
  const r = buildRefundPayload(refund, { clientId: '1.2', clientIdSource: 'synthetic', capture, now: Date.parse(refund.created_at) + 1000 });
  const ev = r.payload.events[0];
  assert.equal(ev.name, 'refund');
  assert.equal(ev.params.transaction_id, String(refund.order_id));
  assert.equal(ev.params.value, 34.56);
  assert.equal(ev.params.currency, 'USD');
  assert.deepEqual(ev.params.items, [{ item_id: 'DEMO-TOT-04', quantity: 1 }]);
  assert.deepEqual(r.problems, []);
});

test('refund without a money transaction falls back to line subtotals', () => {
  const { refund } = fx('o09');
  const r = buildRefundPayload({ ...refund, transactions: [] }, { clientId: '1.2', clientIdSource: 'synthetic', capture, shopCurrency: 'USD' });
  assert.equal(r.payload.events[0].params.value, 32);
});
