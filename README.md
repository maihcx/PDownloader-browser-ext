<p align="center">
  <img src="./icons/icon128.png" width="96" height="96" alt="PDownloader logo">
</p>

<h1 align="center">PDownloader Browser Extension</h1>

<p align="center">
  A companion extension that detects downloads and media in your browser, then sends them to the PDownloader desktop application.
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.4.1-0969da">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-4285F4">
  <img alt="Chromium" src="https://img.shields.io/badge/Chromium-supported-34A853">
  <img alt="Firefox" src="https://img.shields.io/badge/Firefox-140%2B-FF7139">
  <img alt="License" src="https://img.shields.io/badge/license-GPL--3.0--only-blue">
</p>

> [!IMPORTANT]
> This extension is not a standalone downloader. The PDownloader desktop application must be running for download, analysis, and media-format requests to work.

## Browser Extensions

<a href="https://addons.mozilla.org/en-US/firefox/addon/3ac2c3eaa9924d259be6/"><img src="https://img.shields.io/amo/v/3ac2c3eaa9924d259be6?label=Firefox&logo=firefoxbrowser" alt="Firefox Add-ons version"></a>
<a href="https://chromewebstore.google.com/detail/pdownloader/kdbapmeegoljihpndnbfeockjjcoogbp"><img src="https://img.shields.io/chrome-web-store/v/kdbapmeegoljihpndnbfeockjjcoogbp?label=Chrome&logo=googlechrome" alt="Chrome Web Store version"></a>

Download the browser extension to integrate PDownloader with your browser.

<p align="left">
  <a href="https://addons.mozilla.org/en-US/firefox/addon/3ac2c3eaa9924d259be6/">
    <img src="https://img.shields.io/badge/GET_THE_ADD--ON-0A84FF?style=for-the-badge&logo=firefoxbrowser&logoColor=white" alt="Get the Firefox Add-on" height="48">
  </a>
  <a href="https://chromewebstore.google.com/detail/pdownloader/kdbapmeegoljihpndnbfeockjjcoogbp">
    <img src="https://img.shields.io/badge/Available_in_the_Chrome_Web_Store-F1F3F4?style=for-the-badge&logo=googlechrome&logoColor=4285F4" alt="Available in the Chrome Web Store" height="48">
  </a>
</p>

## Source Code

PDownloader is developed across the following repositories:

| Repository | Purpose |
| --- | --- |
| [Main App](https://github.com/maihcx/PDownloader) | Windows application, download engine, installer, and releases. |
| **[Browser Extension](https://github.com/maihcx/PDownloader-browser-ext) ← You are here** | Browser integration, download interception, and media capture. |
| [Website](https://github.com/maihcx/PDownloader-site) | Website, translations, documentation reader, and Markdown articles. |

## Features

- Redesigned popup with separate Files and Settings tabs, light/dark/system themes, and an expanded view pinned to the source tab.
- Searches and filters detected files, sorts by name or size, copies links, and sends explicitly selected files with per-item results.
- Exposes existing file-size and extension rules with validation; explains exclusions inherited from parent domains.
- Automatically intercepts supported browser downloads and hands them to PDownloader.
- Keeps the browser's original download running if the desktop application is unavailable or rejects the request.
- Detects direct video, audio, PDF, HLS (`.m3u8`), and DASH (`.mpd`) resources on the current page.
- Analyzes available video and audio formats, including resolution, container, codec, and file size when provided by the source.
- Adds one shared video toolbar and format picker across websites, including paused videos and visible player placeholders; no separate YouTube content script.
- Provides native picture-in-picture with a temporary override of the selected video's disable hint, where supported by browser permissions.
- Sends links, images, media, or the current page to PDownloader from the context menu.
- Preserves relevant request headers, referrer information, cookies, browser containers, and partitioned-cookie context for authenticated downloads.
- Supports global interception settings, per-site exclusions, notifications, and a session counter.
- Includes English and Vietnamese interfaces.
- Uses one source tree for Chromium and Firefox builds.

## How it works

### File selection and capture rules

Selected files remain selected when filtered out. **Select visible** affects only the current results; **Send selected** sends the entire explicit selection. Keep the popup/expanded view open until all requests have been acknowledged. Once accepted, actual downloads run independently in PDownloader.

The size setting is an additional capture rule, not a universal minimum: listed extensions and supported MIME types can still be intercepted below that size. Setting it to zero disables only size-based capture.

### Download flow

1. The extension observes browser downloads, page media elements, and media network requests.
2. A suitable download or media candidate is selected while small stream fragments and unrelated requests are ignored.
3. The extension opens an authenticated local session with PDownloader at `http://localhost:6287`.
4. The URL and any required request context are sent to the desktop application.
5. The browser download is cancelled only after PDownloader confirms that it accepted the task.

HLS streams use PDownloader's native HLS pipeline. DASH streams and page-based media analysis are routed through the media analyzer in the desktop application.

## Requirements

### To use the extension

- The [PDownloader](https://github.com/maihcx/PDownloader) desktop application.
- A Chromium-based browser with Manifest V3 support, or Firefox 140 and later.
- The PDownloader application must be open and its local bridge must be available on port `6287`.

### To develop or build

- A current Node.js LTS release.
- [pnpm](https://pnpm.io/) through Corepack or a standalone installation.

## Install for local testing

Clone the repository and enter the browser-extension directory, then install dependencies:

```bash
corepack enable
pnpm install --frozen-lockfile
```

### Chrome, Edge, Brave, and other Chromium browsers

Build the unpacked Chromium target:

```bash
pnpm build:chrome
```

Then:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `dist/chromium`.
5. Open PDownloader, then reload any tabs that were already open.

`pnpm build:chrome` also creates `PDownloader-store.zip`, without the development `key`, for submission to the Chrome Web Store.

### Firefox

Create an unsigned development build:

```bash
pnpm build:firefox-nosign
```

Then:

1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on**.
3. Choose `dist/firefox/manifest.json`.

The temporary add-on is removed when Firefox restarts. Permanent Firefox installation requires an XPI signed by Mozilla.

## Usage

1. Start the PDownloader desktop application.
2. Open the extension popup and verify that it shows **Connected to PDownloader**.
3. Start a download normally, use a page's PDownloader media button, choose a detected file in the popup, or use the browser context menu.
4. For media with multiple formats, select the required resolution, video/audio combination, or audio-only format from the analyzer.

The popup provides the following controls:

| Control | Description |
| --- | --- |
| Auto-catch links | Intercepts matching browser downloads and forwards them to PDownloader. |
| Auto-catch on this site | Enables or disables interception for the current domain. |
| Show notifications | Displays a browser notification when PDownloader accepts a task. |
| Detected files | Lists up to eight high-confidence media or PDF candidates from the active tab. |
| Blocked sites | Shows domains excluded from automatic interception. |

By default, automatic interception considers common archives, installers, video, audio, office documents, torrents, and disk-image formats. A download may also qualify by MIME type or by the default minimum size of 2 MB.

## Media support and limitations

| Type | Handling |
| --- | --- |
| Direct files | Sent directly to PDownloader with filename, referrer, headers, and relevant cookies. |
| HLS (`.m3u8`) | Sent to PDownloader's native HLS handler. |
| DASH (`.mpd`) | Sent through the desktop media pipeline. |
| Page-based video | Analyzed by the desktop media analyzer and presented as selectable formats. |
| PDF | Detected from URLs, MIME types, embedded viewers, and network requests. |
| Spotify | Preview media can be detected when exposed; protected full-track streams cannot be downloaded directly. |
| DRM media | Encrypted DRM streams are not supported. |

Media detection depends on what a website exposes to the browser. Player or API changes made by a website can temporarily affect detection until the relevant resolver is updated. Always respect copyright, website terms, and applicable law when downloading content.

## Development

Run the source checks before committing changes:

```bash
pnpm check
```

Start a watched Chromium build:

```bash
pnpm dev
```

After changing a background or content script, reload the extension and refresh the target page. The runtime scripts are classic WebExtension scripts copied as-is; Vite orchestrates target-specific manifests and output folders rather than converting the runtime to ES modules.

### Available commands

| Command | Output or purpose |
| --- | --- |
| `pnpm check` | Validates JavaScript syntax, JSON files, manifest references, background order, locale parity, and required theme variables. |
| `pnpm dev` | Watches and rebuilds the unpacked Chromium target in `dist/chromium`. |
| `pnpm build:chrome` | Builds `dist/chromium`, `dist/store`, and `PDownloader-store.zip`. |
| `pnpm build:firefox-nosign` | Builds `dist/firefox` and `PDownloader-firefox-unsigned.zip` for temporary testing. |
| `pnpm build:firefox` | Builds and submits the listed Firefox release to AMO without retaining a local signed package. Requires AMO credentials. |
| `pnpm build` | Builds Chrome and then runs the signed Firefox release flow. |

## Project structure

```text
.
├── _locales/                 Browser UI translations
├── background/               Bridge API, interception, capture, settings, and routing
├── common/                   Shared browser API, i18n, titles, and theme tokens
├── content/                  Page observers, site resolvers, and quality analyzer UI
├── icons/                    Extension icons
├── manifests/                Firefox target and AMO listing configuration
├── popup/                    Popup interface and settings
├── scripts/                  Validation and release build scripts
├── background.js             Chromium service-worker bootstrap
├── manifest.json             Base Manifest V3 definition
└── vite.config.mjs           Target-specific build orchestration
```

## Permissions

The extension requests only the browser capabilities required by its download-manager integration:

| Permission | Why it is needed |
| --- | --- |
| `downloads` | Observe a new browser download and cancel it after PDownloader accepts it. |
| `storage` | Save interception, notification, and blocked-site preferences. |
| `cookies` | Preserve authenticated download sessions and browser container/partition context. |
| `activeTab`, `tabs` | Associate detected media and downloads with the correct page and title. |
| `contextMenus` | Add **Download with PDownloader** actions. |
| `webRequest` | Detect media manifests, direct media, PDFs, MIME types, and response metadata. |
| `notifications` | Notify the user after a task is accepted. |
| `<all_urls>` | Detect downloads and media across websites rather than using a fixed site list. |

Sensitive request context is passed to the PDownloader application through the local bridge at `localhost:6287`. It is used to reproduce downloads that require authentication, a referrer, or site-specific headers.

## Firefox release signing

`pnpm build:firefox` submits a listed production release to Mozilla AMO. Keep AMO credentials outside the repository:

```bash
export WEB_EXT_API_KEY="your-jwt-issuer"
export WEB_EXT_API_SECRET="your-jwt-secret"
pnpm build:firefox
```

Firefox production releases use the listed AMO channel, which handles publication, distribution, and automatic updates. Use `pnpm build:firefox-nosign` for local testing.

Never commit or share `WEB_EXT_API_SECRET`.

## Troubleshooting

### The popup says PDownloader is not connected

- Open or restart the PDownloader desktop application.
- Confirm that another application is not occupying port `6287`.
- Check whether security software is blocking the browser from reaching `http://localhost:6287`.
- Reload the extension and refresh the page.

### A video or audio file is not detected

- Start playback so the page requests its media resources.
- Reopen the popup after playback begins.
- Confirm that the stream is not DRM-protected.
- Reload the page after installing or updating the extension.

### The browser downloads the file normally

This is intentional when PDownloader is offline, the site is blocked, automatic interception is disabled, or the task is rejected. The extension cancels the browser download only after a successful hand-off, preventing a failed connection from losing the original download.

### Firefox removes the extension after restart

Unsigned builds loaded through `about:debugging` are temporary. Use a Mozilla-signed XPI for permanent installation.

## Contributing

Contributions and reproducible bug reports are welcome. When reporting a media-detection problem, include:

- Browser name and version.
- Extension and PDownloader versions.
- The page URL, when it can be shared publicly.
- Whether the media is direct, HLS, DASH, or DRM-protected.
- Relevant extension background-console errors with private cookies or tokens removed.

Keep English and Vietnamese locale keys synchronized, and run `pnpm check` before opening a pull request.

## License

PDownloader Browser Extension is distributed under the **GPL-3.0-only** license.
