// Append-only JSONL ledger: one line per webhook delivery and what was done with it.
// Records can hold hashed identifiers when payloads are included; treat the file as personal data.

import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function createJsonlLedger(path) {
  let ready = null;
  return {
    path,
    async append(record) {
      ready ??= mkdir(dirname(path), { recursive: true });
      await ready;
      await appendFile(path, JSON.stringify(record) + '\n');
    },
  };
}

/** Reads a JSONL file. Lines that do not parse (for example a torn last line) are skipped. */
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore
    }
  }
  return out;
}
