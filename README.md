# Globus WhatsApp bridge — Chrome extension

Reads your WhatsApp Web conversations into your Globus vault so Globus and the
GlobusAgents (sumit.ai, Arjun, etc.) can see your inbox alongside Gmail, the
CRMs, and your Drive.

**Phase 1A is read-only.** No automated sending. Sending arrives in Phase 1B
behind a queue + per-day rate limit.

## How safe is this?

You're not "automating WhatsApp" — you're attaching a DOM observer to the page
you already have open. From WhatsApp's perspective the tab looks identical to
a tab you're scrolling through yourself. No synthetic clicks, no fake events,
no scripted navigation. There's no realistic ban risk for read-only.

## Install (5 minutes, one time)

1. Clone or download this repo.
2. Open `chrome://extensions` in Chrome / Brave / Edge.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select the `chrome-ext/` folder.
5. Pin the extension to your toolbar.
6. Open https://buildwithsumit.com/members/whatsapp and copy the pairing
   token. Click the extension icon, paste the token into the popup, hit
   **Save token**.
7. Open https://web.whatsapp.com — the extension's popup should show
   **paired** + a queue/upload counter that goes up as you click through
   conversations.

## What gets captured

For each visible message: the chat name, the sender (you or them), the
timestamp WhatsApp shows in the bubble, the body text, and the direction
(`in`/`out`). The extension de-dups so the same message captured twice
isn't re-uploaded.

Messages POST in 15-second batches (or sooner when the queue hits 200) to
`https://buildwithsumit.com/api/globus/whatsapp/ingest`. The server stores
them per-member and indexes them into the Globus vault so `search_files`
and `search_content` reach them.

## What does NOT get captured (yet)

- Media (images, voice notes, video, documents) — Phase 2 if needed.
- Forwarded message provenance.
- Reactions.
- Status / story updates.
- Group member changes.

## Files

- `manifest.json` — Manifest V3, minimal permissions (storage + alarms,
  plus host permissions for web.whatsapp.com + buildwithsumit.com).
- `content.js` — runs on `web.whatsapp.com`. MutationObserver on `#main`,
  extracts message bubbles, sends to background.
- `background.js` — service worker. Batches, buffers, POSTs with the
  pairing token. Survives WhatsApp tab close (queue persists in memory
  while the worker lives; on worker restart, queue resets).
- `popup.html` + `popup.js` — pairing UI + status.

## Phase 1B (not yet built)

A second endpoint on the server will hold a per-member send queue. The
extension will poll it every minute, and when something is queued, will
type into the WA Web composer + click send — at most N per minute, with
human-like jitter. Drafted by Arjun (the outreach agent) and approved by
you before they enter the queue.

## Phase 1C — Arjun integration

Arjun's brief currently produces drafts as markdown. Phase 1C lets Arjun
write directly into the WhatsApp send queue (still gated on your approval
in the GlobusAgents dashboard before they actually send).
