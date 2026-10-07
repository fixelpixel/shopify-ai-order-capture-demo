// GA4 Measurement Protocol purchase (and refund) payloads.
//
// Rules this module follows, with sources read on 2026-10-02:
// - transaction_id is required and must be unique and non-empty: GA4 deduplicates purchases
//   that share a transaction_id (web streams only), and an empty string makes every empty-ID
//   purchase collapse into one. https://support.google.com/analytics/answer/12313109
// - Web streams need a client_id that should match the one the Google tag set on the site.
//   Since Feb 2026 the _ga cookie value is accepted too, but Google still recommends the
//   non-cookie value, so "GA1.1.123.456" is reduced to "123.456".
//   https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events
// - Without a real client_id there is no session to join: Google says MP-only data may give
//   only partial reporting, session source/medium needs a session_id sent within 24 h, and
//   events reach Google Ads only within 63 days of that client_id's last site event.
// - Limits: 25 events per request, 25 params per event, names <= 40 chars (letters, digits,
//   underscores, starting with a letter), param values <= 100 chars (standard property),
//   10 custom item params, body < 130 kB, timestamps backdated at most 72 h.
// - purchase value = sum(price * quantity) of the items, without shipping or tax.
//   https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference/events
// - /debug/mp/collect validates without recording; MP itself returns 2xx even for bad events.
//   https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events
// Google recommends the Data Manager API for new server-to-server integrations; the MP stays
// supported with no deprecation planned.

import { createHash } from 'node:crypto';
import {
  attributesOf, firstAttribute, fromMinor, lineDiscountMinor, moneyOf, orderCurrency, orderTimeMs,
  toMinor,
} from './order.mjs';

export const MP_LIMITS = Object.freeze({
  maxEventsPerRequest: 25,
  maxParamsPerEvent: 25,
  maxNameLength: 40,
  maxParamValueLength: 100,
  maxItemCustomParams: 10,
  maxBodyBytes: 130_000,
  maxBackdateHours: 72,
});

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const STANDARD_ITEM_PARAMS = new Set([
  'item_id', 'item_name', 'affiliation', 'coupon', 'discount', 'index', 'item_brand',
  'item_category', 'item_category2', 'item_category3', 'item_category4', 'item_category5',
  'item_list_id', 'item_list_name', 'item_variant', 'location_id', 'price', 'quantity',
]);
const UNCAPPED_PARAMS = new Set(['session_id', 'session_number']);

export const PARTIAL_REPORTING_NOTE =
  'synthetic client_id: there is no site session, device or ad click to join it to, so expect (not set) source/medium ' +
  'and no export to Google Ads through GA4. Google says Measurement Protocol data alone may give only partial reporting.';

/** "GA1.1.1234567890.1700000000" or "1234567890.1700000000" -> "1234567890.1700000000"; else null. */
export function parseGaClientId(raw) {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim();
  const cookie = /^GA\d+\.\d+\.(\d+\.\d+)$/.exec(v);
  if (cookie) return cookie[1];
  return /^\d+\.\d+$/.test(v) ? v : null;
}

/** Deterministic, so retries and later refunds for the same order reuse the same id. */
export function syntheticClientId(shopDomain, orderId) {
  const h = createHash('sha256').update(`${shopDomain ?? ''}|${orderId}`).digest();
  const a = 1_000_000_000 + (h.readUInt32BE(0) % 900_000_000);
  const b = 1_000_000_000 + (h.readUInt32BE(4) % 900_000_000);
  return `${a}.${b}`;
}

export function resolveClientId(order, { capture, shopDomain }) {
  const attrs = attributesOf(order);
  const raw = firstAttribute(attrs, capture?.attributes?.ga_client_id ?? []);
  const parsed = parseGaClientId(raw);
  if (parsed) return { client_id: parsed, client_id_source: 'ga_cookie', notes: [] };
  const notes = [];
  if (raw) notes.push(`captured _ga value is not a GA client id (${raw.slice(0, 40)}); using a synthetic id`);
  notes.push(PARTIAL_REPORTING_NOTE);
  return { client_id: syntheticClientId(shopDomain, order.id), client_id_source: 'synthetic', notes };
}

function capText(value, notes, label) {
  if (value === null || value === undefined) return undefined;
  const s = String(value);
  if (s.length <= MP_LIMITS.maxParamValueLength) return s;
  notes.push(`${label} truncated to ${MP_LIMITS.maxParamValueLength} characters`);
  return s.slice(0, MP_LIMITS.maxParamValueLength);
}

function dropUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/**
 * Builds the MP request body for a purchase. Never sends anything.
 * @returns {{payload:object, client_id_source:string, notes:string[], problems:string[], event_time_ms:number}}
 */
export function buildPurchasePayload(order, classification, { capture, shopDomain, now = Date.now() }) {
  if (order?.id === undefined || order?.id === null || String(order.id).trim() === '') {
    throw new Error('order has no id: transaction_id must be a unique, non-empty string');
  }
  const source = capture?.money_source ?? 'shop';
  const currency = orderCurrency(order, source);
  if (!currency) throw new Error(`order ${order.id} has no currency`);
  const notes = [];
  const { client_id, client_id_source, notes: idNotes } = resolveClientId(order, { capture, shopDomain });
  notes.push(...idNotes);

  let valueMinor = 0;
  const items = [];
  for (const li of order.line_items ?? []) {
    const quantity = Number(li.quantity ?? 0);
    if (!(quantity > 0)) continue;
    const unit = moneyOf(li, 'price', source, currency)?.minor ?? 0;
    const unitDiscount = Math.round(lineDiscountMinor(li, source, currency) / quantity);
    const finalUnit = unit - unitDiscount;
    valueMinor += finalUnit * quantity;
    items.push(dropUndefined({
      item_id: capText(li.sku || li.variant_id || li.product_id || li.id, notes, 'item_id'),
      item_name: capText(li.title ?? li.name, notes, `item_name of line ${li.id}`),
      item_variant: capText(li.variant_title, notes, 'item_variant'),
      item_brand: capText(li.vendor, notes, 'item_brand'),
      price: fromMinor(finalUnit, currency),
      discount: unitDiscount > 0 ? fromMinor(unitDiscount, currency) : undefined,
      quantity,
    }));
  }

  const tax = moneyOf(order, 'total_tax', source, currency);
  const shipping = moneyOf(order, 'total_shipping_price', source, currency);
  const coupon = order.discount_codes?.[0]?.code;
  const sessionRaw = firstAttribute(attributesOf(order), capture?.attributes?.ga_session_id ?? []);
  const sessionId = sessionRaw && /^\d+$/.test(sessionRaw) ? Number(sessionRaw) : undefined;
  if (sessionRaw && sessionId === undefined) notes.push('captured session id is not numeric; session_id left out');

  const params = dropUndefined({
    transaction_id: String(order.id),
    value: fromMinor(valueMinor, currency),
    currency,
    tax: tax ? fromMinor(tax.minor, currency) : undefined,
    shipping: shipping ? fromMinor(shipping.minor, currency) : undefined,
    coupon: capText(coupon, notes, 'coupon'),
    session_id: sessionId,
    ai_channel: classification.channel,
    ai_channel_confidence: classification.confidence,
    ai_label_status: classification.rule_confirmed ? 'confirmed' : 'unconfirmed',
    ai_checkout: classification.checkout,
    client_id_source,
    capture_source: 'server_mp',
  });
  params.items = items;

  const eventTimeMs = Math.min(orderTimeMs(order) ?? now, now);
  const payload = {
    client_id,
    timestamp_micros: eventTimeMs * 1000,
    events: [{ name: 'purchase', params }],
  };
  return { payload, client_id_source, notes, problems: validateMpPayload(payload), event_time_ms: eventTimeMs };
}

/** GA4 refund event for a refunds/create payload. */
export function buildRefundPayload(refund, { clientId, clientIdSource, capture, now = Date.now(), shopCurrency }) {
  if (refund?.order_id === undefined || refund?.order_id === null) throw new Error('refund has no order_id');
  const source = capture?.money_source ?? 'shop';
  const notes = [];
  let currency = null;
  let minor = 0;
  for (const t of refund.transactions ?? []) {
    if (t.kind !== 'refund' || (t.status && t.status !== 'success')) continue;
    currency ??= t.currency;
    if (t.currency !== currency) {
      notes.push(`refund transaction in ${t.currency} skipped (mixed currencies)`);
      continue;
    }
    minor += toMinor(t.amount, t.currency);
  }
  if (currency === null) {
    // No successful refund transaction (for example a restock-only refund): use line subtotals.
    currency = shopCurrency ?? null;
    for (const r of refund.refund_line_items ?? []) {
      const m = moneyOf(r, 'subtotal', source, currency);
      if (m) {
        currency = m.currency;
        minor += m.minor;
      }
    }
    if (minor === 0) notes.push('no money refunded; refund event carries value 0');
  }
  const items = (refund.refund_line_items ?? []).map((r) => dropUndefined({
    item_id: String(r.line_item?.sku || r.line_item?.variant_id || r.line_item_id),
    quantity: Number(r.quantity ?? 0),
  })).filter((i) => i.quantity > 0);

  const params = dropUndefined({
    transaction_id: String(refund.order_id),
    value: currency ? fromMinor(minor, currency) : 0,
    currency: currency ?? undefined,
    client_id_source: clientIdSource,
    capture_source: 'server_mp',
  });
  if (items.length) params.items = items;
  const eventTimeMs = Math.min(Date.parse(refund.created_at ?? '') || now, now);
  const payload = { client_id: clientId, timestamp_micros: eventTimeMs * 1000, events: [{ name: 'refund', params }] };
  return { payload, notes, problems: validateMpPayload(payload), event_time_ms: eventTimeMs, value_minor: minor, currency };
}

/** Checks the documented MP limits. Returns a list of problems (empty when valid). */
export function validateMpPayload(payload) {
  const problems = [];
  if (!payload?.client_id) problems.push('client_id is missing (required for web streams)');
  const events = payload?.events ?? [];
  if (events.length === 0) problems.push('no events');
  if (events.length > MP_LIMITS.maxEventsPerRequest) problems.push(`${events.length} events > ${MP_LIMITS.maxEventsPerRequest} per request`);
  for (const [i, ev] of events.entries()) {
    if (!NAME_RE.test(ev.name ?? '')) problems.push(`events[${i}].name "${ev.name}" is not a valid event name`);
    const params = ev.params ?? {};
    const keys = Object.keys(params);
    if (keys.length > MP_LIMITS.maxParamsPerEvent) problems.push(`events[${i}] has ${keys.length} params > ${MP_LIMITS.maxParamsPerEvent}`);
    for (const k of keys) {
      if (!NAME_RE.test(k)) problems.push(`events[${i}].params.${k}: invalid parameter name`);
      const v = params[k];
      if (typeof v === 'string' && v.length > MP_LIMITS.maxParamValueLength && !UNCAPPED_PARAMS.has(k)) {
        problems.push(`events[${i}].params.${k}: value longer than ${MP_LIMITS.maxParamValueLength} characters`);
      }
    }
    if ((ev.name === 'purchase' || ev.name === 'refund') && !(typeof params.transaction_id === 'string' && params.transaction_id.trim())) {
      problems.push(`events[${i}]: transaction_id must be a non-empty string`);
    }
    if (params.value !== undefined && !params.currency) problems.push(`events[${i}]: currency is required when value is set`);
    for (const [j, item] of (params.items ?? []).entries()) {
      if (!item.item_id && !item.item_name) problems.push(`events[${i}].items[${j}]: item_id or item_name is required`);
      const custom = Object.keys(item).filter((k) => !STANDARD_ITEM_PARAMS.has(k));
      if (custom.length > MP_LIMITS.maxItemCustomParams) problems.push(`events[${i}].items[${j}]: ${custom.length} custom params > ${MP_LIMITS.maxItemCustomParams}`);
      for (const [k, v] of Object.entries(item)) {
        if (!NAME_RE.test(k)) problems.push(`events[${i}].items[${j}].${k}: invalid parameter name`);
        if (typeof v === 'string' && v.length > MP_LIMITS.maxParamValueLength) problems.push(`events[${i}].items[${j}].${k}: value longer than ${MP_LIMITS.maxParamValueLength} characters`);
      }
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload ?? {}));
  if (bytes >= MP_LIMITS.maxBodyBytes) problems.push(`body is ${bytes} bytes; must be under ${MP_LIMITS.maxBodyBytes}`);
  return problems;
}

/**
 * Whether to send the purchase. Policy per checkout type comes from config/capture.json:
 *   send               always (direct checkout: GA4 and custom pixels do not fire there)
 *   send_if_client_id  only with a captured client_id (store checkout: the browser tag also
 *                      records the purchase; GA4 dedupes by transaction_id for the same user,
 *                      but dedup across different client_ids is not documented)
 *   never
 */
export function decideGa4({ classification, built, capture, now = Date.now() }) {
  const maxHours = capture?.ga4?.max_backdate_hours ?? MP_LIMITS.maxBackdateHours;
  const ageHours = (now - built.event_time_ms) / 3_600_000;
  if (ageHours > maxHours) {
    return {
      action: 'skip',
      reason: `order is ${ageHours.toFixed(1)} h old; the Measurement Protocol backdates at most ${maxHours} h (older timestamps are clamped or rejected), and this demo does no backfill`,
    };
  }
  if (built.problems.length) return { action: 'skip', reason: `payload breaks MP limits: ${built.problems.join('; ')}` };
  const policy = capture?.ga4?.policy?.[classification.checkout] ?? 'send_if_client_id';
  if (policy === 'never') return { action: 'skip', reason: `policy for ${classification.checkout} checkout is "never"` };
  if (policy === 'send') {
    return {
      action: 'send',
      reason: classification.checkout === 'direct'
        ? 'direct checkout: GA4 tags do not fire there, so the server event is the only GA4 record'
        : `policy for ${classification.checkout} checkout is "send"`,
    };
  }
  if (built.client_id_source === 'ga_cookie') {
    return {
      action: 'send',
      reason: 'captured client_id: the browser purchase and this one share transaction_id and user, so GA4 keeps one',
    };
  }
  return {
    action: 'skip',
    reason: `${classification.checkout} checkout without a captured client_id: the browser tag should record this purchase, and GA4 dedup by transaction_id across different client_ids is not documented, so sending risks a double count`,
  };
}

/** dry-run unless the env has both credentials AND --send or --validate is passed. */
export function resolveGa4Mode({ argv = [], env = {} } = {}) {
  const hasCreds = Boolean(env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET);
  const wantValidate = argv.includes('--validate');
  const wantSend = argv.includes('--send');
  if (wantValidate) {
    return hasCreds
      ? { mode: 'validate', reason: '--validate: posting to /debug/mp/collect (nothing is recorded)' }
      : { mode: 'dry-run', reason: '--validate ignored: set GA4_MEASUREMENT_ID and GA4_API_SECRET' };
  }
  if (wantSend) {
    return hasCreds
      ? { mode: 'send', reason: '--send with GA4_MEASUREMENT_ID and GA4_API_SECRET set: posting to /mp/collect' }
      : { mode: 'dry-run', reason: '--send ignored: set GA4_MEASUREMENT_ID and GA4_API_SECRET' };
  }
  return { mode: 'dry-run', reason: 'default: payloads are built, nothing is posted' };
}

export function mpUrl({ mode, measurementId, apiSecret, region = 'global' }) {
  const host = region === 'eu' ? 'region1.google-analytics.com' : 'www.google-analytics.com';
  const path = mode === 'validate' ? '/debug/mp/collect' : '/mp/collect';
  const qs = new URLSearchParams({ measurement_id: measurementId, api_secret: apiSecret });
  return `https://${host}${path}?${qs}`;
}

/** Posts one payload. Only call in "send" or "validate" mode. */
export async function postToGa4(payload, { mode, env = process.env, region, fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
  if (mode !== 'send' && mode !== 'validate') throw new Error(`postToGa4 refuses to post in mode "${mode}"`);
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) throw new Error('GA4_MEASUREMENT_ID and GA4_API_SECRET are required');
  const url = mpUrl({ mode, measurementId: env.GA4_MEASUREMENT_ID, apiSecret: env.GA4_API_SECRET, region: region ?? env.GA4_REGION });
  const body = mode === 'validate' ? { ...payload, validation_behavior: 'ENFORCE_RECOMMENDATIONS' } : payload;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (mode === 'validate') {
    const json = await res.json().catch(() => ({}));
    return { status: res.status, validation_messages: json.validationMessages ?? [] };
  }
  return { status: res.status };
}
