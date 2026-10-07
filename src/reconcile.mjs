// Weekly reconciliation: Shopify orders (source of truth) vs GA4 purchases vs what the
// capture pipeline decided. Shopify advises a periodic job that fetches anything the
// webhooks missed; orders with no ledger entry are flagged and evaluated here instead.
//
// Inputs
//   orders   JSON array of orders in REST/webhook shape (optionally with a "graphql" object
//            holding Admin API fields), or a CSV with the columns listed in README.md
//   ga4      CSV with a transaction_id column ("Transaction ID" in a GA4 Explore export works;
//            lines starting with # are skipped)
//   ledger   JSONL written by the server
// Outputs
//   reconciliation.csv          one row per channel plus TOTAL
//   reconciliation-orders.csv   one row per order (and per GA4-only transaction) with the
//                               reason for every gap

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHANNELS, classifyOrder, loadRules } from './classify.mjs';
import { DEFAULT_CAPTURE_PATH, DEFAULT_RULES_PATH, loadCaptureConfig } from './config.mjs';
import { csvToObjects, toCsv } from './csv.mjs';
import { evaluateEligibility } from './eligibility.mjs';
import { readJsonl } from './ledger.mjs';
import { formatMinor, moneyOf, toMinor } from './order.mjs';

export const SUMMARY_COLUMNS = [
  'channel', 'orders', 'currency', 'revenue', 'refunded', 'net_revenue',
  'in_ga4', 'missing_from_ga4', 'mp_built_not_sent', 'mp_sent', 'mp_skipped',
  'eligible_meta', 'eligible_google_ads', 'eligible_openai', 'no_ad_identifier',
  'unconfirmed_labels', 'not_in_ledger',
];

export const ORDER_COLUMNS = [
  'order_id', 'order_name', 'created_at', 'channel', 'label_status', 'rule_id', 'confidence',
  'checkout', 'currency', 'revenue', 'refunded', 'net_revenue', 'in_ga4', 'ga4_status',
  'client_id_source', 'ga4_gap', 'ga4_refund', 'meta', 'meta_reason', 'google_ads',
  'google_ads_reason', 'openai', 'openai_reason', 'in_ledger', 'label_note',
];

// ---------- loading ----------

const truthy = (v) => ['true', 'yes', '1'].includes(String(v ?? '').trim().toLowerCase());
const blank = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

function csvRowToOrder(r) {
  const graphql = {
    attribution: blank(r.attribution_handle) || blank(r.attribution_display_name)
      ? { handle: blank(r.attribution_handle), displayName: blank(r.attribution_display_name) }
      : null,
    app: blank(r.app_name) ? { name: blank(r.app_name) } : null,
    publication: blank(r.publication_title) ? { catalog: { title: blank(r.publication_title) } } : null,
  };
  return {
    id: blank(r.id),
    name: blank(r.name),
    created_at: blank(r.created_at),
    currency: blank(r.currency),
    total_price: blank(r.total_price),
    financial_status: blank(r.financial_status),
    test: truthy(r.test),
    source_name: blank(r.source_name),
    landing_site: blank(r.landing_site),
    referring_site: blank(r.referring_site),
    total_refunded: blank(r.total_refunded),
    graphql,
  };
}

export function loadShopifyOrders(path) {
  const text = readFileSync(path, 'utf8');
  if (path.toLowerCase().endsWith('.csv')) return csvToObjects(text).map(csvRowToOrder);
  const json = JSON.parse(text);
  return Array.isArray(json) ? json : (json.orders ?? []);
}

/** transaction_id -> row */
export function loadGa4Export(path) {
  const rows = csvToObjects(readFileSync(path, 'utf8'));
  if (rows.length && !('transaction_id' in rows[0])) {
    throw new Error(`${path}: no transaction_id column (found: ${Object.keys(rows[0]).join(', ')})`);
  }
  const out = new Map();
  for (const r of rows) {
    const id = blank(r.transaction_id);
    if (id && id !== '(not set)') out.set(id, r);
  }
  return out;
}

// ---------- money ----------

export function refundedMinor(order) {
  const currency = order.currency;
  if (blank(order.total_refunded) !== null) return toMinor(order.total_refunded, currency);
  let minor = 0;
  for (const refund of order.refunds ?? []) {
    const txs = (refund.transactions ?? []).filter((t) => t.kind === 'refund' && (!t.status || t.status === 'success'));
    if (txs.length && txs.every((t) => t.currency === currency)) {
      for (const t of txs) minor += toMinor(t.amount, currency);
      continue;
    }
    for (const r of refund.refund_line_items ?? []) {
      minor += (moneyOf(r, 'subtotal', 'shop', currency)?.minor ?? 0) + (moneyOf(r, 'total_tax', 'shop', currency)?.minor ?? 0);
    }
  }
  return minor;
}

// ---------- ledger ----------

/** order id -> { captured, waiting, refunds[] } from ledger records */
export function indexLedger(records) {
  const byOrder = new Map();
  const get = (id) => {
    if (!byOrder.has(id)) byOrder.set(id, { captured: null, waiting: null, refunds: [] });
    return byOrder.get(id);
  };
  for (const r of records) {
    if (!r?.order_id) continue;
    const entry = get(String(r.order_id));
    if (r.outcome === 'captured') entry.captured = r;
    else if (r.outcome === 'waiting') entry.waiting = r;
    else if (r.outcome === 'refund') entry.refunds.push(r);
  }
  return byOrder;
}

// ---------- reconciliation ----------

function ga4Gap({ inGa4, ga4, classification, inLedger }) {
  if (inGa4) {
    if (classification.checkout === 'direct' && !['sent', 'validated'].includes(ga4?.status)) {
      return 'in GA4 although labelled direct checkout, where GA4 tags do not fire: check the channel label';
    }
    return '';
  }
  if (!inLedger) {
    return 'no webhook in the ledger for this order: fetch it from the Admin API and capture it';
  }
  switch (ga4?.status) {
    case 'built_dry_run': return 'MP purchase built in dry run; nothing was sent';
    case 'validated': return 'MP purchase only validated against /debug/mp/collect; nothing was recorded';
    case 'sent': return 'sent with MP but not in the export: check measurement ID and API secret (MP answers 2xx even for bad events), the export date range and GA4 processing delay';
    case 'send_failed': return `MP send failed: ${ga4.error}`;
    case 'skipped': return `not sent: ${ga4.reason}`;
    case 'waiting': return `not captured yet: ${ga4.reason}`;
    default: return 'no GA4 decision recorded';
  }
}

const platformCell = (d) => (d ? (d.eligible ? 'eligible' : 'skip') : '');

/**
 * @param {object} p
 * @param {object[]} p.orders
 * @param {Map<string, object>} p.ga4  transaction_id -> row
 * @param {object[]} p.ledgerRecords
 * @param {object} p.rules  compiled rules (for orders missing from the ledger)
 * @param {object} p.capture
 * @param {string} p.from  ISO start (inclusive)
 * @param {string} p.to    ISO end (exclusive)
 */
export function reconcile({ orders, ga4, ledgerRecords, rules, capture, from, to }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new Error('reconcile: invalid from/to window');
  const ledger = indexLedger(ledgerRecords);
  const rows = [];
  const excluded = [];
  const exportIds = new Set();

  for (const order of orders) {
    const id = String(order.id);
    exportIds.add(id);
    const created = Date.parse(order.created_at);
    if (!(created >= fromMs && created < toMs)) continue;
    if (order.test) {
      excluded.push({ order_id: id, reason: 'test order' });
      continue;
    }
    const entry = ledger.get(id);
    const record = entry?.captured ?? entry?.waiting ?? null;
    let classification;
    let ga4Info;
    let platforms;
    if (record) {
      classification = record.classification;
      ga4Info = record.outcome === 'captured' ? record.ga4 : { status: 'waiting', reason: record.reason };
      platforms = record.platforms;
    } else {
      // Missed webhook: evaluate as the pipeline would have at order time.
      classification = classifyOrder(order, { rules, enrichment: order.graphql ?? null, capture });
      platforms = evaluateEligibility(order, classification, { capture, now: created });
      ga4Info = null;
    }

    const currency = order.currency;
    const revenue = moneyOf(order, 'total_price', 'shop', currency)?.minor ?? 0;
    const refunded = refundedMinor(order);
    const inGa4 = ga4.has(id);
    const refundNote = (entry?.refunds ?? [])
      .map((r) => `${r.ga4?.status ?? r.ga4?.decision} ${r.ga4?.value ?? ''} ${r.ga4?.currency ?? ''}`.trim())
      .join('; ');

    rows.push({
      order_id: id,
      order_name: order.name ?? '',
      created_at: order.created_at,
      channel: classification.channel,
      label_status: !classification.rule_id ? 'no_rule' : classification.rule_confirmed ? 'confirmed' : 'unconfirmed',
      rule_id: classification.rule_id ?? '',
      confidence: classification.confidence,
      checkout: classification.checkout,
      currency,
      revenue_minor: revenue,
      refunded_minor: refunded,
      revenue: formatMinor(revenue, currency),
      refunded: formatMinor(refunded, currency),
      net_revenue: formatMinor(revenue - refunded, currency),
      in_ga4: inGa4 ? 'yes' : 'no',
      ga4_status: ga4Info?.status ?? 'no_webhook',
      client_id_source: ga4Info?.client_id_source ?? '',
      ga4_gap: ga4Gap({ inGa4, ga4: ga4Info, classification, inLedger: Boolean(record) }),
      ga4_refund: refundNote,
      meta: platformCell(platforms?.meta),
      meta_reason: platforms?.meta?.reason ?? '',
      google_ads: platformCell(platforms?.google_ads),
      google_ads_reason: platforms?.google_ads?.reason ?? '',
      openai: platformCell(platforms?.openai),
      openai_reason: platforms?.openai?.reason ?? '',
      in_ledger: record ? 'yes' : 'no',
      label_note: classification.note ?? '',
      _platforms: platforms,
    });
  }

  const ga4Only = [...ga4.keys()].filter((tid) => !exportIds.has(tid)).map((tid) => ({
    order_id: tid,
    channel: '(ga4_only)',
    in_ga4: 'yes',
    ga4_gap: 'in GA4 but not in the Shopify export: a test or deleted order, or a transaction_id that is not the Shopify order id',
  }));

  return { summary: summarize(rows), orders: rows, ga4_only: ga4Only, excluded };
}

function summarize(rows) {
  const make = (channel) => ({
    channel, orders: 0, currency: null, revenue_minor: 0, refunded_minor: 0,
    in_ga4: 0, missing_from_ga4: 0, mp_built_not_sent: 0, mp_sent: 0, mp_skipped: 0,
    eligible_meta: 0, eligible_google_ads: 0, eligible_openai: 0, no_ad_identifier: 0,
    unconfirmed_labels: 0, not_in_ledger: 0,
  });
  const byChannel = new Map(CHANNELS.map((c) => [c, make(c)]));
  const total = make('TOTAL');
  for (const r of rows) {
    for (const s of [byChannel.get(r.channel), total]) {
      s.orders += 1;
      s.currency = s.currency === null || s.currency === r.currency ? r.currency : 'MIXED';
      s.revenue_minor += r.revenue_minor;
      s.refunded_minor += r.refunded_minor;
      if (r.in_ga4 === 'yes') s.in_ga4 += 1;
      else s.missing_from_ga4 += 1;
      if (r.ga4_status === 'built_dry_run' || r.ga4_status === 'validated') s.mp_built_not_sent += 1;
      if (r.ga4_status === 'sent') s.mp_sent += 1;
      if (r.ga4_status === 'skipped') s.mp_skipped += 1;
      const p = r._platforms ?? {};
      if (p.meta?.eligible) s.eligible_meta += 1;
      if (p.google_ads?.eligible) s.eligible_google_ads += 1;
      if (p.openai?.eligible) s.eligible_openai += 1;
      if (!p.meta?.eligible && !p.google_ads?.eligible && !p.openai?.eligible) s.no_ad_identifier += 1;
      if (r.label_status === 'unconfirmed') s.unconfirmed_labels += 1;
      if (r.in_ledger === 'no') s.not_in_ledger += 1;
    }
  }
  const finish = (s) => {
    const cur = s.currency && s.currency !== 'MIXED' ? s.currency : 'USD';
    return {
      ...s,
      currency: s.currency ?? '',
      revenue: formatMinor(s.revenue_minor, cur),
      refunded: formatMinor(s.refunded_minor, cur),
      net_revenue: formatMinor(s.revenue_minor - s.refunded_minor, cur),
    };
  };
  return [...[...byChannel.values()].filter((s) => s.orders > 0).map(finish), finish(total)];
}

export function writeReconciliation(result, outDir) {
  mkdirSync(outDir, { recursive: true });
  const summaryPath = join(outDir, 'reconciliation.csv');
  const ordersPath = join(outDir, 'reconciliation-orders.csv');
  writeFileSync(summaryPath, toCsv(result.summary, SUMMARY_COLUMNS));
  writeFileSync(ordersPath, toCsv([...result.orders, ...result.ga4_only], ORDER_COLUMNS));
  return { summaryPath, ordersPath };
}

// ---------- CLI ----------

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

async function main() {
  const argv = process.argv.slice(2);
  const ordersPath = arg(argv, 'orders');
  const ga4Path = arg(argv, 'ga4');
  if (!ordersPath || !ga4Path) {
    console.error('usage: node src/reconcile.mjs --orders <orders.json|csv> --ga4 <ga4.csv> [--ledger data/ledger.jsonl] [--from ISO] [--to ISO] [--out out]');
    process.exit(2);
  }
  const to = arg(argv, 'to', new Date().toISOString());
  const from = arg(argv, 'from', new Date(Date.parse(to) - 7 * 24 * 3600 * 1000).toISOString());
  const result = reconcile({
    orders: loadShopifyOrders(ordersPath),
    ga4: loadGa4Export(ga4Path),
    ledgerRecords: readJsonl(arg(argv, 'ledger', 'data/ledger.jsonl')),
    rules: loadRules(arg(argv, 'rules', DEFAULT_RULES_PATH)),
    capture: loadCaptureConfig(arg(argv, 'capture', DEFAULT_CAPTURE_PATH)),
    from,
    to,
  });
  const { summaryPath, ordersPath: out2 } = writeReconciliation(result, arg(argv, 'out', 'out'));
  console.log(`wrote ${summaryPath} and ${out2}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
