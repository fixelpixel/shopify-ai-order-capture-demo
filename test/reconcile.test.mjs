import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../src/classify.mjs';
import { loadCaptureConfig } from '../src/config.mjs';
import { csvToObjects, parseCsv, toCsv } from '../src/csv.mjs';
import { readJsonl } from '../src/ledger.mjs';
import { indexLedger, loadGa4Export, loadShopifyOrders, reconcile, refundedMinor } from '../src/reconcile.mjs';
import { runDemo } from '../scripts/demo.mjs';

const FIX = new URL('../fixtures/', import.meta.url);
const fixPath = (name) => new URL(name, FIX).pathname;
const meta = JSON.parse(readFileSync(fixPath('meta.json'), 'utf8'));
const rules = loadRules();
const capture = loadCaptureConfig();

let outDir;
let ledgerRecords;
before(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  await runDemo({ outDir, quiet: true, env: {} });
  ledgerRecords = readJsonl(join(outDir, 'ledger.jsonl'));
});

const run = (ordersFile = 'shopify-orders-export.json') => reconcile({
  orders: loadShopifyOrders(fixPath(ordersFile)),
  ga4: loadGa4Export(fixPath('ga4-purchases-export.csv')),
  ledgerRecords,
  rules,
  capture,
  from: meta.week.from,
  to: meta.week.to,
});

test('csv: quotes, escaped quotes, commas, CRLF and BOM', () => {
  const text = '\uFEFFa,b,c\r\n1,"x, y","say ""hi"""\r\n2,,"multi\nline"\n';
  assert.deepEqual(parseCsv(text), [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', '', 'multi\nline']]);
  const out = toCsv([{ a: 'x, y', b: 'say "hi"', c: '=SUM(A1)' }], ['a', 'b', 'c']);
  assert.equal(out, 'a,b,c\n"x, y","say ""hi""",\'=SUM(A1)\n');
  assert.deepEqual(parseCsv(out)[1], ['x, y', 'say "hi"', "'=SUM(A1)"]);
});

test('GA4 export: "#" preamble skipped, "Transaction ID" header normalised, (not set) dropped', () => {
  const rows = csvToObjects('# GA4\n# range\nTransaction ID,Purchase revenue\n123,4.00\n(not set),1.00\n');
  assert.deepEqual(rows[0], { transaction_id: '123', purchase_revenue: '4.00' });
  const ga4 = loadGa4Export(fixPath('ga4-purchases-export.csv'));
  assert.equal(ga4.size, 11);
  assert.ok(ga4.has('990000000101'));
});

test('GA4 export without a transaction_id column is rejected', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'ga4-')), 'bad.csv');
  writeFileSync(p, 'order,revenue\n1,2\n');
  assert.throws(() => loadGa4Export(p), /no transaction_id column/);
});

test('refunds: transactions in shop currency, CSV total_refunded, or refund line subtotals + tax', () => {
  const orders = loadShopifyOrders(fixPath('shopify-orders-export.json'));
  const o09 = orders.find((o) => o.name === '#D1009');
  assert.equal(refundedMinor(o09), 3456);
  assert.equal(refundedMinor({ currency: 'USD', total_refunded: '10.50' }), 1050);
  const foreign = { ...o09, refunds: [{ ...o09.refunds[0], transactions: [{ kind: 'refund', status: 'success', amount: '50.00', currency: 'CAD' }] }] };
  assert.equal(refundedMinor(foreign), 3456, 'falls back to shop-money line amounts');
});

test('ledger index keeps the captured record, the waiting record and refunds per order', () => {
  const idx = indexLedger(ledgerRecords);
  assert.equal(idx.get('990000000118').captured.topic, 'orders/paid');
  assert.equal(idx.get('990000000118').waiting.topic, 'orders/create');
  assert.equal(idx.get('990000000109').refunds.length, 1);
  assert.equal(idx.has('990000000124'), false, 'o24 never arrived');
});

test('reconciliation numbers on the fixtures, per channel', () => {
  const { summary, excluded, ga4_only } = run();
  const by = Object.fromEntries(summary.map((s) => [s.channel, s]));
  const pick = (s) => [s.orders, s.in_ga4, s.missing_from_ga4, s.mp_built_not_sent, s.mp_skipped, s.eligible_meta, s.eligible_google_ads, s.eligible_openai, s.unconfirmed_labels, s.not_in_ledger];
  //                                   orders in miss built skip meta gads oai unconf noledger
  assert.deepEqual(pick(by.chatgpt), [5, 3, 2, 2, 2, 1, 0, 2, 1, 1]);
  assert.deepEqual(pick(by.google_ai), [3, 0, 3, 3, 0, 0, 0, 0, 3, 0]);
  assert.deepEqual(pick(by.copilot), [3, 0, 3, 2, 1, 0, 0, 0, 3, 0]);
  assert.deepEqual(pick(by.meta_ai), [3, 0, 3, 2, 1, 0, 0, 0, 3, 0]);
  assert.deepEqual(pick(by.shop), [2, 1, 1, 1, 1, 0, 0, 0, 2, 0]);
  assert.deepEqual(pick(by.other_agent), [2, 1, 1, 1, 1, 0, 0, 0, 2, 0]);
  assert.deepEqual(pick(by.web), [5, 5, 0, 4, 1, 2, 2, 0, 0, 0]);
  assert.deepEqual(pick(by.unknown), [1, 0, 1, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(pick(by.TOTAL), [24, 10, 14, 16, 7, 3, 2, 2, 14, 1]);
  assert.equal(by.copilot.refunded, '34.56');
  assert.equal(by.copilot.net_revenue, (Number(by.copilot.revenue) - 34.56).toFixed(2));
  assert.equal(by.TOTAL.currency, 'USD');
  assert.equal(by.TOTAL.revenue, '2202.05');
  assert.equal(by.TOTAL.net_revenue, '2167.49');
  assert.equal(excluded.length, 1, 'the test order');
  assert.deepEqual(ga4_only.map((r) => r.order_id), ['990000009999']);
});

test('every order missing from GA4 has a reason', () => {
  const { orders } = run();
  const missing = orders.filter((r) => r.in_ga4 === 'no');
  assert.equal(missing.length, 14);
  for (const r of missing) assert.ok(r.ga4_gap.length > 10, `${r.order_name} has no gap reason`);
  const byName = Object.fromEntries(orders.map((r) => [r.order_name, r]));
  assert.match(byName['#D1006'].ga4_gap, /built in dry run/);
  assert.match(byName['#D1005'].ga4_gap, /without a captured client_id/);
  assert.match(byName['#D1022'].ga4_gap, /backdates at most 72 h/);
  assert.match(byName['#D1024'].ga4_gap, /no webhook in the ledger/);
  assert.equal(byName['#D1024'].in_ledger, 'no');
  assert.equal(byName['#D1024'].channel, 'chatgpt', 'missed orders are still classified from the export');
  assert.equal(byName['#D1009'].ga4_refund, 'built_dry_run 34.56 USD');
  assert.match(byName['#D1006'].meta_reason, /no fbp, no fbc/);
  assert.equal(byName['#D1023'].label_status, 'no_rule');
});

test('an order in GA4 but labelled direct checkout is flagged as a likely wrong label', () => {
  const orders = loadShopifyOrders(fixPath('shopify-orders-export.json'));
  const ga4 = loadGa4Export(fixPath('ga4-purchases-export.csv'));
  ga4.set('990000000106', { transaction_id: '990000000106' });
  const r = reconcile({ orders, ga4, ledgerRecords, rules, capture, from: meta.week.from, to: meta.week.to });
  const row = r.orders.find((x) => x.order_id === '990000000106');
  assert.equal(row.in_ga4, 'yes');
  assert.match(row.ga4_gap, /check the channel label/);
});

test('the CSV export gives the same per-channel totals as the JSON export', () => {
  const json = run('shopify-orders-export.json').summary;
  const csv = run('shopify-orders-export.csv').summary;
  const view = (rows) => rows.map((s) => [s.channel, s.orders, s.revenue, s.refunded, s.in_ga4, s.not_in_ledger]);
  assert.deepEqual(view(csv), view(json));
});

test('the week window filters by order creation time', () => {
  const r = reconcile({
    orders: loadShopifyOrders(fixPath('shopify-orders-export.json')),
    ga4: new Map(),
    ledgerRecords,
    rules,
    capture,
    from: '2026-10-02T00:00:00Z',
    to: '2026-10-03T00:00:00Z',
  });
  assert.equal(r.summary.at(-1).orders, 5, 'o18, o19, o20, o23, o25 (o21 is a test order)');
  assert.throws(() => reconcile({ orders: [], ga4: new Map(), ledgerRecords: [], rules, capture, from: 'x', to: 'y' }), /invalid from\/to/);
});
