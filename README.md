# Shopify AI-channel order capture demo

Built by Daniil Maximkin (taskfordaniel.com).

Server-side capture of Shopify orders that come from AI shopping channels, for stores that want those orders in GA4 and, where possible, in their ad platforms.

This demo accompanies the [AI shopping channels page on taskfordaniel.com](https://taskfordaniel.com/services/ai-shopping-channels/).

Shopify sells through four AI channels: ChatGPT, Google AI Mode and Gemini, Microsoft Copilot, and Meta. In Google AI Mode/Gemini, Copilot and Meta direct checkout, the buyer pays inside the AI surface. Shopify says Google Analytics and custom pixels do not fire there. ChatGPT has no direct checkout: buyers finish on the store's own checkout, where the browser tags run but attribution can break. This project:

1. receives Shopify order webhooks and verifies their HMAC signature;
2. drops duplicate deliveries using the header Shopify recommends for that (`X-Shopify-Webhook-Id`);
3. labels each order with a channel (`chatgpt`, `google_ai`, `copilot`, `meta_ai`, `shop`, `other_agent`, `web`, `unknown`) from rules in a JSON file, and marks each label as confirmed or unconfirmed;
4. builds a GA4 Measurement Protocol `purchase` with `transaction_id` = Shopify order id and the channel label as event parameters. It is a dry run by default and posts only when asked;
5. decides per ad platform (Meta Conversions API, Google Ads, ChatGPT Ads Conversions API) whether the order carries an identifier the platform can match, and builds the would-be payload. It never sends to ad platforms;
6. writes every decision to a JSONL ledger;
7. reconciles a week of Shopify orders against a GA4 export and the ledger, per channel, with a reason for every gap.

All fixtures are synthetic (`demo-store.example`, made-up ids). Node 22, ES modules, no runtime dependencies.

## Run it

```sh
node scripts/demo.mjs --out out  # runs the fixtures end to end, writes out/
node --test               # unit and end-to-end tests
```

The demo starts the real HTTP server on a random local port, posts 31 signed webhook deliveries (including a tampered one, a Shopify retry, an unhandled topic and a test order), then runs the weekly reconciliation:

```
GA4 mode: dry-run (default: payloads are built, nothing is posted)
Deliveries posted: 31  HTTP: 200x30 401x1
Server: accepted 28, duplicate 1, rejected (bad HMAC) 1, ignored topic 1
Ledger outcomes: captured 23, already_captured 2, refund 1, duplicate_delivery 1, waiting 1, ignored 1, ignored_topic 1
GA4 purchases: built_dry_run 16, skipped 7; refunds 1; synthetic client_id 14
Ad platforms (dry run, nothing sent): Meta 3, Google Ads 2, ChatGPT Ads 2 eligible of 23 captured orders

Reconciliation 2026-09-26 .. 2026-10-03 (revenue in USD):
channel      orders  net_rev  in_ga4  missing  mp_built  mp_skip  meta  gads  openai  unconf  no_ledger
chatgpt      5       467.64   3       2        2         2        1     0     2       1       1
google_ai    3       320.76   0       3        3         0        0     0     0       3       0
copilot      3       248.40   0       3        2         1        0     0     0       3       0
meta_ai      3       296.28   0       3        2         1        0     0     0       3       0
shop         2       95.04    1       1        1         1        0     0     0       2       0
other_agent  2       117.72   1       1        1         1        0     0     0       2       0
web          5       394.85   5       0        4         1        2     2     0       0       0
unknown      1       226.80   0       1        1         0        0     0     0       0       0
TOTAL        24      2167.49  10      14       16        7        3     2     2       14      1

GA4-only transactions: 1; test orders excluded: 1
Wrote out/ledger.jsonl
Wrote out/reconciliation.csv
Wrote out/reconciliation-orders.csv
```

Outputs:

- `out/ledger.jsonl`: one line per delivery, with the classification, the GA4 decision and payload, and the ad-platform decisions and payloads.
- `out/reconciliation.csv`: one row per channel plus `TOTAL`.
- `out/reconciliation-orders.csv`: one row per order (and per GA4-only transaction), with the reason for every gap.

## Data flow

```
Shopify ──POST /webhooks/orders──▶ verify HMAC ──401 if bad
          orders/create              │
          orders/paid                ▼
          refunds/create        dedup on X-Shopify-Webhook-Id ──200 "duplicate"
                                     │
                                     ▼
                               200 "accepted"  (answer first, work after)
                                     │
                    ┌────────────────┴──────────────────┐
                    ▼                                   ▼
        GraphQL Admin API lookup (optional)    test order? ── ignored
        Order.attribution / app / publication  not paid yet? ── waiting for orders/paid
        customerJourneySummary                 already captured? ── skip (create + paid both arrive)
                    │
                    ▼
            classify (config/channel-rules.json)
                    │
          ┌─────────┴──────────────┐
          ▼                        ▼
   GA4 MP purchase           eligibility per ad platform
   build + limit checks      Meta / Google Ads / ChatGPT Ads
   policy: send or skip      eligible + payload, or skip + reason
   dry-run | validate | send (never sent)
          │                        │
          └──────────┬─────────────┘
                     ▼
              ledger.jsonl ──▶ weekly reconcile ◀── Shopify order export + GA4 export
                                     │
                                     ▼
                     reconciliation.csv, reconciliation-orders.csv
```

Shopify allows one second to connect and five seconds for the whole webhook request, treats any non-2xx (including 3xx) as a failure, retries 8 times over 4 hours, and deletes an Admin-API subscription after 8 failures in a row. The server therefore answers 200 as soon as the delivery is verified and recorded in the dedup store, then processes it. Shopify also advises a periodic reconciliation job for anything the webhooks miss; that is the role of `src/reconcile.mjs`.

## Layout

```
.
|-- .env.example             environment variable template (no credentials)
|-- .gitignore               generated outputs, dependencies and environment files
|-- LICENSE                  Apache-2.0
|-- README.md
|-- package.json             Node version and npm scripts; no runtime dependencies
|-- config/
|   |-- channel-rules.json   classifier rules
|   `-- capture.json         attribute names, consent values, GA4 policy, platform endpoints
|-- fixtures/                synthetic orders, deliveries, Shopify and GA4 exports
|-- scripts/
|   `-- demo.mjs             end-to-end demo
|-- src/
|   |-- verify.mjs           HMAC-SHA256 of the raw body, base64 header, timing-safe compare, secret rotation
|   |-- dedup.mjs            duplicate-delivery guard; in-memory or JSONL file store; TTL
|   |-- classify.mjs         order + GraphQL fields -> {channel, confidence, reason, rule_confirmed}
|   |-- ga4.mjs              Measurement Protocol purchase/refund payloads, limit checks, send policy, sender
|   |-- eligibility.mjs      ad-platform send rule and would-be payloads (no network code)
|   |-- enrich.mjs           GraphQL query for Order.attribution / app / publication / customerJourneySummary
|   |-- pipeline.mjs         classify -> GA4 -> eligibility for one delivery
|   |-- server.mjs           POST /webhooks/orders; also the server CLI
|   |-- reconcile.mjs        weekly reconciliation; also a CLI
|   |-- ledger.mjs           JSONL ledger helper
|   |-- csv.mjs              CSV helpers
|   |-- order.mjs            order helpers
|   `-- config.mjs           capture config loader
`-- test/                    node:test suites
```

## Run the server

```sh
cp .env.example .env        # fill in SHOPIFY_API_SECRET at least
node --env-file=.env src/server.mjs              # dry run
node --env-file=.env src/server.mjs --validate   # posts to /debug/mp/collect (nothing recorded)
node --env-file=.env src/server.mjs --send       # posts to /mp/collect
```

`--validate` and `--send` take effect only when both `GA4_MEASUREMENT_ID` and `GA4_API_SECRET` are set. Otherwise the server stays in dry run and says why at startup.

Subscribe the app to `orders/create`, `orders/paid` and `refunds/create` with the endpoint `https://<host>/webhooks/orders`. Other topics get a 200 and are ignored.

| Variable | Purpose |
|---|---|
| `SHOPIFY_API_SECRET` | App client secret for the HMAC check (required). |
| `SHOPIFY_API_SECRET_PREVIOUS` | Old secret during rotation. Shopify notes a rotated secret can take up to an hour to apply. |
| `SHOPIFY_SHOP`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_API_VERSION` | Turns on the GraphQL lookup. `Order.attribution` needs API version 2026-07 or later. Without it, only webhook fields are classified. |
| `GA4_MEASUREMENT_ID`, `GA4_API_SECRET`, `GA4_REGION` | Measurement Protocol credentials; `GA4_REGION=eu` uses `region1.google-analytics.com`. |
| `PORT`, `HOST`, `LEDGER_PATH` | Listener and ledger location (`data/ledger.jsonl` by default). |
| `DEDUP_STORE=file`, `DEDUP_PATH`, `PURCHASE_DEDUP_PATH` | Keep dedup keys across restarts in JSONL files. For several instances, plug in a shared store with an atomic `markIfNew` (for example Redis `SET NX PX`). |
| `CAPTURE_CONFIG`, `CHANNEL_RULES` | Alternative config files. |

### What the storefront must capture

Server-side code cannot read browser cookies. To give GA4 a real `client_id` and ad platforms a matchable identifier, the theme has to copy these values into cart attributes, which Shopify carries onto the order as `note_attributes`. The names are configurable in `config/capture.json`:

| Attribute | Value | Used for |
|---|---|---|
| `_ga` | the `_ga` cookie (`GA1.1.<id>.<ts>`) | GA4 `client_id` (reduced to `<id>.<ts>`, the non-cookie form Google recommends) |
| `ga_session_id` | numeric GA session id | GA4 `session_id` |
| `_fbp`, `_fbc` | Meta cookies | Meta CAPI |
| `_gclid`, `_gbraid`, `_wbraid` | Google click ids (also read from the landing URL) | Google Ads |
| `__oppref`, `__obref` | ChatGPT Ads pixel cookies (oppref is also read from the landing URL) | ChatGPT Ads CAPI |
| `_consent_marketing` | `granted` / `denied` | gates hashed email; optionally gates everything |

Copy ad cookies only when the visitor's consent allows it. AI direct-checkout orders complete inside the AI surface, so these attributes are not expected on them.

## Channel rules

Rules are evaluated top to bottom and the first match wins. Other matches are listed in `also_matched`. Each result carries `rule_confirmed`. `true` means a primary source documents that the signal marks the channel. `false` means the rule is a starting pattern, and the result says *"unconfirmed: verify on the store's real orders before trusting the label"*.

As of 2 October 2026, Shopify documents the fields that identify an order's source (`Order.attribution`, `Order.app`, `Order.publication`, `sourceName`). It does not document the values that orders from its AI channels carry in them. Every rule that reads those fields is therefore unconfirmed.

| Rule | Channel | Checkout | Signal | Status |
|---|---|---|---|---|
| `google-ai-order-source` | google_ai | direct | attribution / app / publication / sourceName matches `gemini\|ai[ _-]?mode` | unconfirmed |
| `copilot-order-source` | copilot | direct | same fields match `copilot` | unconfirmed |
| `meta-ai-order-source` | meta_ai | direct | same fields match `^meta$`, `^meta ai`, `muse` | unconfirmed |
| `meta-sales-channel-app` | meta_ai (low) | unknown | attribution / app / publication match `facebook\|instagram` | unconfirmed |
| `shop-order-source` | shop | unknown | attribution / app / publication equal `Shop` | unconfirmed |
| `chatgpt-order-source` | chatgpt | store | same fields match `chatgpt\|openai` | unconfirmed |
| `chatgpt-ads-oppref` | chatgpt | store | `oppref` in the landing URL or `__oppref` attribute | confirmed (OpenAI) |
| `chatgpt-utm-source` | chatgpt | store | `utm_source=chatgpt.com` | confirmed (OpenAI) |
| `chatgpt-referrer` | chatgpt | store | referrer `chatgpt.com`, `chat.openai.com` | unconfirmed |
| `gemini-referrer` | google_ai | store | referrer `gemini.google.com` | unconfirmed |
| `copilot-referrer` | copilot | store | referrer `copilot.microsoft.com`, `copilot.com` | unconfirmed |
| `meta-ai-referrer` | meta_ai | store | referrer `meta.ai` | unconfirmed |
| `shop-referrer` | shop | store | referrer `shop.app`, `shop.com` | unconfirmed |
| `agentic-commerce-utm` | other_agent (low) | store | `utm_medium=agentic_commerce` (example value in Shopify's Checkout MCP docs) | unconfirmed |
| `other-ai-referrer` | other_agent | store | referrer `perplexity.ai`, `claude.ai` | unconfirmed |
| `online-store-web` | web | store | `source_name=web`, after no AI rule matched | confirmed (Shopify) |
| (none) | unknown | unknown | nothing matched | n/a |

GA4 counts Google AI Mode traffic as Organic Search, and a referrer rule cannot tell it apart from search either, so AI Mode referrals are not labelled. AI Mode direct-checkout orders are labelled through the order-source rules.

A rule with `checkout: direct` is downgraded to `store` when the order shows a storefront session (landing page, cart attributes or a customer-journey visit). Shopify sends buyers outside the direct-checkout countries to the online store instead.

Rule format:

```json
{
  "id": "copilot-order-source",
  "channel": "copilot",
  "checkout": "direct",
  "confidence": "medium",
  "confirmed": false,
  "status": "unconfirmed: verify on the store's real orders before trusting the label",
  "basis": "why this rule exists",
  "sources": ["https://..."],
  "any": [{ "fields": ["attribution.display_name", "app.name"], "op": "matches", "pattern": "copilot" }]
}
```

Operators: `present`, `equals`, `in`, `matches` (regex, case-insensitive by default), `host_in` (domain or subdomain). Use `any` or `all`. Signal names: `attribution.handle`, `attribution.display_name`, `app.name`, `publication.title`, `source_name`, `referrer_host`, `utm.source|medium|campaign`, `click_ids.oppref|gclid|gbraid|wbraid|fbclid`, `attributes.<name>`. The loader rejects unknown channels, unknown operators, bad regexes, confirmed rules without a source, and unconfirmed rules without the status text.

To confirm a rule: look at real AI-channel orders in the store (Admin API `order { attribution { handle displayName } app { name } publication { catalog { title } } sourceName }`), replace the pattern with the observed value, set `confirmed: true` and add the source (for example the order ids checked and the date).

## GA4 Measurement Protocol

The payload for one order:

```json
{
  "client_id": "1693645852.1662039448",
  "timestamp_micros": 1790609400000000,
  "events": [{
    "name": "purchase",
    "params": {
      "transaction_id": "990000000106",
      "value": 118, "currency": "USD", "tax": 9.44, "shipping": 0,
      "ai_channel": "google_ai", "ai_channel_confidence": "medium",
      "ai_label_status": "unconfirmed", "ai_checkout": "direct",
      "client_id_source": "synthetic", "capture_source": "server_mp",
      "items": [{ "item_id": "DEMO-LIN-01", "item_name": "Linen Shirt", "item_variant": "M / Sand",
                  "item_brand": "Demo Goods Co.", "price": 59, "quantity": 2 }]
    }
  }]
}
```

- `transaction_id` is the Shopify order id. It is always a non-empty string, because GA4 deduplicates purchases that share a transaction ID (web streams only) and collapses all purchases sent with an empty one.
- `value` is the sum of item price × quantity after discounts, without shipping or tax, as Google's `purchase` reference describes. `tax` and `shipping` are separate parameters. Money comes from `shop_money` by default (`money_source: "presentment"` switches to the buyer's currency).
- `client_id` comes from the captured `_ga` attribute when present (`client_id_source: "ga_cookie"`). Otherwise it is a deterministic synthetic id derived from shop + order id (`client_id_source: "synthetic"`), so retries and later refunds reuse it. A synthetic id has no session, device or ad click to join, and the ledger notes that reporting will be partial.
- The channel parameters show up in reports only after they are registered as event-scoped custom dimensions in GA4 (`ai_channel`, `ai_label_status`, `ai_checkout`, `client_id_source`, `capture_source`).
- Limits checked before sending (Google's Measurement Protocol docs): at most 25 events per request and 25 parameters per event; names of at most 40 characters (letters, digits, underscores, starting with a letter); parameter values of at most 100 characters (longer item names are truncated and noted); at most 10 custom item parameters; a body under 130 kB; timestamps backdated at most 72 hours.

Send policy (`config/capture.json` → `ga4.policy`, per checkout type):

| Checkout | Default | Why |
|---|---|---|
| `direct` | `send` | Shopify says GA and custom pixels do not fire in Google, Copilot and Meta direct checkout, so the server event is the only GA4 record. |
| `store` | `send_if_client_id` | The browser tag also records the purchase. With the same `client_id`, GA4's transaction-ID dedup applies to the same user. Google's article is ambiguous about dedup across different client ids, so a synthetic id is not sent. |
| `unknown` | `send_if_client_id` | Same caution (Shop orders, ambiguous Meta app orders). Change to `send` once real orders show the browser tag does not record them. |

Orders more than 72 hours old are not sent. There is no backfill.

Modes: `dry-run` builds payloads only (default). `validate` posts to `/debug/mp/collect` with `validation_behavior: ENFORCE_RECOMMENDATIONS` and stores the validation messages; nothing is recorded in GA4. `send` posts to `/mp/collect`. The Measurement Protocol answers 2xx even for malformed events, so `validate` is the way to check payloads, and the reconciliation is the way to check that events arrived. A failed send releases the order so the next delivery for it (for example `orders/paid`) can retry.

`refunds/create` produces a GA4 `refund` event for the same `transaction_id`, using the client id of the purchase.

## Ad platforms

Nothing is sent to Meta, Google or OpenAI. Each decision is either `eligible` with a would-be payload or `skip` with a reason.

| Platform | Sent only with | Would-be request |
|---|---|---|
| Meta Conversions API | `fbp` or `fbc` (`fbc` is built as `fb.1.<order time ms>.<fbclid>` when only `fbclid` is known), or a SHA-256 hashed email with consent granted | `POST graph.facebook.com/<version>/<pixel>/events`, `Purchase`, `event_time` in seconds (at most 7 days back), `action_source: website` only when a user agent and source URL exist |
| Google Ads | `gclid`, `gbraid` or `wbraid` | Data Manager API `POST datamanager.googleapis.com/v1/events:ingest` with `adIdentifiers`, `transactionId`, `conversionValue`, `consent` when captured. Google's Ads API page says click-conversion uploads now fail for developer tokens that had not uploaded before 15 June 2026 and points to the Data Manager API. |
| ChatGPT Ads Conversions API | `oppref` | `POST bzr.openai.com/v1/events?pid=<pixel>`, `order_created`, `timestamp_ms` (last 7 days, at most 10 minutes ahead), `oppref` at event level, `obref` unhashed in `user` (withheld if consent is denied), `amount` as an integer in minor units (`42.00 USD` → `4200`, JPY has no decimals) |

Event ids are the Shopify order id. For a platform to deduplicate against its browser pixel, the browser event must use the same id. The ledger notes this. Source URLs sent to platforms are the store origin only: `order_status_url` carries the order's access token and is never forwarded. With `consent.require_for_all_ad_platforms: true`, nothing is eligible without a captured `granted` value.

## Weekly reconciliation

```sh
node src/reconcile.mjs --orders orders.json --ga4 ga4.csv --ledger data/ledger.jsonl \
  --from 2026-09-26T00:00:00Z --to 2026-10-03T00:00:00Z --out out
```

- `--orders`: a JSON array of orders in REST/webhook shape (optionally with a `graphql` object holding the Admin API fields), or a CSV with columns `id,name,created_at,currency,total_price,total_refunded,financial_status,test,source_name,landing_site,referring_site,attribution_handle,attribution_display_name,app_name,publication_title`.
- `--ga4`: a CSV with a transaction id column. A GA4 Explore export with a `Transaction ID` dimension works, because lines starting with `#` are skipped and headers are normalised.
- Orders not in the ledger (a missed webhook) are classified and evaluated from the export and flagged.

Per channel: orders, revenue, refunds, net revenue (shop currency), in GA4, missing from GA4, MP built but not sent, MP sent, MP skipped, eligible per ad platform, orders with no ad identifier, unconfirmed labels, orders not in the ledger.

Per order, `ga4_gap` explains every order missing from GA4, for example *built in dry run*, *store checkout without a captured client_id*, *older than the 72 h window*, *no webhook in the ledger* or *sent but not in the export*. An order that is in GA4 although labelled direct checkout is flagged, because pixels do not fire there and the label is probably wrong. Transaction ids that are in GA4 but not in the Shopify export are listed separately.

Run it weekly from cron or any scheduler, after pulling the week's orders from the Admin API and a GA4 export.

## Limits

- **No real AI-channel orders.** A development store cannot produce an order from ChatGPT, Google AI Mode/Gemini, Copilot or Meta. Every fixture is synthetic, and the attribution, app and publication values in them are invented to exercise the rules.
- **The channel field values are undocumented.** As of 2 October 2026 Shopify documents `Order.attribution`, `app`, `publication` and `sourceName`, and says AI-channel orders show in the admin with channel or referrer attribution. It does not say which values those orders carry. Every rule that reads them is unconfirmed until checked on the store's real orders.
- **Partial reporting without a real client_id.** Google says Measurement Protocol data alone may give only partial reporting. Session source/medium needs the session's `session_id` sent within 24 hours, and events reach a linked Google Ads account only within 63 days of that client id's latest site event. Direct-checkout orders have no site session, so their GA4 purchase carries the channel label but no session attribution.
- **No backfill.** Measurement Protocol timestamps can be backdated at most 72 hours; older orders are reported as gaps, not sent.
- **Ad platforms receive nothing without an identifier.** AI direct-checkout orders normally carry no `fbp`, `fbc`, click id or `oppref`, so they are skipped. Whether Google, Microsoft or Meta already credit their own direct-checkout orders is not covered here.
- **Shopify's own server-to-server pixels.** Shopify says direct checkout fires only server-to-server pixels (started, completed) and does not say where they deliver. If Shopify starts sending these orders to GA4 itself, this capture would double count. The reconciliation flag for direct-checkout orders found in GA4 is the early warning.
- **Data Manager API.** Google says the Measurement Protocol stays supported with no deprecation planned, but recommends the Data Manager API for new server-to-server integrations. This demo uses the Measurement Protocol for GA4. Its Google Ads payload is already in Data Manager format.
- **Not covered:** browser agents completing the store's own checkout through Shopify's WebMCP tools (announced 28 September 2026; how pixels and attribution behave there is untested); Shopify Events subscriptions that could carry `Order.attribution` with the order event (API 2026-10, untested); multi-instance dedup without a shared store; the storefront snippet that writes the cart attributes.
- **Ledger content.** With payloads included, the ledger holds hashed emails, IP addresses and user agents. Treat it as personal data.

## Sources

Read on 2 October 2026.

- Shopify: [verify webhook deliveries](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries), [Order object](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order), [OrderAttribution](https://shopify.dev/docs/api/admin-graphql/latest/objects/OrderAttribution), [sales channel order attribution](https://shopify.dev/docs/apps/build/sales-channels/order-attribution), [webhook payloads](https://shopify.dev/docs/api/webhooks/latest), [Checkout MCP](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp), [agentic storefronts help](https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts) (ChatGPT, Google, Microsoft and Meta pages), [Shop moved to shop.com](https://changelog.shopify.com/posts/shop-is-now-at-shop-com).
- Google: [Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4/), [sending events and limits](https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events), [validating events](https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events), [event reference](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference/events), [use cases](https://developers.google.com/analytics/devguides/collection/protocol/ga4/use-cases), [transaction ID dedup](https://support.google.com/analytics/answer/12313109), [default channel group](https://support.google.com/analytics/answer/9756891), [Google Ads click conversions](https://developers.google.com/google-ads/api/docs/conversions/upload-clicks), [Data Manager API field mappings](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/upgrade/field-mappings).
- OpenAI: [Conversions API](https://developers.openai.com/ads/conversions-api), [measurement pixel](https://developers.openai.com/ads/measurement-pixel), [conversion measurement](https://help.openai.com/en/articles/20001409-conversion-measurement), [publishers FAQ (utm_source=chatgpt.com)](https://help.openai.com/en/articles/12627856-publishers-and-developers-faq).
- Meta: [Conversions API parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/), [Shops checkout](https://www.facebook.com/business/help/1314349509894768), [Muse help](https://www.meta.com/help/artificial-intelligence/1436362127544482/).
- Microsoft: [agentic commerce / Copilot Checkout](https://about.ads.microsoft.com/en/solutions/technology/agentic-commerce).

## License

Apache-2.0. See [LICENSE](LICENSE).
