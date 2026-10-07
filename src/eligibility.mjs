// The send rule for ad platforms. Builds would-be payloads; makes no network calls.
//
//   Meta Conversions API   only with fbp or fbc, or a hashed email whose consent was captured
//   Google Ads             only with gclid, gbraid or wbraid
//   ChatGPT Ads (OpenAI)   only with an oppref
//
// Without an identifier the order is skipped with an explicit reason. AI direct-checkout
// orders complete inside the AI surface, so no storefront cookie or click id is expected on them.
//
// Payload shapes, read 2026-10-02:
// - Meta: event_time up to 7 days back (seconds); event_source_url and client_user_agent
//   are required for action_source "website"; fbc = fb.1.<ms first observed>.<fbclid>,
//   fbp/fbc are not hashed, email is SHA-256 of the trimmed lowercase value.
//   https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/
// - Google Ads: the Google Ads API page says UploadClickConversions now fails for developer
//   tokens that never uploaded conversions before 15 June 2026 and points to the Data Manager
//   API, so the payload is an IngestEventsRequest (POST datamanager.googleapis.com/v1/events:ingest).
//   https://developers.google.com/google-ads/api/docs/conversions/upload-clicks
//   https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/upgrade/field-mappings
// - OpenAI: POST bzr.openai.com/v1/events?pid=<PIXEL_ID>; event id, type, timestamp_ms
//   (last 7 days, max 10 minutes ahead), oppref at event level, obref unhashed in user,
//   amount as an integer in minor units; dedup on Pixel ID + event name + id.
//   https://developers.openai.com/ads/conversions-api

import {
  attributesOf, consentState, firstAttribute, fromMinor, lineDiscountMinor, moneyOf, orderCurrency,
  orderEmail, orderTimeMs, sha256Hex, storeOriginUrl, urlParams,
} from './order.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export function extractIdentifiers(order, capture, now = Date.now()) {
  const attrs = attributesOf(order);
  const names = capture?.attributes ?? {};
  const landing = urlParams(order?.landing_site);
  const from = (key, paramName = key) => firstAttribute(attrs, names[key] ?? []) ?? landing[paramName] ?? null;

  const fbclid = from('fbclid');
  let fbc = firstAttribute(attrs, names.fbc ?? []);
  let fbcSource = fbc ? 'cookie' : null;
  if (!fbc && fbclid) {
    // Meta: when building fbc from an fbclid, use the time the fbclid was first observed.
    // The server first sees it in the order, so the order time is used.
    fbc = `fb.1.${orderTimeMs(order) ?? now}.${fbclid}`;
    fbcSource = 'built_from_fbclid';
  }
  const email = orderEmail(order);
  return {
    fbp: firstAttribute(attrs, names.fbp ?? []),
    fbc,
    fbc_source: fbcSource,
    gclid: from('gclid'),
    gbraid: from('gbraid'),
    wbraid: from('wbraid'),
    oppref: from('oppref'),
    obref: firstAttribute(attrs, names.obref ?? []),
    email_sha256: email ? sha256Hex(email) : null,
    consent: consentState(attrs, capture),
  };
}

function orderMoney(order, capture) {
  const source = capture?.money_source ?? 'shop';
  const currency = orderCurrency(order, source);
  const total = moneyOf(order, 'total_price', source, currency);
  const lines = (order.line_items ?? []).filter((li) => Number(li.quantity) > 0).map((li) => {
    const quantity = Number(li.quantity);
    const unit = moneyOf(li, 'price', source, currency)?.minor ?? 0;
    const unitDiscount = Math.round(lineDiscountMinor(li, source, currency) / quantity);
    return { li, quantity, unitMinor: unit - unitDiscount };
  });
  return { currency, totalMinor: total?.minor ?? 0, lines };
}

function skip(platform, reason, notes = []) {
  return { platform, eligible: false, reason, identifiers_used: [], notes, payload: null };
}

function channelNote(classification, ownChannel, platformName) {
  if (classification.channel !== ownChannel) return [];
  return [`check whether ${platformName} already credits its own direct-checkout orders before sending this one, or it may be counted twice`];
}

export function metaDecision(order, classification, ids, { capture, now }) {
  const platform = 'meta_capi';
  const cfg = capture?.platforms?.meta ?? {};
  const notes = channelNote(classification, 'meta_ai', 'Meta');
  if (capture?.consent?.require_for_all_ad_platforms && ids.consent !== true) {
    return skip(platform, 'no captured ad consent and consent is required for all ad platforms', notes);
  }
  const used = [];
  if (ids.fbp) used.push('fbp');
  if (ids.fbc) used.push(ids.fbc_source === 'built_from_fbclid' ? 'fbc (built from fbclid)' : 'fbc');
  const emailUsable = Boolean(ids.email_sha256 && ids.consent === true);
  if (emailUsable) used.push('email_sha256 (consent granted)');
  if (used.length === 0) {
    const why = ids.email_sha256
      ? ids.consent === false ? 'email present but consent was denied' : 'email present but no consent signal was captured'
      : 'no email';
    return skip(platform, `no fbp, no fbc and no consented email (${why})`, notes);
  }
  const eventMs = orderTimeMs(order) ?? now;
  const maxAge = (cfg.max_event_age_days ?? 7) * DAY_MS;
  if (now - eventMs > maxAge) return skip(platform, `order is older than ${cfg.max_event_age_days ?? 7} days; Meta accepts event_time up to 7 days back`, notes);

  const money = orderMoney(order, capture);
  const ua = order.client_details?.user_agent ?? null;
  const sourceUrl = storeOriginUrl(order);
  const website = Boolean(ua && sourceUrl);
  if (!website) notes.push('no browser user agent or source URL on the order, so action_source is "other" (Meta requires both for "website")');
  notes.push('event_id must equal the eventID of the browser Purchase event for Meta to deduplicate; the order id is used here');
  const userData = Object.fromEntries(Object.entries({
    fbp: ids.fbp ?? undefined,
    fbc: ids.fbc ?? undefined,
    em: emailUsable ? [ids.email_sha256] : undefined,
    client_ip_address: order.client_details?.browser_ip ?? order.browser_ip ?? undefined,
    client_user_agent: ua ?? undefined,
  }).filter(([, v]) => v !== undefined));
  const event = {
    event_name: 'Purchase',
    event_time: Math.floor(eventMs / 1000),
    event_id: String(order.id),
    action_source: website ? 'website' : 'other',
    ...(website ? { event_source_url: sourceUrl } : {}),
    user_data: userData,
    custom_data: {
      currency: money.currency,
      value: fromMinor(money.totalMinor, money.currency),
      order_id: String(order.id),
      content_type: 'product',
      contents: money.lines.map(({ li, quantity, unitMinor }) => ({
        id: String(li.sku || li.variant_id || li.product_id || li.id),
        quantity,
        item_price: fromMinor(unitMinor, money.currency),
      })),
      num_items: money.lines.reduce((n, l) => n + l.quantity, 0),
    },
  };
  return {
    platform,
    eligible: true,
    reason: `has ${used.join(', ')}`,
    identifiers_used: used,
    notes,
    payload: { method: 'POST', endpoint: cfg.endpoint, body: { data: [event] } },
  };
}

export function googleAdsDecision(order, classification, ids, { capture, now }) {
  const platform = 'google_ads';
  const cfg = capture?.platforms?.google_ads ?? {};
  const notes = channelNote(classification, 'google_ai', 'Google Ads');
  if (capture?.consent?.require_for_all_ad_platforms && ids.consent !== true) {
    return skip(platform, 'no captured ad consent and consent is required for all ad platforms', notes);
  }
  const adIdentifiers = Object.fromEntries(
    ['gclid', 'gbraid', 'wbraid'].filter((k) => ids[k]).map((k) => [k, ids[k]]),
  );
  const used = Object.keys(adIdentifiers);
  if (used.length === 0) return skip(platform, 'no gclid, gbraid or wbraid on the order', notes);

  const money = orderMoney(order, capture);
  const eventMs = orderTimeMs(order) ?? now;
  const consentValue = ids.consent === true ? 'CONSENT_GRANTED' : ids.consent === false ? 'CONSENT_DENIED' : null;
  if (!consentValue) notes.push('no consent signal captured; consent left unset (Google warns conversions may then not be attributable)');
  const event = {
    adIdentifiers,
    conversionValue: fromMinor(money.totalMinor, money.currency),
    currency: money.currency,
    eventTimestamp: new Date(eventMs).toISOString(),
    transactionId: String(order.id),
    eventSource: 'WEB',
    ...(consentValue ? { consent: { adUserData: consentValue, adPersonalization: consentValue } } : {}),
  };
  return {
    platform,
    eligible: true,
    reason: `has ${used.join(', ')}`,
    identifiers_used: used,
    notes,
    payload: {
      method: 'POST',
      endpoint: cfg.endpoint,
      body: {
        destinations: [{
          operatingAccount: { accountType: 'GOOGLE_ADS', accountId: cfg.operating_account_id },
          productDestinationId: cfg.conversion_action_id,
        }],
        encoding: 'HEX',
        validateOnly: true,
        events: [event],
      },
    },
  };
}

export function openaiDecision(order, classification, ids, { capture, now }) {
  const platform = 'openai_capi';
  const cfg = capture?.platforms?.openai ?? {};
  const notes = [];
  if (capture?.consent?.require_for_all_ad_platforms && ids.consent !== true) {
    return skip(platform, 'no captured ad consent and consent is required for all ad platforms', notes);
  }
  if (!ids.oppref) return skip(platform, 'no oppref (ChatGPT Ads click reference) on the order', notes);
  const eventMs = orderTimeMs(order) ?? now;
  if (now - eventMs > (cfg.max_event_age_days ?? 7) * DAY_MS) {
    return skip(platform, 'order is older than 7 days; the Conversions API accepts timestamps from the last 7 days only', notes);
  }
  if (eventMs - now > (cfg.max_future_minutes ?? 10) * 60_000) {
    return skip(platform, 'order time is more than 10 minutes in the future', notes);
  }
  const money = orderMoney(order, capture);
  const used = ['oppref'];
  const user = {};
  if (ids.obref && ids.consent !== false) {
    user.obref = ids.obref;
    used.push('obref');
  }
  if (ids.email_sha256 && ids.consent === true) {
    user.emails_sha256 = [ids.email_sha256];
    used.push('email_sha256 (consent granted)');
  }
  const ip = order.client_details?.browser_ip ?? order.browser_ip;
  const ua = order.client_details?.user_agent;
  if (ip) user.ip_address = ip;
  if (ua) user.user_agent = ua;
  const sourceUrl = storeOriginUrl(order);
  if (!sourceUrl) notes.push('no store URL on the order, so action_source is "other" (source_url is required for "web")');
  notes.push('id must equal the pixel event_id of the browser order_created event for OpenAI to deduplicate; the order id is used here');
  const event = {
    id: String(order.id),
    type: 'order_created',
    timestamp_ms: eventMs,
    oppref: ids.oppref,
    action_source: sourceUrl ? 'web' : 'other',
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    ...(Object.keys(user).length ? { user } : {}),
    data: {
      type: 'contents',
      amount: money.totalMinor,
      currency: money.currency,
      contents: money.lines.map(({ li, quantity, unitMinor }) => ({
        id: String(li.sku || li.variant_id || li.product_id || li.id),
        name: li.title ?? undefined,
        content_type: 'product',
        quantity,
        amount: unitMinor,
        currency: money.currency,
      })),
    },
  };
  return {
    platform,
    eligible: true,
    reason: `has ${used.join(', ')}`,
    identifiers_used: used,
    notes,
    payload: {
      method: 'POST',
      endpoint: cfg.endpoint,
      headers: { authorization: 'Bearer <CONVERSIONS_API_KEY>' },
      body: { validate_only: true, events: [event] },
    },
  };
}

/**
 * @returns {{meta:object, google_ads:object, openai:object, identifiers:object}}
 */
export function evaluateEligibility(order, classification, { capture, now = Date.now() }) {
  const ids = extractIdentifiers(order, capture, now);
  return {
    identifiers: {
      fbp: Boolean(ids.fbp), fbc: ids.fbc_source, gclid: Boolean(ids.gclid), gbraid: Boolean(ids.gbraid),
      wbraid: Boolean(ids.wbraid), oppref: Boolean(ids.oppref), obref: Boolean(ids.obref),
      email: Boolean(ids.email_sha256), consent: ids.consent,
    },
    meta: metaDecision(order, classification, ids, { capture, now }),
    google_ads: googleAdsDecision(order, classification, ids, { capture, now }),
    openai: openaiDecision(order, classification, ids, { capture, now }),
  };
}

