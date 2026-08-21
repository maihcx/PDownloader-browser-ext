#!/usr/bin/env node
// pnpm run build:firefox
//
// Required environment variables:
//   WEB_EXT_API_KEY     - AMO JWT issuer
//   WEB_EXT_API_SECRET  - AMO JWT secret
// (never commit these; export them in your shell before running this script)

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import webExt from 'web-ext';

const extensionRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const firefoxDir = path.join(extensionRoot, 'dist', 'firefox');
const artifactsDir = path.join(extensionRoot, 'web-ext-artifacts');

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

// AMO-listed is the only production channel. Firefox automatically updates listed
// add-ons from AMO, so the extension must not include a custom update_url.
console.log('[PDownloader] Building Firefox extension...');
await build({ root: extensionRoot, mode: 'firefox', configFile: path.join(extensionRoot, 'vite.config.mjs') });

if (!existsSync(path.join(firefoxDir, 'manifest.json'))) {
  fail(`Firefox build output was not found: ${firefoxDir}`);
}

mkdirSync(artifactsDir, { recursive: true });

console.log('\nSubmitting extension to Mozilla for LISTED review/publish...');
console.log(`Extension source: ${firefoxDir}`);
console.log(`Signed artifacts: ${artifactsDir}\n`);

const firefoxListingMetadataPath = path.join(extensionRoot, 'manifests', 'firefox-listing.json');
if (!existsSync(firefoxListingMetadataPath)) {
  fail(`Listing metadata file not found: ${firefoxListingMetadataPath}\n  Bắt buộc cho lần submit listed đầu tiên (categories/summary/license).`);
}

let signResult;
try {
  signResult = await webExt.cmd.sign(
    {
      apiKey,
      apiSecret,
      channel: 'listed',
      sourceDir: firefoxDir,
      artifactsDir,
      amoBaseUrl: 'https://addons.mozilla.org/api/v5/',
      amoMetadata: firefoxListingMetadataPath
    },
    { shouldExitProgram: false }
  );
} catch (error) {
  fail(`Mozilla submission failed: ${error?.message ?? error}`);
}

const signedXpi = readdirSync(artifactsDir)
  .filter((name) => name.endsWith('.xpi'))
  .map((name) => path.join(artifactsDir, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

if (signResult?.success && signedXpi) {
  console.log('\n[OK] Đã submit và được duyệt tự động (auto-approved).');
  console.log(`Bản build đã ký nằm tại: ${signedXpi}`);
} else {
  console.log('\n[OK] Đã submit lên AMO thành công, đang chờ REVIEW (có thể mất vài giờ đến vài ngày).');
  console.log('Kiểm tra trạng thái tại: AMO Developer Hub -> Manage Status & Versions.');
}

console.log('Sau khi được Approved, extension sẽ TỰ ĐỘNG public trên addons.mozilla.org.');
console.log('AMO quản lý việc phân phối và tự động cập nhật cho người dùng.');
