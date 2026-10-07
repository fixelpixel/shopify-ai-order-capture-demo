// Processes one verified, de-duplicated webhook delivery:
// classify -> GA4 purchase (or refund) payload and decision -> ad-platform eligibility.
// Returns the ledger record. The server calls this after it has already answered 200.

import { classifyOrder } from './classify.mjs';
import { createDedupGuard, MemoryDedupStore } from './dedup.mjs';
import { evaluateEligibility } from './eligibility.mjs';
import {
  buildPurchasePayload, buildRefundPayload, decideGa4, MP_LIMITS, postToGa4, syntheticClientId,
} from './ga4.mjs';

export const ORDER_TOPICS = new Set(['orders/create', 'orders/paid']);
export const REFUND_TOPICS = new Set(['refunds/create']);
export const SUPPORTED_TOPICS = new Set([...ORDER_TOPICS, ...REFUND_TOPICS]);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} opts
 * @param {object} opts.capture        config/capture.json
 * @param {object} opts.rules          compiled channel rules
 * @param {() => number} [opts.clock]
 * @param {(order) => Promise<object|null>} [opts.enrich]  GraphQL Admin API fields for the order
 * @param {{mode:'dry-run'|'validate'|'send'}} [opts.ga4]
 * @param {object} [opts.env]          GA4_MEASUREMENT_ID / GA4_API_SECRET for send/validate
 * @param {Function} [opts.fetchImpl]
 * @param {object} [opts.purchaseGuard] order-level guard (orders/create and orders/paid both arrive)
 * @param {boolean} [opts.includePayloads] store full payloads in the ledger records
 */
export function createPipeline({
  capture,
  rules,
  clock = Date.now,
  enrich = async () => null,
  ga4 = { mode: 'dry-run' },
  env = process.env,
  fetchImpl,
  purchaseGuard,
  includePayloads = false,
}) {
  const guard = purchaseGuard ?? createDedupGuard({
    store: new MemoryDedupStore(),
    ttlMs: (capture.dedup?.purchase_ttl_days ?? 7) * DAY_MS,
    clock,
    namespace: 'purchase:',
  });
  // order id -> client id used for its purchase, so a later refund reuses it.
  const purchaseIndex = new Map();

  const platformView = (e) => {
    const view = (d) => ({
      eligible: d.eligible,
      reason: d.reason,
      identifiers_used: d.identifiers_used,
      notes: d.notes,
      ...(includePayloads && d.payload ? { payload: d.payload } : {}),
    });
    return { meta: view(e.meta), google_ads: view(e.google_ads), openai: view(e.openai) };
  };

  async function deliver(rec, decision, payload, onFailure) {
    if (decision.action !== 'send') {
      rec.status = 'skipped';
      return;
    }
    if (ga4.mode !== 'send' && ga4.mode !== 'validate') {
      rec.status = 'built_dry_run';
      return;
    }
    try {
      const res = await postToGa4(payload, {
        mode: ga4.mode,
        env,
        fetchImpl,
        region: capture.ga4?.region === 'eu' ? 'eu' : undefined,
      });
      rec.status = ga4.mode === 'validate' ? 'validated' : 'sent';
      rec.http_status = res.status;
      if (res.validation_messages) rec.validation_messages = res.validation_messages;
    } catch (err) {
      rec.status = 'send_failed';
      rec.error = err.message;
      await onFailure?.();
    }
  }

  async function processOrder(base, order, now) {
    const record = { ...base, order_id: String(order?.id ?? ''), order_name: order?.name ?? null };
    if (order?.id === undefined || order?.id === null) return { ...record, outcome: 'error', reason: 'payload has no order id' };
    if (order.test) return { ...record, outcome: 'ignored', reason: 'test order' };

    let enrichment = null;
    try {
      enrichment = await enrich(order);
    } catch (err) {
      record.enrichment_error = err.message;
    }
    const classification = classifyOrder(order, { rules, enrichment, capture });
    const eligibility = evaluateEligibility(order, classification, { capture, now });
    record.financial_status = order.financial_status ?? null;
    record.classification = classification;

    if (!capture.purchase_on_financial_status.includes(order.financial_status)) {
      return {
        ...record,
        outcome: 'waiting',
        reason: `financial_status "${order.financial_status}": the purchase is captured once the order is paid (orders/paid)`,
        platforms: platformView(eligibility),
      };
    }

    const key = `${base.shop_domain ?? ''}:${order.id}`;
    const { duplicate } = await guard.checkAndMark(key);
    if (duplicate) {
      return {
        ...record,
        outcome: 'already_captured',
        reason: 'an earlier delivery for this order (orders/create or orders/paid) already captured the purchase',
      };
    }

    const built = buildPurchasePayload(order, classification, { capture, shopDomain: base.shop_domain, now });
    const decision = decideGa4({ classification, built, capture, now });
    const ga4Rec = {
      decision: decision.action,
      reason: decision.reason,
      client_id: built.payload.client_id,
      client_id_source: built.client_id_source,
      transaction_id: String(order.id),
      notes: built.notes,
      problems: built.problems,
    };
    await deliver(ga4Rec, decision, built.payload, () => guard.forget(key));
    if (includePayloads) ga4Rec.payload = built.payload;
    purchaseIndex.set(String(order.id), { client_id: built.payload.client_id, client_id_source: built.client_id_source });

    return { ...record, outcome: 'captured', ga4: ga4Rec, platforms: platformView(eligibility) };
  }

  async function processRefund(base, refund, now) {
    const record = { ...base, order_id: String(refund?.order_id ?? ''), refund_id: String(refund?.id ?? '') };
    if (refund?.order_id === undefined || refund?.order_id === null) return { ...record, outcome: 'error', reason: 'refund has no order_id' };
    const prior = purchaseIndex.get(String(refund.order_id));
    const clientId = prior?.client_id ?? syntheticClientId(base.shop_domain, refund.order_id);
    const clientIdSource = prior?.client_id_source ?? 'synthetic';
    const built = buildRefundPayload(refund, { clientId, clientIdSource, capture, now });
    const maxHours = capture.ga4?.max_backdate_hours ?? MP_LIMITS.maxBackdateHours;
    const ageHours = (now - built.event_time_ms) / 3_600_000;
    let decision;
    if (ageHours > maxHours) decision = { action: 'skip', reason: `refund is ${ageHours.toFixed(1)} h old; MP backdates at most ${maxHours} h` };
    else if (built.problems.length) decision = { action: 'skip', reason: `payload breaks MP limits: ${built.problems.join('; ')}` };
    else decision = { action: 'send', reason: 'refund event keyed by the order id as transaction_id' };
    const ga4Rec = {
      decision: decision.action,
      reason: decision.reason,
      client_id: clientId,
      client_id_source: clientIdSource,
      transaction_id: String(refund.order_id),
      value: built.payload.events[0].params.value,
      currency: built.currency,
      notes: [
        ...built.notes,
        ...(prior ? [] : ['no purchase for this order in memory; the deterministic synthetic client_id for the order is used']),
      ],
      problems: built.problems,
    };
    await deliver(ga4Rec, decision, built.payload);
    if (includePayloads) ga4Rec.payload = built.payload;
    return { ...record, outcome: 'refund', ga4: ga4Rec };
  }

  return {
    purchaseIndex,
    /** Rebuilds the order -> client id index from earlier ledger records (after a restart). */
    loadIndex(records) {
      for (const r of records) {
        if (r.outcome === 'captured' && r.ga4?.client_id) {
          purchaseIndex.set(String(r.order_id), { client_id: r.ga4.client_id, client_id_source: r.ga4.client_id_source });
        }
      }
    },
    async processDelivery({ topic, shopDomain, webhookId, eventId, triggeredAt, body }) {
      const now = clock();
      const base = {
        received_at: new Date(now).toISOString(),
        topic,
        shop_domain: shopDomain ?? null,
        webhook_id: webhookId ?? null,
        event_id: eventId ?? null,
        triggered_at: triggeredAt ?? null,
        ga4_mode: ga4.mode,
      };
      if (ORDER_TOPICS.has(topic)) return processOrder(base, body, now);
      if (REFUND_TOPICS.has(topic)) return processRefund(base, body, now);
      return { ...base, outcome: 'ignored_topic', reason: `topic "${topic}" is not handled` };
    },
  };
}
