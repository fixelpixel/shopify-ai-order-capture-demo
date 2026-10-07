// Duplicate-delivery guard.
//
// Shopify: "Use X-Shopify-Webhook-Id to deduplicate individual deliveries. Use
// X-Shopify-Event-Id to correlate deliveries that originated from the same merchant
// action." With several subscriptions to one topic, each delivery has its own
// Webhook-Id but they share an Event-Id, so Event-Id is NOT the dedup key.
// Shopify retries a failed delivery 8 times over 4 hours, so the default TTL (24 h)
// covers the whole retry window.
// Source: https://shopify.dev/docs/apps/build/webhooks/verify-deliveries (read 2026-10-02)
//
// A store implements markIfNew(key, expiresAt, now) -> boolean atomically (true = first
// time seen). A shared store (for example Redis SET NX PX) can be plugged in the same way.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEDUP_HEADER = 'x-shopify-webhook-id';
export const EVENT_HEADER = 'x-shopify-event-id';
export const DEFAULT_WEBHOOK_TTL_MS = 24 * 60 * 60 * 1000;

export class MemoryDedupStore {
  #entries = new Map();

  markIfNew(key, expiresAt, now) {
    const current = this.#entries.get(key);
    if (current !== undefined && current > now) return false;
    this.#entries.set(key, expiresAt);
    return true;
  }

  delete(key) {
    this.#entries.delete(key);
  }

  purge(now) {
    for (const [k, exp] of this.#entries) if (exp <= now) this.#entries.delete(k);
  }

  get size() {
    return this.#entries.size;
  }
}

/**
 * Append-only JSONL file store for a single process. Each line is {"k":key,"exp":ms} or
 * {"k":key,"del":true}. Expired and deleted keys are dropped when the file is loaded.
 */
export class JsonlFileDedupStore {
  #entries = new Map();

  constructor(path, { now = Date.now() } = {}) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // a torn last line after a crash is ignored
        }
        if (rec.del) this.#entries.delete(rec.k);
        else if (typeof rec.k === 'string' && Number.isFinite(rec.exp)) this.#entries.set(rec.k, rec.exp);
      }
    }
    this.purge(now);
    this.#compact();
  }

  markIfNew(key, expiresAt, now) {
    const current = this.#entries.get(key);
    if (current !== undefined && current > now) return false;
    this.#entries.set(key, expiresAt);
    appendFileSync(this.path, JSON.stringify({ k: key, exp: expiresAt }) + '\n');
    return true;
  }

  delete(key) {
    if (!this.#entries.delete(key)) return;
    appendFileSync(this.path, JSON.stringify({ k: key, del: true }) + '\n');
  }

  purge(now) {
    for (const [k, exp] of this.#entries) if (exp <= now) this.#entries.delete(k);
  }

  get size() {
    return this.#entries.size;
  }

  #compact() {
    const lines = [...this.#entries].map(([k, exp]) => JSON.stringify({ k, exp }));
    writeFileSync(this.path, lines.length ? lines.join('\n') + '\n' : '');
  }
}

/**
 * @param {object} opts
 * @param {object} [opts.store]  MemoryDedupStore (default), JsonlFileDedupStore or compatible
 * @param {number} [opts.ttlMs]
 * @param {() => number} [opts.clock]
 * @param {string} [opts.namespace]  key prefix, e.g. "webhook:" or "purchase:"
 */
export function createDedupGuard({
  store = new MemoryDedupStore(),
  ttlMs = DEFAULT_WEBHOOK_TTL_MS,
  clock = Date.now,
  namespace = '',
} = {}) {
  let calls = 0;
  return {
    store,
    async checkAndMark(id) {
      if (id === undefined || id === null || String(id) === '') {
        throw new Error('dedup: empty key');
      }
      const now = clock();
      const key = namespace + String(id);
      const fresh = await store.markIfNew(key, now + ttlMs, now);
      if (++calls % 500 === 0 && typeof store.purge === 'function') await store.purge(now);
      return { duplicate: !fresh, key };
    },
    async forget(id) {
      if (typeof store.delete === 'function') await store.delete(namespace + String(id));
    },
  };
}
