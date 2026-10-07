import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDemo } from '../scripts/demo.mjs';

test('demo runs every fixture delivery through the HTTP server and writes the outputs', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'demo-'));
  // --send without credentials must stay a dry run.
  const s = await runDemo({ outDir, quiet: true, argv: ['--send'], env: {} });
  assert.equal(s.ga4_mode, 'dry-run');
  assert.equal(s.deliveries, 31);
  assert.deepEqual(s.http, { 200: 30, 401: 1 });
  assert.deepEqual(
    { accepted: s.server.accepted, duplicates: s.server.duplicates, rejected: s.server.rejected, ignored: s.server.ignored, errors: s.server.processing_errors },
    { accepted: 28, duplicates: 1, rejected: 1, ignored: 1, errors: 0 },
  );
  assert.deepEqual(s.outcomes, {
    captured: 23, already_captured: 2, waiting: 1, refund: 1, ignored: 1, duplicate_delivery: 1, ignored_topic: 1,
  });
  assert.deepEqual(s.ga4_purchases, { built_dry_run: 16, skipped: 7 });
  assert.equal(s.ga4_refunds, 1);
  assert.equal(s.synthetic_client_ids, 14);
  assert.deepEqual(s.eligible, { meta: 3, google_ads: 2, openai: 2 });
  for (const f of ['ledger.jsonl', 'reconciliation.csv', 'reconciliation-orders.csv']) {
    assert.ok(existsSync(join(outDir, f)), `${f} written`);
  }
  const csv = readFileSync(join(outDir, 'reconciliation.csv'), 'utf8').trim().split('\n');
  assert.equal(csv[0].split(',')[0], 'channel');
  assert.equal(csv.at(-1).split(',')[0], 'TOTAL');
});
