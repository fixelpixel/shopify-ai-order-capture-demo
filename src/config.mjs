// Loads config/capture.json and checks the parts the pipeline depends on.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CAPTURE_PATH = fileURLToPath(new URL('../config/capture.json', import.meta.url));
export const DEFAULT_RULES_PATH = fileURLToPath(new URL('../config/channel-rules.json', import.meta.url));

const POLICY_VALUES = new Set(['send', 'send_if_client_id', 'never']);

export function loadCaptureConfig(path = DEFAULT_CAPTURE_PATH) {
  return validateCaptureConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function validateCaptureConfig(cfg) {
  const errors = [];
  if (!['shop', 'presentment'].includes(cfg.money_source)) errors.push('money_source must be "shop" or "presentment"');
  if (!Array.isArray(cfg.purchase_on_financial_status)) errors.push('purchase_on_financial_status must be an array');
  for (const key of ['ga_client_id', 'fbp', 'fbc', 'gclid', 'gbraid', 'wbraid', 'oppref', 'obref', 'ad_consent']) {
    if (!Array.isArray(cfg.attributes?.[key])) errors.push(`attributes.${key} must be an array of attribute names`);
  }
  for (const [checkout, policy] of Object.entries(cfg.ga4?.policy ?? {})) {
    if (!POLICY_VALUES.has(policy)) errors.push(`ga4.policy.${checkout}: unknown value "${policy}"`);
  }
  for (const checkout of ['direct', 'store', 'unknown']) {
    if (!cfg.ga4?.policy?.[checkout]) errors.push(`ga4.policy.${checkout} is required`);
  }
  if (!(cfg.ga4?.max_backdate_hours > 0)) errors.push('ga4.max_backdate_hours must be > 0');
  if (errors.length) throw new Error('capture config invalid:\n- ' + errors.join('\n- '));
  return cfg;
}
