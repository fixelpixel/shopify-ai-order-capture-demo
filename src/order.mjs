// Helpers for reading Shopify order payloads (REST / webhook shape).
// Money is handled in integer minor units to avoid floating-point drift.

import { createHash } from 'node:crypto';

// ISO 4217 currencies whose minor unit is not 2 decimals.
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG',
  'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyExponent(currency) {
  const code = String(currency ?? '').toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** "42.00" + "USD" -> 4200. Rounds half away from zero at the currency's minor unit. */
export function toMinor(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return null;
  const exp = currencyExponent(currency);
  const text = typeof amount === 'number' ? amount.toFixed(exp + 3) : String(amount).trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new TypeError(`not a money amount: ${JSON.stringify(amount)}`);
  const [, neg, int, frac = ''] = m;
  const digits = (frac + '0'.repeat(exp + 1)).slice(0, exp + 1);
  let minor = BigInt(int) * 10n ** BigInt(exp) + BigInt(digits.slice(0, exp) || '0');
  if (Number(digits[exp]) >= 5) minor += 1n;
  const n = Number(minor);
  return neg && n !== 0 ? -n : n;
}

/** 4200 + "USD" -> 42 (number). */
export function fromMinor(minor, currency) {
  const exp = currencyExponent(currency);
  return Number((minor / 10 ** exp).toFixed(exp));
}

/** 4200 + "USD" -> "42.00" (string, for CSV output). */
export function formatMinor(minor, currency) {
  const exp = currencyExponent(currency);
  return (minor / 10 ** exp).toFixed(exp);
}

export function orderCurrency(order, source = 'shop') {
  if (source === 'presentment') return order?.presentment_currency || order?.currency || null;
  return order?.currency || null;
}

/**
 * Reads a money field. Prefers the `<field>_set` object (shop_money / presentment_money);
 * falls back to the plain string field in `fallbackCurrency`.
 */
export function moneyOf(obj, field, source = 'shop', fallbackCurrency = null) {
  const set = obj?.[`${field}_set`];
  const money = set && (source === 'presentment' ? set.presentment_money : set.shop_money);
  if (money && money.amount !== undefined && money.amount !== null) {
    return { minor: toMinor(money.amount, money.currency_code), currency: money.currency_code };
  }
  const raw = obj?.[field];
  if (raw === undefined || raw === null || raw === '') return null;
  return { minor: toMinor(raw, fallbackCurrency), currency: fallbackCurrency };
}

/** Line-level discount in minor units (discount_allocations first, then total_discount). */
export function lineDiscountMinor(lineItem, source, currency) {
  const allocations = lineItem?.discount_allocations;
  if (Array.isArray(allocations) && allocations.length) {
    return allocations.reduce((sum, a) => sum + (moneyOf(a, 'amount', source, currency)?.minor ?? 0), 0);
  }
  return moneyOf(lineItem, 'total_discount', source, currency)?.minor ?? 0;
}

/** note_attributes ([{name, value}]) or GraphQL-style ([{key, value}]) -> plain object. */
export function attributesOf(order) {
  const out = {};
  const list = order?.note_attributes ?? order?.attributes ?? order?.customAttributes ?? [];
  if (!Array.isArray(list)) return out;
  for (const a of list) {
    const key = a?.name ?? a?.key;
    if (key === undefined || key === null) continue;
    if (a.value === undefined || a.value === null || String(a.value).trim() === '') continue;
    out[String(key)] = String(a.value).trim();
  }
  return out;
}

export function firstAttribute(attributes, names = []) {
  for (const name of names) {
    if (attributes[name] !== undefined) return attributes[name];
  }
  return null;
}

/** Query parameters of a landing URL (relative like "/p?x=1" or absolute). First value wins. */
export function urlParams(urlLike) {
  if (!urlLike) return {};
  try {
    const u = new URL(String(urlLike), 'https://landing.invalid');
    const out = {};
    for (const [k, v] of u.searchParams) if (!(k in out) && v !== '') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Hostname of an absolute URL, lowercased; null when the value is empty or relative. */
export function hostOf(urlLike) {
  if (!urlLike) return null;
  try {
    return new URL(String(urlLike)).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * A source URL for ad-platform events. order_status_url carries the order's access token
 * (in the path and the key= parameter), so only its origin is used.
 */
export function storeOriginUrl(order) {
  if (!order?.order_status_url) return null;
  try {
    return `${new URL(order.order_status_url).origin}/`;
  } catch {
    return null;
  }
}

export function orderTimeMs(order) {
  const t = Date.parse(order?.processed_at || order?.created_at || '');
  return Number.isFinite(t) ? t : null;
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Trim + lowercase, as both Meta and OpenAI ask before hashing an email. */
export function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  return e.includes('@') ? e : null;
}

export function orderEmail(order) {
  return normalizeEmail(order?.email ?? order?.contact_email ?? order?.customer?.email ?? null);
}

/** true = granted, false = denied, null = no signal captured. */
export function consentState(attributes, capture) {
  const raw = firstAttribute(attributes, capture?.attributes?.ad_consent ?? []);
  if (raw === null) return null;
  const v = raw.toLowerCase();
  if ((capture?.consent?.granted_values ?? []).includes(v)) return true;
  if ((capture?.consent?.denied_values ?? []).includes(v)) return false;
  return null;
}
