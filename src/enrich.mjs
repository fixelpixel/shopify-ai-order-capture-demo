// Optional GraphQL Admin API lookup for order fields this demo does not expect in the webhook.
//
// Order.attribution exists from API version 2026-07 and replaces the deprecated
// Order.channelInformation. Order.publication is the sales channel the order was created
// from; Publication.name is deprecated, so the catalog title is read instead.
// Order.customerJourneySummary.lastVisit gives source, referrer, landing page and UTMs of the
// last online-store visit (probably empty for direct-checkout orders, which never visit the store).
// https://shopify.dev/docs/api/admin-graphql/latest/objects/Order (read 2026-10-02)
//
// Shopify's Events (API 2026-10) can attach a GraphQL query result to an Order event, which
// could replace this follow-up call; that is untested here.

export const ORDER_CHANNEL_QUERY = `query OrderChannel($id: ID!) {
  order(id: $id) {
    id
    name
    sourceName
    attribution { handle displayName }
    app { id name }
    publication { id catalog { title } }
    customerJourneySummary {
      ready
      lastVisit {
        source
        referrerUrl
        landingPage
        utmParameters { source medium campaign }
      }
    }
  }
}`;

export const MIN_API_VERSION_FOR_ATTRIBUTION = '2026-07';

export function orderGid(order) {
  return order?.admin_graphql_api_id ?? `gid://shopify/Order/${order?.id}`;
}

/**
 * Live enricher. Used only when SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN are set for the server.
 * Errors are thrown to the caller; the pipeline then classifies from webhook fields only.
 */
export function createAdminEnricher({ shopDomain, accessToken, apiVersion = MIN_API_VERSION_FOR_ATTRIBUTION, fetchImpl = globalThis.fetch, timeoutMs = 4000 }) {
  if (!shopDomain || !accessToken) throw new Error('createAdminEnricher needs shopDomain and accessToken');
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  return async function enrich(order) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': accessToken },
      body: JSON.stringify({ query: ORDER_CHANNEL_QUERY, variables: { id: orderGid(order) } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Admin API ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(`Admin API: ${json.errors.map((e) => e.message).join('; ')}`);
    return json.data?.order ?? null;
  };
}

/** Enricher backed by a map of order id -> GraphQL order fields (used by the demo and tests). */
export function mapEnricher(byOrderId) {
  return async (order) => byOrderId.get(String(order?.id)) ?? null;
}
