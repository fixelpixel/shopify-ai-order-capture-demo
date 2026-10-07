import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { buildSignals, CHANNELS, classifyOrder, compileRules, loadRules, UNCONFIRMED_NOTE } from '../src/classify.mjs';
import { loadCaptureConfig } from '../src/config.mjs';

const rules = loadRules();
const capture = loadCaptureConfig();
const rawRules = JSON.parse(readFileSync(new URL('../config/channel-rules.json', import.meta.url), 'utf8'));

const order = (extra = {}) => ({ id: 1, source_name: 'synthetic_source', landing_site: null, referring_site: null, note_attributes: [], ...extra });
const classify = (o, enrichment = null) => classifyOrder(o, { rules, enrichment, capture });

// One input per rule. Every rule in config/channel-rules.json must appear here.
const CASES = {
  'google-ai-order-source': [order(), { attribution: { handle: 'x-ai-mode', displayName: null } }],
  'copilot-order-source': [order(), { attribution: { displayName: 'Microsoft Copilot' } }],
  'meta-ai-order-source': [order(), { attribution: { displayName: 'Meta' } }],
  'meta-sales-channel-app': [order(), { app: { name: 'Facebook & Instagram by Meta' } }],
  'shop-order-source': [order(), { publication: { catalog: { title: 'Shop' } } }],
  'chatgpt-order-source': [order({ source_name: 'chatgpt' }), null],
  'chatgpt-ads-oppref': [order({ source_name: 'web', landing_site: '/p?oppref=gAAAA123' }), null],
  'chatgpt-utm-source': [order({ source_name: 'web', landing_site: '/p?utm_source=chatgpt.com' }), null],
  'chatgpt-referrer': [order({ source_name: 'web', referring_site: 'https://chatgpt.com/' }), null],
  'gemini-referrer': [order({ source_name: 'web', referring_site: 'https://gemini.google.com/app' }), null],
  'copilot-referrer': [order({ source_name: 'web', referring_site: 'https://copilot.microsoft.com/' }), null],
  'meta-ai-referrer': [order({ source_name: 'web', referring_site: 'https://www.meta.ai/' }), null],
  'shop-referrer': [order({ source_name: 'web', referring_site: 'https://shop.com/' }), null],
  'agentic-commerce-utm': [order({ source_name: 'web', landing_site: '/cart/c/x?utm_medium=agentic_commerce' }), null],
  'other-ai-referrer': [order({ source_name: 'web', referring_site: 'https://www.perplexity.ai/search' }), null],
  'online-store-web': [order({ source_name: 'web' }), null],
};

test('every configured rule has a test case', () => {
  assert.deepEqual(Object.keys(CASES).sort(), rules.rules.map((r) => r.id).sort());
});

for (const rule of rawRules.rules) {
  test(`rule ${rule.id} -> ${rule.channel} (${rule.confirmed ? 'confirmed' : 'unconfirmed'})`, () => {
    const [o, enrichment] = CASES[rule.id];
    const r = classify(o, enrichment);
    assert.equal(r.rule_id, rule.id);
    assert.equal(r.channel, rule.channel);
    assert.equal(r.confidence, rule.confidence);
    assert.equal(r.rule_confirmed, rule.confirmed);
    assert.ok(CHANNELS.includes(r.channel));
    if (rule.confirmed) {
      assert.ok(!(r.note ?? '').includes('unconfirmed'), 'confirmed rules carry no unconfirmed note');
      assert.ok(rule.sources.length > 0, 'confirmed rules cite a source');
    } else {
      assert.ok(r.note.includes(UNCONFIRMED_NOTE), 'unconfirmed rules say so in the result');
      assert.equal(rule.status, UNCONFIRMED_NOTE);
    }
  });
}

test('only rules backed by a documented signal are confirmed', () => {
  const confirmed = rawRules.rules.filter((r) => r.confirmed).map((r) => r.id).sort();
  assert.deepEqual(confirmed, ['chatgpt-ads-oppref', 'chatgpt-utm-source', 'online-store-web']);
  for (const r of rawRules.rules) {
    const readsOrderSourceFields = r.any.some((c) => (c.fields ?? [c.field]).some((f) => /^(attribution|app|publication)\./.test(f)));
    if (readsOrderSourceFields) assert.equal(r.confirmed, false, `${r.id} reads undocumented order values`);
  }
});

test('order-source attribution outranks marketing signals, and the others are listed', () => {
  const o = order({ source_name: 'web', landing_site: '/p?utm_source=chatgpt.com' });
  const r = classify(o, { attribution: { displayName: 'Microsoft Copilot' } });
  assert.equal(r.channel, 'copilot');
  assert.deepEqual(r.also_matched.map((m) => m.rule_id), ['chatgpt-utm-source', 'online-store-web']);
});

test('direct-checkout rule becomes store checkout when the order shows a storefront session', () => {
  const direct = classify(order(), { attribution: { displayName: 'Microsoft Copilot' } });
  assert.equal(direct.checkout, 'direct');
  const withSession = classify(order({ landing_site: '/products/x' }), { attribution: { displayName: 'Microsoft Copilot' } });
  assert.equal(withSession.checkout, 'store');
  assert.match(withSession.note, /storefront session/);
  const withAttr = classify(order({ note_attributes: [{ name: '_ga', value: 'GA1.1.1.2' }] }), { attribution: { displayName: 'Copilot' } });
  assert.equal(withAttr.checkout, 'store');
});

test('a bare "Google" app name is not labelled google_ai (Google & YouTube orders stay out)', () => {
  const r = classify(order(), { app: { name: 'Google & YouTube' } });
  assert.equal(r.channel, 'unknown');
});

test('meta pattern needs an exact Meta / Meta AI / Muse value', () => {
  assert.equal(classify(order(), { attribution: { displayName: 'Meta AI' } }).rule_id, 'meta-ai-order-source');
  assert.equal(classify(order(), { app: { name: 'Muse' } }).rule_id, 'meta-ai-order-source');
  assert.equal(classify(order(), { attribution: { displayName: 'Metamorphic Goods' } }).channel, 'unknown');
});

test('host_in matches subdomains but not look-alike domains', () => {
  assert.equal(classify(order({ referring_site: 'https://www.perplexity.ai/' })).channel, 'other_agent');
  assert.equal(classify(order({ referring_site: 'https://notperplexity.ai/' })).channel, 'unknown');
  assert.equal(classify(order({ referring_site: 'https://chatgpt.com.evil.example/' })).channel, 'unknown');
});

test('oppref captured only as a cart attribute (from the __oppref cookie) still counts', () => {
  const r = classify(order({ source_name: 'web', note_attributes: [{ name: '__oppref', value: 'gAAAAZ' }] }));
  assert.equal(r.rule_id, 'chatgpt-ads-oppref');
});

test('customer-journey visit fills in UTM and referrer when the webhook has none', () => {
  const enrichment = {
    customerJourneySummary: {
      lastVisit: { referrerUrl: null, landingPage: 'https://demo-store.example/p', utmParameters: { source: 'chatgpt.com', medium: null } },
    },
  };
  const r = classify(order({ source_name: 'web' }), enrichment);
  assert.equal(r.rule_id, 'chatgpt-utm-source');
  const s = buildSignals(order(), { customerJourneySummary: { lastVisit: { referrerUrl: 'https://gemini.google.com/' } } }, capture);
  assert.equal(s.referrer_host, 'gemini.google.com');
});

test('utm_source must equal chatgpt.com exactly (case-insensitive)', () => {
  assert.equal(classify(order({ landing_site: '/?utm_source=ChatGPT.com' })).rule_id, 'chatgpt-utm-source');
  assert.notEqual(classify(order({ landing_site: '/?utm_source=chatgpt.com.example' })).rule_id, 'chatgpt-utm-source');
});

test('no rule: unknown, with the signals that were seen and a note when enrichment was missing', () => {
  const r = classify(order({ source_name: 'synthetic_unknown_app' }));
  assert.equal(r.channel, 'unknown');
  assert.equal(r.rule_id, null);
  assert.equal(r.rule_confirmed, false);
  assert.match(r.reason, /source_name=synthetic_unknown_app/);
  assert.match(r.note, /no GraphQL enrichment/);
});

test('every fixture order classifies to its expected channel', () => {
  const dir = new URL('../fixtures/orders/', import.meta.url);
  for (const f of readdirSync(dir)) {
    const fx = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    if (fx.expected_channel === 'ignored') continue;
    const r = classify(fx.payload, fx.graphql);
    assert.equal(r.channel, fx.expected_channel, `${fx.ref}: ${r.reason}`);
  }
});

test('compileRules rejects bad configs', () => {
  const base = { id: 'r', channel: 'web', checkout: 'store', confidence: 'low', confirmed: true, sources: ['https://x.example'], any: [{ field: 'source_name', op: 'present' }] };
  const bad = (patch, msg) => assert.throws(() => compileRules({ rules: [{ ...base, ...patch }] }), msg);
  bad({ channel: 'perplexity' }, /channel must be one of/);
  bad({ channel: 'unknown' }, /channel must be one of/);
  bad({ checkout: 'maybe' }, /checkout must be/);
  bad({ confidence: 'certain' }, /confidence must be/);
  bad({ sources: [] }, /confirmed rule needs at least one source/);
  bad({ confirmed: false }, /must carry status/);
  bad({ any: [{ field: 'source_name', op: 'startsWith' }] }, /unknown op/);
  bad({ any: [{ field: 'source_name', op: 'matches', pattern: '(' }] }, /bad pattern/);
  bad({ any: [] }, /non-empty/);
  assert.throws(() => compileRules({ rules: [base, base] }), /duplicate id/);
});

test('"all" rules need every condition', () => {
  const compiled = compileRules({
    rules: [{
      id: 'both', channel: 'other_agent', checkout: 'store', confidence: 'low', confirmed: false, status: UNCONFIRMED_NOTE,
      all: [{ field: 'utm.source', op: 'equals', value: 'a' }, { field: 'utm.medium', op: 'equals', value: 'b' }],
    }],
  });
  const c = (landing) => classifyOrder(order({ landing_site: landing }), { rules: compiled, capture }).channel;
  assert.equal(c('/?utm_source=a&utm_medium=b'), 'other_agent');
  assert.equal(c('/?utm_source=a'), 'unknown');
});
