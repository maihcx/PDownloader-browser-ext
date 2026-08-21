#!/usr/bin/env node
// pnpm run build:firefox
//
// Required environment variables:
//   WEB_EXT_API_KEY     - AMO JWT issuer
//   WEB_EXT_API_SECRET  - AMO JWT secret
// (never commit these; export them in your shell before running this script)

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import webExt from 'web-ext';

const extensionRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const firefoxDir = path.join(extensionRoot, 'dist', 'firefox');

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

console.log('\nSubmitting extension to Mozilla for LISTED review/publish...');
console.log(`Extension source: ${firefoxDir}`);

const firefoxListingMetadataPath = path.join(extensionRoot, 'manifests', 'firefox-listing.json');
if (!existsSync(firefoxListingMetadataPath)) {
  fail(`Listing metadata file not found: ${firefoxListingMetadataPath}\n  This file is required for the initial listed submission (categories/summary/license).`);
}

try {
  await webExt.cmd.sign(
    {
      apiKey,
      apiSecret,
      channel: 'listed',
      sourceDir: firefoxDir,
      amoBaseUrl: 'https://addons.mozilla.org/api/v5/',
      amoMetadata: firefoxListingMetadataPath,
      approvalTimeout: 0
    },
    { shouldExitProgram: false }
  );
} catch (error) {
  fail(`Mozilla submission failed: ${error?.message ?? error}`);
}

console.log('\n[OK] The extension was submitted to AMO.');
console.log('Check the review status in AMO Developer Hub -> Manage Status & Versions.');
console.log('Once approved, the extension will be published automatically on addons.mozilla.org.');
console.log('AMO manages distribution and automatic updates for users.');
