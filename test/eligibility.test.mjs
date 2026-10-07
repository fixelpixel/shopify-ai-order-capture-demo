import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { classifyOrder, loadRules } from '../src/classify.mjs';
import { loadCaptureConfig } from '../src/config.mjs';
import { evaluateEligibility, extractIdentifiers } from '../src/eligibility.mjs';
import { toMinor } from '../src/order.mjs';

const capture = loadCaptureConfig();
const rules = loadRules();
const fx = (ref) => JSON.parse(readFileSync(new URL(`../fixtures/orders/${ref}.json`, import.meta.url), 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const WEB = { channel: 'web', confidence: 'medium', rule_confirmed: true, checkout: 'store' };
const NOW = Date.parse('2026-10-02T12:00:00Z');

function order({ attrs = {}, landing = '/', email = 'buyer@example.com', created = '2026-10-02T11:00:00Z', currency = 'USD', total = '42.00' } = {}) {
  return {
    id: 4242,
    email,
    created_at: created,
    currency,
    landing_site: landing,
    note_attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    order_status_url: 'https://demo-store.example/1/orders/secrettoken/authenticate?key=secrettoken',
    client_details: { browser_ip: '203.0.113.9', user_agent: 'Mozilla/5.0 (test)' },
    total_price: total,
    line_items: [{ id: 1, sku: 'SKU-1', title: 'Thing', quantity: 1, price: total, total_discount: '0.00' }],
  };
}
const decide = (o, classification = WEB, cfg = capture) => evaluateEligibility(o, classification, { capture: cfg, now: NOW });

// [description, order options, expected meta, google_ads, openai]
const MATRIX = [
  ['nothing captured, email without consent', {}, false, false, false],
  ['fbp cookie only', { attrs: { _fbp: 'fb.1.1.2' } }, true, false, false],
  ['fbc cookie only', { attrs: { _fbc: 'fb.1.1.abc' } }, true, false, false],
  ['fbclid in the landing URL', { landing: '/?fbclid=AbC' }, true, false, false],
  ['email with consent granted', { attrs: { _consent_marketing: 'granted' } }, true, false, false],
  ['email with consent denied', { attrs: { _consent_marketing: 'denied' } }, false, false, false],
  ['consent granted but no email', { attrs: { _consent_marketing: 'granted' }, email: null }, false, false, false],
  ['gclid in the landing URL', { landing: '/?gclid=G1' }, false, true, false],
  ['gbraid attribute', { attrs: { _gbraid: 'B1' } }, false, true, false],
  ['wbraid in the landing URL', { landing: '/?wbraid=W1' }, false, true, false],
  ['oppref in the landing URL', { landing: '/?oppref=gAAAA1' }, false, false, true],
  ['__oppref cookie attribute', { attrs: { __oppref: 'gAAAA2' } }, false, false, true],
  ['__obref without oppref', { attrs: { __obref: 'uuid' } }, false, false, false],
  ['everything', { landing: '/?gclid=G&oppref=O', attrs: { _fbp: 'fb.1.1.2', _consent_marketing: 'granted' } }, true, true, true],
];

for (const [name, opts, meta, gads, openai] of MATRIX) {
  test(`eligibility matrix: ${name}`, () => {
    const e = decide(order(opts));
    assert.equal(e.meta.eligible, meta, `meta: ${e.meta.reason}`);
    assert.equal(e.google_ads.eligible, gads, `google_ads: ${e.google_ads.reason}`);
    assert.equal(e.openai.eligible, openai, `openai: ${e.openai.reason}`);
    for (const d of [e.meta, e.google_ads, e.openai]) {
      assert.ok(d.reason.length > 0, 'every decision carries a reason');
      assert.equal(d.payload === null, !d.eligible, 'payload only when eligible');
    }
  });
}

test('skip reasons say what was missing', () => {
  const e = decide(order());
  assert.match(e.meta.reason, /no fbp, no fbc and no consented email \(email present but no consent signal was captured\)/);
  assert.match(e.google_ads.reason, /no gclid, gbraid or wbraid/);
  assert.match(e.openai.reason, /no oppref/);
  assert.match(decide(order({ attrs: { _consent_marketing: 'denied' } })).meta.reason, /consent was denied/);
});

test('email is normalised (trim, lowercase) and SHA-256 hashed; never sent raw', () => {
  const e = decide(order({ email: '  Buyer@Example.COM ', attrs: { _consent_marketing: 'granted' }, landing: '/?oppref=O' }));
  const h = sha('buyer@example.com');
  assert.deepEqual(e.meta.payload.body.data[0].user_data.em, [h]);
  assert.deepEqual(e.openai.payload.body.events[0].user.emails_sha256, [h]);
  for (const d of [e.meta, e.openai, e.google_ads]) assert.doesNotMatch(JSON.stringify(d.payload), /example\.com/i);
});

test('fbc built from fbclid uses fb.1.<order time ms>.<fbclid>, unmodified case; the cookie wins when present', () => {
  const o = order({ landing: '/?fbclid=AbC-Def' });
  const ids = extractIdentifiers(o, capture, NOW);
  assert.equal(ids.fbc, `fb.1.${Date.parse(o.created_at)}.AbC-Def`);
  assert.equal(ids.fbc_source, 'built_from_fbclid');
  const withCookie = extractIdentifiers(order({ landing: '/?fbclid=X', attrs: { _fbc: 'fb.1.5.cookie' } }), capture, NOW);
  assert.equal(withCookie.fbc, 'fb.1.5.cookie');
  assert.equal(withCookie.fbc_source, 'cookie');
});

test('Meta payload shape: Purchase, seconds, website needs source URL and user agent', () => {
  const e = decide(order({ attrs: { _fbp: 'fb.1.1.2' } }));
  const ev = e.meta.payload.body.data[0];
  assert.equal(ev.event_name, 'Purchase');
  assert.equal(ev.event_time, Math.floor(Date.parse('2026-10-02T11:00:00Z') / 1000));
  assert.equal(ev.event_id, '4242');
  assert.equal(ev.action_source, 'website');
  assert.equal(ev.event_source_url, 'https://demo-store.example/');
  assert.equal(ev.user_data.fbp, 'fb.1.1.2');
  assert.equal(ev.user_data.client_user_agent, 'Mozilla/5.0 (test)');
  assert.equal(ev.custom_data.value, 42);
  assert.equal(ev.custom_data.currency, 'USD');
  const noUa = decide({ ...order({ attrs: { _fbp: 'fb.1.1.2' } }), client_details: {} });
  assert.equal(noUa.meta.payload.body.data[0].action_source, 'other');
});

test('the order status URL (it carries the order token) is never sent to ad platforms', () => {
  const e = decide(order({ landing: '/?gclid=G&oppref=O', attrs: { _fbp: 'fb.1.1.2' } }));
  for (const d of [e.meta, e.google_ads, e.openai]) assert.doesNotMatch(JSON.stringify(d.payload), /secrettoken/);
});

test('Google Ads payload is a Data Manager API IngestEventsRequest', () => {
  const e = decide(order({ landing: '/?gclid=G1&gbraid=B1', attrs: { _consent_marketing: 'granted' } }));
  const p = e.google_ads.payload;
  assert.equal(p.endpoint, 'https://datamanager.googleapis.com/v1/events:ingest');
  assert.equal(p.body.destinations[0].operatingAccount.accountType, 'GOOGLE_ADS');
  assert.equal(p.body.validateOnly, true);
  const ev = p.body.events[0];
  assert.deepEqual(ev.adIdentifiers, { gclid: 'G1', gbraid: 'B1' });
  assert.equal(ev.transactionId, '4242');
  assert.equal(ev.conversionValue, 42);
  assert.equal(ev.currency, 'USD');
  assert.equal(ev.eventTimestamp, '2026-10-02T11:00:00.000Z');
  assert.deepEqual(ev.consent, { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_GRANTED' });
  const noConsent = decide(order({ landing: '/?gclid=G1' }));
  assert.equal(noConsent.google_ads.payload.body.events[0].consent, undefined);
});

test('ChatGPT Ads payload: order_created, ms timestamp, oppref at event level, obref in user, amount in minor units', () => {
  const e = decide(order({ landing: '/?oppref=gAAAA9', attrs: { __obref: 'ob-1' } }));
  const ev = e.openai.payload.body.events[0];
  assert.equal(e.openai.payload.endpoint, 'https://bzr.openai.com/v1/events?pid=<PIXEL_ID>');
  assert.equal(ev.type, 'order_created');
  assert.equal(ev.id, '4242');
  assert.equal(ev.timestamp_ms, Date.parse('2026-10-02T11:00:00Z'));
  assert.equal(ev.oppref, 'gAAAA9');
  assert.equal(ev.user.obref, 'ob-1');
  assert.equal(ev.user.emails_sha256, undefined, 'email needs consent');
  assert.equal(ev.action_source, 'web');
  assert.equal(ev.source_url, 'https://demo-store.example/');
  assert.equal(ev.data.type, 'contents');
  assert.equal(ev.data.amount, 4200);
  assert.equal(Number.isInteger(ev.data.amount), true);
});

test('obref is withheld when consent is denied', () => {
  const e = decide(order({ landing: '/?oppref=O', attrs: { __obref: 'ob-1', _consent_marketing: 'denied' } }));
  assert.equal(e.openai.eligible, true);
  assert.equal(e.openai.payload.body.events[0].user?.obref, undefined);
});

test('minor units follow the currency: USD 2, JPY 0, KWD 3 decimals', () => {
  assert.equal(toMinor('42.00', 'USD'), 4200);
  assert.equal(toMinor('4200', 'JPY'), 4200);
  assert.equal(toMinor('1.234', 'KWD'), 1234);
  assert.equal(toMinor('0.005', 'USD'), 1);
  const jpy = decide(order({ currency: 'JPY', total: '4200', landing: '/?oppref=O' }));
  assert.equal(jpy.openai.payload.body.events[0].data.amount, 4200);
  assert.equal(jpy.openai.payload.body.events[0].data.currency, 'JPY');
});

test('time windows: OpenAI and Meta take events from the last 7 days only', () => {
  const old = order({ created: '2026-09-24T11:00:00Z', landing: '/?oppref=O', attrs: { _fbp: 'fb.1.1.2' } });
  const e = decide(old);
  assert.equal(e.openai.eligible, false);
  assert.match(e.openai.reason, /last 7 days/);
  assert.equal(e.meta.eligible, false);
  assert.match(e.meta.reason, /7 days/);
  const future = decide(order({ created: '2026-10-02T12:30:00Z', landing: '/?oppref=O' }));
  assert.match(future.openai.reason, /future/);
});

test('require_for_all_ad_platforms: nothing is eligible without a granted consent signal', () => {
  const strict = { ...capture, consent: { ...capture.consent, require_for_all_ad_platforms: true } };
  const o = order({ landing: '/?gclid=G&oppref=O', attrs: { _fbp: 'fb.1.1.2' } });
  const e = decide(o, WEB, strict);
  assert.deepEqual([e.meta.eligible, e.google_ads.eligible, e.openai.eligible], [false, false, false]);
  const ok = decide(order({ landing: '/?gclid=G&oppref=O', attrs: { _fbp: 'fb.1.1.2', _consent_marketing: 'granted' } }), WEB, strict);
  assert.deepEqual([ok.meta.eligible, ok.google_ads.eligible, ok.openai.eligible], [true, true, true]);
});

test('a platform\'s own AI channel gets a double-counting note', () => {
  const meta = decide(order({ attrs: { _fbp: 'fb.1.1.2' } }), { ...WEB, channel: 'meta_ai' });
  assert.match(meta.meta.notes.join(' '), /counted twice/);
  const google = decide(order({ landing: '/?gclid=G' }), { ...WEB, channel: 'google_ai' });
  assert.match(google.google_ads.notes.join(' '), /counted twice/);
});

test('fixtures: AI direct-checkout orders carry no identifier, and nothing touches the network', () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network call during eligibility'); };
  try {
    const dir = new URL('../fixtures/orders/', import.meta.url);
    const eligible = { meta: [], google_ads: [], openai: [] };
    for (const f of readdirSync(dir).sort()) {
      const x = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      const classification = classifyOrder(x.payload, { rules, enrichment: x.graphql, capture });
      const e = evaluateEligibility(x.payload, classification, { capture, now: Date.parse(x.payload.created_at) + 5000 });
      for (const k of Object.keys(eligible)) if (e[k].eligible) eligible[k].push(x.ref);
      if (classification.checkout === 'direct') {
        assert.ok(!e.meta.eligible && !e.google_ads.eligible && !e.openai.eligible, `${x.ref} direct checkout should have no identifier`);
      }
    }
    assert.deepEqual(eligible, { meta: ['o01', 'o04', 'o20'], google_ads: ['o01', 'o19'], openai: ['o04', 'o25'] });
  } finally {
    globalThis.fetch = realFetch;
  }
});
