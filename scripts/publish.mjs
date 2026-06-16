#!/usr/bin/env node
/**
 * publish.mjs — publish a built plugin ZIP to an omadia Hub registry.
 *
 * Env:
 *   HUB                target base URL (default https://hub.omadia.ai)
 *   HUB_PUBLISH_TOKEN  Bearer token (required; never pass on the CLI/echo it)
 *   OVERWRITE=true     append ?overwrite=true (dev only — versions are immutable)
 *
 * Usage:
 *   HUB_PUBLISH_TOKEN=… node scripts/publish.mjs out/<id>-<version>.zip
 *
 * Prints the catalog before/after and the publish response. Exits non-zero on
 * any non-2xx so CI can gate on it.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const HUB = (process.env.HUB ?? 'https://hub.omadia.ai').replace(/\/$/, '');
const TOKEN = process.env.HUB_PUBLISH_TOKEN;
const zipPath = process.argv[2];

if (!TOKEN) {
  console.error('HUB_PUBLISH_TOKEN is required (do not echo it).');
  process.exit(2);
}
if (!zipPath) {
  console.error('usage: node scripts/publish.mjs <path-to.zip>');
  process.exit(2);
}

const ids = (idx) => (idx.plugins ?? []).map((p) => p.id).sort();

async function getIndex() {
  const r = await fetch(`${HUB}/registry/index.json`, { redirect: 'error' });
  if (!r.ok) throw new Error(`index.json → ${r.status}`);
  return r.json();
}

const before = await getIndex().catch((e) => ({ error: String(e) }));
console.log('catalog before:', JSON.stringify(ids(before)));

const bytes = readFileSync(zipPath);
const form = new FormData();
form.append('file', new Blob([bytes], { type: 'application/zip' }), basename(zipPath));

const url = `${HUB}/api/publish${process.env.OVERWRITE === 'true' ? '?overwrite=true' : ''}`;
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: form,
});
const text = await res.text();
console.log(`publish → HTTP ${res.status}`);
console.log(text);

if (!res.ok) process.exit(1);

const after = await getIndex().catch((e) => ({ error: String(e) }));
console.log('catalog after:', JSON.stringify(ids(after)));
