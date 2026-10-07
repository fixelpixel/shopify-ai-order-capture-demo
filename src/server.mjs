// POST /webhooks/orders  (topics: orders/create, orders/paid, refunds/create)
//
// verify HMAC -> dedup on X-Shopify-Webhook-Id -> answer 200 -> then process:
// classify -> GA4 payload/decision -> ad-platform eligibility -> append to the JSONL ledger.
//
// Shopify allows 1 s to connect and 5 s for the whole request, treats any non-2xx (3xx too)
// as a failure, retries 8 times over 4 hours, and deletes an Admin-API subscription after 8
// failures in a row. So the server answers as soon as the delivery is verified and recorded
// in the dedup store, and does the work afterwards. A reconciliation job catches anything lost.
// https://shopify.dev/docs/apps/build/webhooks/verify-deliveries (read 2026-10-02)

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CAPTURE_PATH, DEFAULT_RULES_PATH, loadCaptureConfig } from './config.mjs';
import { loadRules } from './classify.mjs';
import { createDedupGuard, JsonlFileDedupStore, MemoryDedupStore } from './dedup.mjs';
import { createAdminEnricher } from './enrich.mjs';
import { resolveGa4Mode } from './ga4.mjs';
import { createJsonlLedger, readJsonl } from './ledger.mjs';
import { createPipeline, SUPPORTED_TOPICS } from './pipeline.mjs';
import { verifyShopifyWebhook } from './verify.mjs';

export const WEBHOOK_PATH = '/webhooks/orders';
const HOUR_MS = 60 * 60 * 1000;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Past the limit, keep reading but discard, so the client still gets the 413.
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > limit) reject(Object.assign(new Error(`body larger than ${limit} bytes`), { status: 413 }));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/**
 * @param {object} opts
 * @param {string|string[]} opts.secrets   app client secret(s)
 * @param {object} opts.pipeline          from createPipeline
 * @param {object} opts.ledger            from createJsonlLedger
 * @param {object} [opts.webhookGuard]    from createDedupGuard (default: in-memory, 24 h)
 * @param {number} [opts.maxBodyBytes]
 * @param {() => number} [opts.clock]
 */
export function createCaptureServer({
  secrets,
  pipeline,
  ledger,
  webhookGuard = createDedupGuard({ store: new MemoryDedupStore(), ttlMs: 24 * HOUR_MS, namespace: 'webhook:' }),
  maxBodyBytes = 1024 * 1024,
  path = WEBHOOK_PATH,
  clock = Date.now,
  logger = console,
}) {
  if (!secrets || (Array.isArray(secrets) && secrets.length === 0)) throw new Error('createCaptureServer: app secret required');
  const stats = { accepted: 0, duplicates: 0, rejected: 0, ignored: 0, bad_requests: 0, processing_errors: 0 };
  let tail = Promise.resolve();
  // Work runs one delivery at a time so ledger lines keep arrival order.
  const enqueue = (job) => {
    tail = tail.then(job).catch((err) => {
      stats.processing_errors += 1;
      logger.error?.(`[capture] processing failed: ${err.stack ?? err}`);
    });
    return tail;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== path) return sendJson(res, 404, { error: 'not found' });
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      let raw;
      try {
        raw = await readBody(req, maxBodyBytes);
      } catch (err) {
        stats.bad_requests += 1;
        return sendJson(res, err.status ?? 400, { error: err.message });
      }
      if (!verifyShopifyWebhook(raw, req.headers['x-shopify-hmac-sha256'], secrets)) {
        stats.rejected += 1;
        return sendJson(res, 401, { error: 'HMAC verification failed' });
      }
      const webhookId = req.headers['x-shopify-webhook-id'];
      if (!webhookId) {
        stats.bad_requests += 1;
        return sendJson(res, 400, { error: 'missing X-Shopify-Webhook-Id' });
      }
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        stats.bad_requests += 1;
        return sendJson(res, 400, { error: 'body is not JSON' });
      }
      const delivery = {
        topic: String(req.headers['x-shopify-topic'] ?? ''),
        shopDomain: req.headers['x-shopify-shop-domain'] ?? null,
        webhookId: String(webhookId),
        eventId: req.headers['x-shopify-event-id'] ?? null,
        triggeredAt: req.headers['x-shopify-triggered-at'] ?? null,
        body,
      };
      const ledgerBase = () => ({
        received_at: new Date(clock()).toISOString(),
        topic: delivery.topic,
        shop_domain: delivery.shopDomain,
        webhook_id: delivery.webhookId,
        event_id: delivery.eventId,
        order_id: String(body?.order_id ?? body?.id ?? ''),
      });

      const { duplicate } = await webhookGuard.checkAndMark(delivery.webhookId);
      if (duplicate) {
        stats.duplicates += 1;
        sendJson(res, 200, { status: 'duplicate' });
        enqueue(() => ledger.append({ ...ledgerBase(), outcome: 'duplicate_delivery', reason: 'X-Shopify-Webhook-Id already seen' }));
        return;
      }
      if (!SUPPORTED_TOPICS.has(delivery.topic)) {
        stats.ignored += 1;
        sendJson(res, 200, { status: 'ignored', topic: delivery.topic });
        enqueue(() => ledger.append({ ...ledgerBase(), outcome: 'ignored_topic', reason: `topic "${delivery.topic}" is not handled` }));
        return;
      }
      stats.accepted += 1;
      sendJson(res, 200, { status: 'accepted' });
      enqueue(async () => {
        let record;
        try {
          record = await pipeline.processDelivery(delivery);
        } catch (err) {
          stats.processing_errors += 1;
          record = { ...ledgerBase(), outcome: 'error', reason: err.message };
        }
        await ledger.append(record);
      });
    } catch (err) {
      logger.error?.(`[capture] request failed: ${err.stack ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    }
  });

  return {
    server,
    stats,
    /** Resolves when every accepted delivery has been processed and written to the ledger. */
    drain: () => tail,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await tail;
    },
  };
}

async function main() {
  const env = process.env;
  const argv = process.argv.slice(2);
  const secrets = [env.SHOPIFY_API_SECRET, env.SHOPIFY_API_SECRET_PREVIOUS].filter(Boolean);
  if (secrets.length === 0) {
    console.error('Set SHOPIFY_API_SECRET (the app client secret). See .env.example.');
    process.exit(1);
  }
  const capture = loadCaptureConfig(env.CAPTURE_CONFIG ?? DEFAULT_CAPTURE_PATH);
  const rules = loadRules(env.CHANNEL_RULES ?? DEFAULT_RULES_PATH);
  const ga4 = resolveGa4Mode({ argv, env });
  const ledgerPath = env.LEDGER_PATH ?? 'data/ledger.jsonl';
  const ledger = createJsonlLedger(ledgerPath);
  const useFileDedup = env.DEDUP_STORE === 'file';
  const webhookGuard = createDedupGuard({
    store: useFileDedup ? new JsonlFileDedupStore(env.DEDUP_PATH ?? 'data/webhook-ids.jsonl') : new MemoryDedupStore(),
    ttlMs: (capture.dedup?.webhook_ttl_hours ?? 24) * HOUR_MS,
    namespace: 'webhook:',
  });
  const purchaseGuard = createDedupGuard({
    store: useFileDedup ? new JsonlFileDedupStore(env.PURCHASE_DEDUP_PATH ?? 'data/purchases.jsonl') : new MemoryDedupStore(),
    ttlMs: (capture.dedup?.purchase_ttl_days ?? 7) * 24 * HOUR_MS,
    namespace: 'purchase:',
  });
  const enrich = env.SHOPIFY_SHOP && env.SHOPIFY_ADMIN_TOKEN
    ? createAdminEnricher({ shopDomain: env.SHOPIFY_SHOP, accessToken: env.SHOPIFY_ADMIN_TOKEN, apiVersion: env.SHOPIFY_API_VERSION })
    : async () => null;
  const pipeline = createPipeline({ capture, rules, enrich, ga4, env, purchaseGuard });
  pipeline.loadIndex(readJsonl(ledgerPath));
  const app = createCaptureServer({ secrets, pipeline, ledger, webhookGuard });
  const port = Number(env.PORT ?? 8787);
  const addr = await app.listen(port, env.HOST ?? '127.0.0.1');
  console.log(`[capture] listening on http://${addr.address}:${addr.port}${WEBHOOK_PATH}`);
  console.log(`[capture] GA4 mode: ${ga4.mode} (${ga4.reason})`);
  console.log(`[capture] enrichment: ${env.SHOPIFY_SHOP && env.SHOPIFY_ADMIN_TOKEN ? 'GraphQL Admin API' : 'off (webhook fields only)'}`);
  console.log(`[capture] ledger: ${ledgerPath}; dedup store: ${useFileDedup ? 'file' : 'memory'}`);
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
