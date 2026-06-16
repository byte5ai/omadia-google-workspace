#!/usr/bin/env node
/**
 * build-zip.mjs — builds an uploadable Google Workspace integration package.
 *
 * This integration has NO non-host runtime dependencies: it reaches the Google
 * APIs exclusively through the host-provided `ctx.http` client, and signs its
 * service-account JWT with the built-in `node:crypto`. We esbuild-bundle
 * `src/plugin.ts` → `dist/plugin.js` (ESM, single file) so the uploaded ZIP
 * carries one self-contained entry with no relative `./*.js` import resolution
 * to worry about. The only `external` is the host-provided `@omadia/plugin-api`
 * peer.
 *
 * Steps:
 *   1) esbuild bundle  → dist/plugin.js
 *   2) verify dist/plugin.js exists
 *   3) copy runtime artefacts into out/<id>-<version>-package/
 *   4) zip into out/<id>-<version>.zip
 *
 * Run `npm run typecheck` separately for the tsc gate (needs the @omadia type
 * sources from the adjacent omadia checkout — see README).
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const pkg = readJson(join(pkgRoot, 'package.json'));
if (!pkg.name || !pkg.version) {
  throw new Error('package.json: name + version required');
}

// --- 1) esbuild bundle ---------------------------------------------------
console.log('▶ esbuild bundle');
await build({
  entryPoints: [join(pkgRoot, 'src/index.ts')],
  outfile: join(pkgRoot, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  external: [
    // Host-provided peer — must NOT be inlined (resolves from host node_modules).
    '@omadia/plugin-api',
  ],
});

// --- 1b) emit declarations (dist/index.d.ts) for service_types resolution -
// The agent-builder resolves the `googleworkspace.client` service type
// (`GoogleWorkspaceClient`) from the package's `types` entry, so we must ship
// .d.ts alongside the bundle. esbuild does not emit declarations — tsc does.
console.log('▶ tsc --emitDeclarationOnly');
const tscBin = join(pkgRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const tscRes = spawnSync(
  process.execPath,
  [tscBin, '--emitDeclarationOnly', '--declaration', '--outDir', join(pkgRoot, 'dist')],
  { cwd: pkgRoot, stdio: 'inherit' },
);
if (tscRes.status !== 0) {
  throw new Error('tsc --emitDeclarationOnly failed');
}

// --- 2) verify entry -----------------------------------------------------
const entryRel = pkg.main ?? 'dist/plugin.js';
const entryAbs = join(pkgRoot, entryRel);
if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
  throw new Error(`entry not found after bundle: ${entryRel}`);
}

// --- 3) stage runtime artefacts -----------------------------------------
const safeName = pkg.name.replace(/^@/, '').replace(/\//g, '-');
const stageName = `${safeName}-${pkg.version}-package`;
const stageDir = join(pkgRoot, 'out', stageName);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const INCLUDE = ['manifest.yaml', 'package.json', 'dist', 'assets', 'README.md', 'LICENSE', 'NOTICE'];
for (const entry of INCLUDE) {
  const src = join(pkgRoot, entry);
  if (!existsSync(src)) continue;
  cpSync(src, join(stageDir, entry), { recursive: true });
}

// --- 4) zip --------------------------------------------------------------
const zipPath = join(pkgRoot, 'out', `${safeName}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });

const zipRes = spawnSync('zip', ['-r', '-q', zipPath, stageName], {
  cwd: join(pkgRoot, 'out'),
  stdio: 'inherit',
});
if (zipRes.status !== 0) {
  throw new Error('zip CLI failed — on Windows use 7z a or Compress-Archive');
}

console.log(`✓ built ${zipPath}`);
