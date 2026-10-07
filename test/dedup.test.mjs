import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDedupGuard, DEDUP_HEADER, DEFAULT_WEBHOOK_TTL_MS, EVENT_HEADER, JsonlFileDedupStore, MemoryDedupStore,
} from '../src/dedup.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'dedup-'));

test('keyed on X-Shopify-Webhook-Id, not X-Shopify-Event-Id', () => {
  assert.equal(DEDUP_HEADER, 'x-shopify-webhook-id');
  assert.equal(EVENT_HEADER, 'x-shopify-event-id');
  assert.ok(DEFAULT_WEBHOOK_TTL_MS >= 4 * 60 * 60 * 1000, 'TTL covers Shopify\'s 4-hour retry window');
});

test('memory store: first delivery is new, repeat is a duplicate, other ids are independent', async () => {
  const guard = createDedupGuard();
  assert.deepEqual(await guard.checkAndMark('wh-1'), { duplicate: false, key: 'wh-1' });
  assert.equal((await guard.checkAndMark('wh-1')).duplicate, true);
  assert.equal((await guard.checkAndMark('wh-2')).duplicate, false);
});

test('TTL: a key is new again after it expires', async () => {
  let now = 1_000_000;
  const guard = createDedupGuard({ ttlMs: 1000, clock: () => now });
  assert.equal((await guard.checkAndMark('a')).duplicate, false);
  now += 999;
  assert.equal((await guard.checkAndMark('a')).duplicate, true);
  now += 2;
  assert.equal((await guard.checkAndMark('a')).duplicate, false);
});

test('forget() releases a key (used when a GA4 send fails so a later delivery can retry)', async () => {
  const guard = createDedupGuard({ namespace: 'purchase:' });
  const { key } = await guard.checkAndMark('shop:1');
  assert.equal(key, 'purchase:shop:1');
  await guard.forget('shop:1');
  assert.equal((await guard.checkAndMark('shop:1')).duplicate, false);
});

test('namespaces keep webhook ids and order keys apart in one store', async () => {
  const store = new MemoryDedupStore();
  const a = createDedupGuard({ store, namespace: 'webhook:' });
  const b = createDedupGuard({ store, namespace: 'purchase:' });
  assert.equal((await a.checkAndMark('1')).duplicate, false);
  assert.equal((await b.checkAndMark('1')).duplicate, false);
  assert.equal(store.size, 2);
});

test('empty key is rejected', async () => {
  const guard = createDedupGuard();
  await assert.rejects(guard.checkAndMark(''), /empty key/);
  await assert.rejects(guard.checkAndMark(undefined), /empty key/);
});

test('memory store purge drops expired entries', () => {
  const store = new MemoryDedupStore();
  store.markIfNew('a', 10, 0);
  store.markIfNew('b', 100, 0);
  store.purge(50);
  assert.equal(store.size, 1);
});

test('JSONL file store persists across restarts', async () => {
  const path = join(tmp(), 'ids.jsonl');
  let now = 5_000;
  const g1 = createDedupGuard({ store: new JsonlFileDedupStore(path, { now }), ttlMs: 10_000, clock: () => now });
  assert.equal((await g1.checkAndMark('wh-1')).duplicate, false);
  const g2 = createDedupGuard({ store: new JsonlFileDedupStore(path, { now }), ttlMs: 10_000, clock: () => now });
  assert.equal((await g2.checkAndMark('wh-1')).duplicate, true, 'seen before the restart');
  assert.equal((await g2.checkAndMark('wh-2')).duplicate, false);
});

test('JSONL file store drops expired and deleted keys on load and compacts the file', () => {
  const path = join(tmp(), 'ids.jsonl');
  const s1 = new JsonlFileDedupStore(path, { now: 0 });
  s1.markIfNew('old', 100, 0);
  s1.markIfNew('live', 10_000, 0);
  s1.markIfNew('gone', 10_000, 0);
  s1.delete('gone');
  const s2 = new JsonlFileDedupStore(path, { now: 500 });
  assert.equal(s2.size, 1);
  assert.equal(s2.markIfNew('live', 20_000, 500), false);
  assert.equal(s2.markIfNew('gone', 20_000, 500), true);
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.ok(lines.length <= 2, 'compacted on load, then one append');
});

test('JSONL file store ignores a torn last line', () => {
  const path = join(tmp(), 'ids.jsonl');
  writeFileSync(path, JSON.stringify({ k: 'a', exp: 9_999 }) + '\n');
  appendFileSync(path, '{"k":"b","ex');
  const s = new JsonlFileDedupStore(path, { now: 0 });
  assert.equal(s.size, 1);
  assert.equal(s.markIfNew('a', 10_000, 1), false);
});
