#!/usr/bin/env node
// Runs the synthetic fixtures end to end through the real HTTP server:
// signed POSTs -> verify -> dedup -> classify -> GA4 payload -> eligibility -> ledger,
// then the weekly reconciliation. Writes out/ledger.jsonl, out/reconciliation.csv and
// out/reconciliation-orders.csv, and prints a short summary.
//
//   node scripts/demo.mjs [--out out] [--validate | --send]
//
// Dry run by default. --validate / --send only take effect when GA4_MEASUREMENT_ID and
// GA4_API_SECRET are set; nothing is ever sent to Meta, Google Ads or OpenAI.

import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../src/classify.mjs';
import { loadCaptureConfig } from '../src/config.mjs';
import { createDedupGuard, MemoryDedupStore } from '../src/dedup.mjs';
import { mapEnricher } from '../src/enrich.mjs';
import { resolveGa4Mode } from '../src/ga4.mjs';
import { createJsonlLedger, readJsonl } from '../src/ledger.mjs';
import { createPipeline } from '../src/pipeline.mjs';
import { loadGa4Export, loadShopifyOrders, reconcile, writeReconciliation } from '../src/reconcile.mjs';
import { createCaptureServer, WEBHOOK_PATH } from '../src/server.mjs';
import { computeShopifyHmac } from '../src/verify.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIX = join(ROOT, 'fixtures');

export async function runDemo({ outDir = join(ROOT, 'out'), argv = [], env = process.env, quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const meta = JSON.parse(readFileSync(join(FIX, 'meta.json'), 'utf8'));
  const { deliveries } = JSON.parse(readFileSync(join(FIX, 'deliveries.json'), 'utf8'));
  const fixtures = new Map();
  for (const f of readdirSync(join(FIX, 'orders')).filter((n) => n.endsWith('.json')).sort()) {
    const fx = JSON.parse(readFileSync(join(FIX, 'orders', f), 'utf8'));
    fixtures.set(fx.ref, fx);
  }

  mkdirSync(outDir, { recursive: true });
  const ledgerPath = join(outDir, 'ledger.jsonl');
  rmSync(ledgerPath, { force: true });

  // The clock follows each delivery's received_at so time windows behave as they would live.
  let nowMs = Date.parse(deliveries[0].received_at);
  const clock = () => nowMs;
  const capture = loadCaptureConfig();
  const rules = loadRules();
  const ga4 = resolveGa4Mode({ argv, env });
  const graphqlById = new Map([...fixtures.values()].map((fx) => [String(fx.payload.id), fx.graphql]));
  const pipeline = createPipeline({
    capture,
    rules,
    clock,
    enrich: mapEnricher(graphqlById),
    ga4,
    env,
    includePayloads: true,
    purchaseGuard: createDedupGuard({ store: new MemoryDedupStore(), ttlMs: 7 * 864e5, clock, namespace: 'purchase:' }),
  });
  const app = createCaptureServer({
    secrets: meta.app_secret,
    pipeline,
    ledger: createJsonlLedger(ledgerPath),
    webhookGuard: createDedupGuard({ store: new MemoryDedupStore(), ttlMs: 24 * 36e5, clock, namespace: 'webhook:' }),
    clock,
    logger: { error: (m) => console.error(m) },
  });
  const addr = await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${addr.port}${WEBHOOK_PATH}`;

  const http = {};
  try {
    for (const d of deliveries) {
      nowMs = Date.parse(d.received_at);
      const fx = fixtures.get(d.order);
      const source = d.body === 'refund' ? fx.refund : { ...fx.payload, ...(d.patch ?? {}) };
      const signedBody = JSON.stringify(source);
      const sentBody = d.tamper ? JSON.stringify({ ...source, ...d.tamper }) : signedBody;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-topic': d.topic,
          'x-shopify-hmac-sha256': computeShopifyHmac(signedBody, meta.app_secret),
          'x-shopify-shop-domain': meta.shop_domain,
          'x-shopify-webhook-id': d.webhook_id,
          'x-shopify-event-id': d.event_id,
          'x-shopify-triggered-at': d.received_at,
          'x-shopify-api-version': '2026-10',
        },
        body: sentBody,
      });
      await res.text();
      http[res.status] = (http[res.status] ?? 0) + 1;
      await app.drain();
    }
  } finally {
    await app.close();
  }

  const ledgerRecords = readJsonl(ledgerPath);
  const result = reconcile({
    orders: loadShopifyOrders(join(FIX, 'shopify-orders-export.json')),
    ga4: loadGa4Export(join(FIX, 'ga4-purchases-export.csv')),
    ledgerRecords,
    rules,
    capture,
    from: meta.week.from,
    to: meta.week.to,
  });
  const paths = writeReconciliation(result, outDir);

  const count = (pred) => ledgerRecords.filter(pred).length;
  const outcomes = {};
  for (const r of ledgerRecords) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const captured = ledgerRecords.filter((r) => r.outcome === 'captured');
  const ga4Status = {};
  for (const r of captured) ga4Status[r.ga4.status] = (ga4Status[r.ga4.status] ?? 0) + 1;
  const summary = {
    ga4_mode: ga4.mode,
    deliveries: deliveries.length,
    http,
    server: { ...app.stats },
    outcomes,
    ga4_purchases: ga4Status,
    ga4_refunds: count((r) => r.outcome === 'refund'),
    synthetic_client_ids: captured.filter((r) => r.ga4.client_id_source === 'synthetic').length,
    eligible: {
      meta: captured.filter((r) => r.platforms.meta.eligible).length,
      google_ads: captured.filter((r) => r.platforms.google_ads.eligible).length,
      openai: captured.filter((r) => r.platforms.openai.eligible).length,
    },
    reconciliation: result.summary,
    ga4_only: result.ga4_only.length,
    excluded: result.excluded.length,
    files: { ledger: ledgerPath, ...paths },
  };

  log(`GA4 mode: ${ga4.mode} (${ga4.reason})`);
  log(`Deliveries posted: ${summary.deliveries}  HTTP: ${Object.entries(http).map(([k, v]) => `${k}x${v}`).join(' ')}`);
  log(`Server: accepted ${app.stats.accepted}, duplicate ${app.stats.duplicates}, rejected (bad HMAC) ${app.stats.rejected}, ignored topic ${app.stats.ignored}`);
  log(`Ledger outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  log(`GA4 purchases: ${Object.entries(ga4Status).map(([k, v]) => `${k} ${v}`).join(', ')}; refunds ${summary.ga4_refunds}; synthetic client_id ${summary.synthetic_client_ids}`);
  log(`Ad platforms (dry run, nothing sent): Meta ${summary.eligible.meta}, Google Ads ${summary.eligible.google_ads}, ChatGPT Ads ${summary.eligible.openai} eligible of ${captured.length} captured orders`);
  log('');
  log(`Reconciliation ${meta.week.from.slice(0, 10)} .. ${meta.week.to.slice(0, 10)} (revenue in ${meta.shop_currency}):`);
  const cols = ['channel', 'orders', 'net_revenue', 'in_ga4', 'missing_from_ga4', 'mp_built_not_sent', 'mp_skipped', 'eligible_meta', 'eligible_google_ads', 'eligible_openai', 'unconfirmed_labels', 'not_in_ledger'];
  const heads = ['channel', 'orders', 'net_rev', 'in_ga4', 'missing', 'mp_built', 'mp_skip', 'meta', 'gads', 'openai', 'unconf', 'no_ledger'];
  const widths = heads.map((h, i) => Math.max(h.length, ...result.summary.map((s) => String(s[cols[i]]).length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join('  ').trimEnd();
  log(line(heads));
  for (const s of result.summary) log(line(cols.map((c) => s[c])));
  log('');
  log(`GA4-only transactions: ${result.ga4_only.length}; test orders excluded: ${result.excluded.length}`);
  log(`Wrote ${ledgerPath}`);
  log(`Wrote ${paths.summaryPath}`);
  log(`Wrote ${paths.ordersPath}`);
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const outDir = i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  runDemo({ outDir, argv }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
