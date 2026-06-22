// Globus WhatsApp bridge — background service worker.
//
// Roles:
// 1. Receive batches of messages from content.js
// 2. Buffer + POST them to https://buildwithsumit.com in batches every
//    INGEST_INTERVAL_MS (handles the WA tab going temporarily offline).
// 3. Hold the pairing token in chrome.storage.local.
// 4. Expose simple message API to the popup (status, set-token, force-flush).

const INGEST_URL = 'https://buildwithsumit.com/api/globus/whatsapp/ingest';
const INGEST_INTERVAL_MS = 15000;   // flush queue every 15s when non-empty
const MAX_BATCH = 80;               // cap per POST. ~80 msgs * avg 500 char
                                    // = ~40KB body, fits comfortably under
                                    // the server's 4MB wa-ingest cap.

const state = {
  queue: [],         // pending messages awaiting POST
  lastFlush: 0,
  lastError: null,
  lastSentCount: 0,
  token: null,
};

// ---------- helpers ----------

async function loadToken() {
  const r = await chrome.storage.local.get(['globusToken', 'memberEmail']);
  state.token = r.globusToken || null;
  state.member = r.memberEmail || null;
}

async function flush(force = false) {
  if (!state.queue.length) return;
  if (!state.token) {
    // No token yet — keep buffering. Don't drop messages.
    if (state.queue.length > 5000) {
      // Hard cap so memory doesn't blow up.
      state.queue.splice(0, state.queue.length - 5000);
    }
    return;
  }
  const now = Date.now();
  if (!force && now - state.lastFlush < INGEST_INTERVAL_MS) return;
  state.lastFlush = now;

  const batch = state.queue.splice(0, MAX_BATCH);
  try {
    const r = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + state.token,
      },
      body: JSON.stringify({
        messages: batch,
        ext_version: chrome.runtime.getManifest().version,
        sent_at: now,
      }),
    });
    if (!r.ok) {
      // Restore the batch — server didn't accept it.
      state.queue.unshift(...batch);
      state.lastError = `HTTP ${r.status}`;
      // If the token is bad, clear it so popup prompts again.
      if (r.status === 401 || r.status === 403) {
        state.token = null;
        await chrome.storage.local.remove(['globusToken']);
      }
    } else {
      state.lastError = null;
      state.lastSentCount += batch.length;
    }
  } catch (e) {
    state.queue.unshift(...batch);
    state.lastError = String(e).slice(0, 120);
  }
}

// ---------- listeners ----------

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'wa-messages' && Array.isArray(msg.messages)) {
    state.queue.push(...msg.messages);
    if (state.queue.length >= MAX_BATCH) flush(true);
    send && send({ queued: msg.messages.length });
    return true;
  }

  if (msg.type === 'set-token') {
    state.token = msg.token || null;
    state.member = msg.member || null;
    chrome.storage.local.set({
      globusToken: state.token,
      memberEmail: state.member,
    });
    send && send({ ok: true });
    return true;
  }

  if (msg.type === 'get-status') {
    send && send({
      tokenSet: !!state.token,
      member: state.member,
      queued: state.queue.length,
      lastSent: state.lastSentCount,
      lastError: state.lastError,
      lastFlushAgoSec: state.lastFlush ?
        Math.round((Date.now() - state.lastFlush) / 1000) : null,
    });
    return true;
  }

  if (msg.type === 'flush-now') {
    flush(true).then(() => send && send({ ok: true }));
    return true;
  }
});

// Periodic flush via chrome.alarms (service workers get killed; alarms revive
// them). Every minute = enough granularity for this read-only path.
chrome.alarms.create('globus-flush', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'globus-flush') flush(false);
});

// Boot.
loadToken();
