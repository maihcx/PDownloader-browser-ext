#!/usr/bin/env node
// pnpm run build:firefox
//
// Required environment variables:
//   WEB_EXT_API_KEY     - AMO JWT issuer
//   WEB_EXT_API_SECRET  - AMO JWT secret
// (never commit these; export them in your shell before running this script)

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const extensionRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const firefoxDir = path.join(extensionRoot, 'dist', 'firefox');
const firefoxArtifactsDir = path.join(extensionRoot, 'web-ext-artifacts');
const firefoxListingMetadataPath = path.join(extensionRoot, 'manifests', 'firefox-listing.json');

function fail(message) {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}

const apiKey = process.env.WEB_EXT_API_KEY;
const apiSecret = process.env.WEB_EXT_API_SECRET;

if (!apiKey) {
  fail(
    'WEB_EXT_API_KEY is not set.\n' +
      '  Open AMO Developer Hub, create API credentials, then:\n' +
      '    export WEB_EXT_API_KEY=your-jwt-issuer\n' +
      '    export WEB_EXT_API_SECRET=your-jwt-secret\n' +
      '    pnpm run build:firefox\n' +
      '  Do not commit or share the API secret.'
  );
}
if (!apiSecret) {
  fail('WEB_EXT_API_SECRET is not set. Do not put the secret in source code or commit it to Git.');
}

// AMO-listed is the only production channel. AMO handles publication,
// distribution, and automatic updates for Firefox users.
console.log('[PDownloader] Building Firefox extension...');
await build({ root: extensionRoot, mode: 'firefox', configFile: path.join(extensionRoot, 'vite.config.mjs') });

if (!existsSync(path.join(firefoxDir, 'manifest.json'))) {
  fail(`Firefox build output was not found: ${firefoxDir}`);
}

if (!existsSync(firefoxListingMetadataPath)) {
  fail(
    `Listing metadata file not found: ${firefoxListingMetadataPath}\n` +
      '  This file is required for the initial listed submission (categories/summary/license).'
  );
}

console.log('\nSubmitting extension to Mozilla for LISTED review/publish...');
console.log(`Extension source: ${firefoxDir}`);

// Do not call webExt.cmd.sign() directly here. That is web-ext's lower-level
// programmatic API and bypasses CLI argument/default preparation (for example
// artifactsDir and webextVersion). Running the package's own CLI entry point
// gives us exactly the same behavior as `web-ext sign` while remaining
// cross-platform and without exposing the AMO secret in the command line.
const require = createRequire(import.meta.url);
const webExtEntry = require.resolve('web-ext');
const webExtBin = path.join(path.dirname(webExtEntry), 'bin', 'web-ext.js');

if (!existsSync(webExtBin)) {
  fail(`web-ext CLI entry point was not found: ${webExtBin}`);
}

const webExtArgs = [
  webExtBin,
  'sign',
  '--channel',
  'listed',
  '--source-dir',
  firefoxDir,
  '--artifacts-dir',
  firefoxArtifactsDir,
  '--amo-base-url',
  'https://addons.mozilla.org/api/v5/',
  '--amo-metadata',
  firefoxListingMetadataPath,
  '--timeout',
  '300000',
  '--approval-timeout',
  '0'
];

const signResult = spawnSync(process.execPath, webExtArgs, {
  cwd: extensionRoot,
  env: process.env,
  stdio: 'inherit'
});

if (signResult.error) {
  fail(`Mozilla submission failed: ${signResult.error.message}`);
}
if (signResult.status !== 0) {
  const exitReason = signResult.signal
    ? `terminated by signal ${signResult.signal}`
    : `exited with code ${signResult.status ?? 'unknown'}`;
  fail(`Mozilla submission failed: web-ext ${exitReason}.`);
}

console.log('\n[OK] The extension was submitted to AMO.');
console.log('Check the review status in AMO Developer Hub -> Manage Status & Versions.');
console.log('Once approved, the extension will be published automatically on addons.mozilla.org.');
console.log('AMO manages distribution and automatic updates for users.');
