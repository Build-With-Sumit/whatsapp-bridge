# Globus — WhatsApp bridge

A Chrome extension that passively mirrors your WhatsApp Web conversations into your private [Globus](https://buildwithsumit.com/members/globus) vault, so Globus + the [GlobusAgents](https://buildwithsumit.com/members/globus/agents) can search your chats alongside your Drive, Gmail, and CRMs.

**Read-only. No automated sending. No synthetic clicks. No DOM injection.** Just a `MutationObserver` watching the page you already have open — invisible to WhatsApp.

Part of [Build With Sumit](https://buildwithsumit.com).

---

## What it does

- Captures messages from any WhatsApp Web chat you open (in real time as new ones arrive)
- Batches them every 15 seconds, POSTs to `https://buildwithsumit.com/api/globus/whatsapp/ingest`
- The server stores them per-member, deduplicated by fingerprint
- Globus then answers questions like *"what did X say in the EmpMonitor group last week"* via its `search_whatsapp` tool

## What it doesn't do

- Send messages
- Synthesize clicks, keystrokes, or scroll events
- Switch between chats automatically
- Capture media (images, voice notes, video, documents) — text only
- Run when WhatsApp Web tab is closed
- Capture chats you haven't opened (WA Web only loads message bodies when you click into a chat — same as a human reading)

## Install

1. **Download** the latest release zip from [Releases](https://github.com/Build-With-Sumit/whatsapp-bridge/releases) OR from https://buildwithsumit.com/globus-whatsapp-bridge.zip
2. Unzip anywhere
3. Open `chrome://extensions` in Chrome / Brave / Edge
4. Toggle **Developer mode** (top-right)
5. Click **Load unpacked**, pick the unzipped folder
6. Pin the extension to your toolbar

## Pair

1. Sign in to your [Build With Sumit member account](https://buildwithsumit.com/members)
2. Visit https://buildwithsumit.com/members/whatsapp and copy the 90-day pairing token
3. Click the extension icon → paste the token → **Save token**
4. Open https://web.whatsapp.com and click into any chat — the popup's "Uploaded this session" counter should climb

## Why this is safe

- WhatsApp **cannot** detect a `MutationObserver`. There is no API to enumerate observers attached to a DOM element.
- Chrome content scripts run in an isolated JS world — our code's globals aren't visible to WhatsApp's own scripts.
- We do not synthesize any input events (`isTrusted: false` would be detectable; we don't generate any).
- Network: our POSTs go to `buildwithsumit.com`, not to WhatsApp. Their servers see only your normal WA WebSocket traffic.
- Every Chrome user with an ad blocker, password manager, accessibility tool, or grammar checker has multiple `MutationObserver` instances on every page they visit. We blend in.

## Files

- `manifest.json` — Manifest V3, minimal permissions (storage + alarms + WA + bws host)
- `content.js` — runs on web.whatsapp.com. Observes DOM, extracts `[data-pre-plain-text]` bubbles.
- `background.js` — service worker. Buffers + 15s batch POST with bearer token.
- `popup.html` + `popup.js` — pairing UI + status + flush button.
- `icons/` — Build With Sumit brand mark in 16/32/48/128 PNG.

## License

[AGPL-3.0](LICENSE). If you run a modified version as a public service, you must publish your modifications under the same license.

## Contributing

Issues and pull requests welcome. This is part of a larger open-source stack — see the [Build With Sumit organization](https://github.com/Build-With-Sumit) for the rest.
