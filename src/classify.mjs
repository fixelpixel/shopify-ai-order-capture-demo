// Rule-driven channel classification for Shopify orders.
//
// Input: an order in webhook (REST) shape, plus optional fields from a GraphQL Admin API
// lookup (Order.attribution, app, publication, sourceName, customerJourneySummary).
// Shopify's documented orders/create and orders/paid samples show source_name, landing_site
// and referring_site; this demo reads Order.attribution, app and publication through a
// separate GraphQL lookup (src/enrich.mjs) rather than expecting them in the webhook.
// Rules live in config/channel-rules.json; see that file for what is and is not confirmed.

import { readFileSync } from 'node:fs';
import { DEFAULT_RULES_PATH } from './config.mjs';
import { attributesOf, firstAttribute, hostOf, urlParams } from './order.mjs';

export const CHANNELS = Object.freeze([
  'chatgpt', 'google_ai', 'copilot', 'meta_ai', 'shop', 'other_agent', 'web', 'unknown',
]);
export const CHECKOUT_TYPES = Object.freeze(['direct', 'store', 'unknown']);
export const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
export const UNCONFIRMED_NOTE = "unconfirmed: verify on the store's real orders before trusting the label";

const OPS = new Set(['present', 'equals', 'in', 'matches', 'host_in']);

export function loadRules(path = DEFAULT_RULES_PATH) {
  return compileRules(JSON.parse(readFileSync(path, 'utf8')));
}

/** Validates the rules document and pre-compiles regex patterns. Throws on any problem. */
export function compileRules(doc) {
  const errors = [];
  const seen = new Set();
  const rules = (doc?.rules ?? []).map((rule, i) => {
    const where = `rules[${i}]${rule?.id ? ` (${rule.id})` : ''}`;
    if (!rule?.id) errors.push(`${where}: id is required`);
    else if (seen.has(rule.id)) errors.push(`${where}: duplicate id`);
    seen.add(rule?.id);
    if (!CHANNELS.includes(rule?.channel) || rule.channel === 'unknown') errors.push(`${where}: channel must be one of ${CHANNELS.join(', ')} (not unknown)`);
    if (!CHECKOUT_TYPES.includes(rule?.checkout)) errors.push(`${where}: checkout must be direct, store or unknown`);
    if (!CONFIDENCE.includes(rule?.confidence)) errors.push(`${where}: confidence must be high, medium or low`);
    if (typeof rule?.confirmed !== 'boolean') errors.push(`${where}: confirmed must be true or false`);
    if (rule?.confirmed === true && !(rule.sources?.length > 0)) errors.push(`${where}: a confirmed rule needs at least one source`);
    if (rule?.confirmed === false && rule.status !== UNCONFIRMED_NOTE) errors.push(`${where}: an unconfirmed rule must carry status "${UNCONFIRMED_NOTE}"`);
    const mode = rule?.all ? 'all' : 'any';
    const conditions = rule?.[mode];
    if (!Array.isArray(conditions) || conditions.length === 0) errors.push(`${where}: needs a non-empty "any" or "all" list`);
    const compiled = (conditions ?? []).map((c, j) => {
      const at = `${where}.${mode}[${j}]`;
      const fields = c.fields ?? (c.field ? [c.field] : []);
      if (fields.length === 0) errors.push(`${at}: field or fields is required`);
      if (!OPS.has(c.op)) errors.push(`${at}: unknown op "${c.op}"`);
      let regex = null;
      if (c.op === 'matches') {
        try {
          regex = new RegExp(c.pattern, c.flags ?? 'i');
        } catch (e) {
          errors.push(`${at}: bad pattern: ${e.message}`);
        }
      }
      if ((c.op === 'equals') && typeof c.value !== 'string') errors.push(`${at}: equals needs a string value`);
      if ((c.op === 'in' || c.op === 'host_in') && !Array.isArray(c.values)) errors.push(`${at}: ${c.op} needs a values array`);
      return { ...c, fields, regex };
    });
    return { ...rule, mode, conditions: compiled };
  });
  if (errors.length) throw new Error('channel rules invalid:\n- ' + errors.join('\n- '));
  return {
    version: doc.version ?? null,
    directNeedsNoSession: doc.direct_checkout_needs_no_storefront_session !== false,
    rules,
  };
}

/** Flattens the order + enrichment into the signal names that rules refer to. */
export function buildSignals(order, enrichment = null, capture = {}) {
  const attrs = attributesOf(order);
  const names = capture.attributes ?? {};
  const landing = urlParams(order?.landing_site);
  const lastVisit = enrichment?.customerJourneySummary?.lastVisit ?? null;
  const visitParams = urlParams(lastVisit?.landingPage);
  const visitUtm = lastVisit?.utmParameters ?? {};

  const pick = (...vals) => {
    for (const v of vals) if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    return null;
  };

  return {
    source_name: pick(order?.source_name, enrichment?.sourceName),
    attribution: {
      handle: pick(enrichment?.attribution?.handle),
      display_name: pick(enrichment?.attribution?.displayName),
    },
    app: { name: pick(enrichment?.app?.name) },
    publication: { title: pick(enrichment?.publication?.catalog?.title) },
    landing_site: pick(order?.landing_site),
    referrer_host: hostOf(order?.referring_site) ?? hostOf(lastVisit?.referrerUrl),
    utm: {
      source: pick(landing.utm_source, visitUtm.source, visitParams.utm_source),
      medium: pick(landing.utm_medium, visitUtm.medium, visitParams.utm_medium),
      campaign: pick(landing.utm_campaign, visitUtm.campaign, visitParams.utm_campaign),
    },
    click_ids: {
      oppref: pick(landing.oppref, visitParams.oppref, firstAttribute(attrs, names.oppref ?? [])),
      gclid: pick(landing.gclid, visitParams.gclid, firstAttribute(attrs, names.gclid ?? [])),
      gbraid: pick(landing.gbraid, visitParams.gbraid, firstAttribute(attrs, names.gbraid ?? [])),
      wbraid: pick(landing.wbraid, visitParams.wbraid, firstAttribute(attrs, names.wbraid ?? [])),
      fbclid: pick(landing.fbclid, visitParams.fbclid, firstAttribute(attrs, names.fbclid ?? [])),
    },
    attributes: attrs,
    // Evidence that the buyer was on the online store: a landing page, cart attributes
    // written by the storefront, or a customer-journey visit.
    storefront_session: Boolean(
      pick(order?.landing_site) || Object.keys(attrs).length > 0 || lastVisit,
    ),
  };
}

export function getField(signals, path) {
  let cur = signals;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return null;
    cur = cur[part];
  }
  return cur === undefined ? null : cur;
}

function testCondition(cond, signals) {
  for (const field of cond.fields) {
    const raw = getField(signals, field);
    if (raw === null || raw === '') continue;
    const value = String(raw);
    const lower = value.toLowerCase();
    let hit = false;
    switch (cond.op) {
      case 'present':
        hit = true;
        break;
      case 'equals':
        hit = lower === cond.value.toLowerCase();
        break;
      case 'in':
        hit = cond.values.some((v) => lower === String(v).toLowerCase());
        break;
      case 'matches':
        hit = cond.regex.test(value);
        break;
      case 'host_in':
        hit = cond.values.some((d) => lower === d || lower.endsWith('.' + d));
        break;
    }
    if (hit) return { field, value, op: cond.op };
  }
  return null;
}

function describe(hit, cond) {
  const shown = hit.value.length > 60 ? hit.value.slice(0, 57) + '...' : hit.value;
  switch (hit.op) {
    case 'present': return `${hit.field} is present`;
    case 'matches': return `${hit.field} "${shown}" matches /${cond.pattern}/${cond.flags ?? 'i'}`;
    case 'host_in': return `${hit.field} "${shown}" is in [${cond.values.join(', ')}]`;
    default: return `${hit.field} = "${shown}"`;
  }
}

function matchRule(rule, signals) {
  const hits = [];
  for (const cond of rule.conditions) {
    const hit = testCondition(cond, signals);
    if (hit) hits.push(describe(hit, cond));
    else if (rule.mode === 'all') return null;
    if (hit && rule.mode === 'any') break;
  }
  return hits.length ? hits : null;
}

/**
 * @returns {{channel:string, confidence:string, reason:string, rule_confirmed:boolean,
 *   rule_id:string|null, checkout:string, note:string|null, also_matched:object[]}}
 */
export function classifyOrder(order, { rules, enrichment = null, capture = {} }) {
  if (!rules?.rules) throw new Error('classifyOrder: pass compiled rules (loadRules / compileRules)');
  const signals = buildSignals(order, enrichment, capture);
  const matches = [];
  for (const rule of rules.rules) {
    const hits = matchRule(rule, signals);
    if (hits) matches.push({ rule, hits });
  }

  if (matches.length === 0) {
    const seen = [
      `source_name=${signals.source_name ?? '-'}`,
      `attribution=${signals.attribution.display_name ?? signals.attribution.handle ?? '-'}`,
      `app=${signals.app.name ?? '-'}`,
      `referrer=${signals.referrer_host ?? '-'}`,
      `utm_source=${signals.utm.source ?? '-'}`,
    ].join(', ');
    return {
      channel: 'unknown',
      confidence: 'none',
      reason: `no rule matched (${seen})`,
      rule_confirmed: false,
      rule_id: null,
      checkout: 'unknown',
      note: enrichment ? null : 'no GraphQL enrichment: attribution, app and publication were not checked',
      also_matched: [],
    };
  }

  const { rule, hits } = matches[0];
  let checkout = rule.checkout;
  const notes = [];
  if (!rule.confirmed) notes.push(UNCONFIRMED_NOTE);
  if (checkout === 'direct' && rules.directNeedsNoSession && signals.storefront_session) {
    checkout = 'store';
    notes.push('rule says direct checkout, but the order shows a storefront session, so it is treated as store checkout');
  }
  return {
    channel: rule.channel,
    confidence: rule.confidence,
    reason: `${rule.id}: ${hits.join('; ')}`,
    rule_confirmed: rule.confirmed,
    rule_id: rule.id,
    checkout,
    note: notes.length ? notes.join(' | ') : null,
    also_matched: matches.slice(1).map((m) => ({ rule_id: m.rule.id, channel: m.rule.channel })),
  };
}
