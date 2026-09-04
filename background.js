// Globus — Teams & WhatsApp bridge — background service worker.
//
// Roles:
// 1. Receive batches of messages from content.js (WA + Teams).
// 2. Buffer + POST them to https://buildwithsumit.com every
//    INGEST_INTERVAL_MS, on a per-source queue so a Teams outage
//    doesn't stall WA (and vice-versa).
// 3. Hold the pairing token in chrome.storage.local — one token covers
//    both sources, scoped to the member.
// 4. Expose simple message API to the popup (status, set-token, flush).

const INGEST_URLS = {
  whatsapp: 'https://buildwithsumit.com/api/globus/whatsapp/ingest',
  teams:    'https://buildwithsumit.com/api/globus/teams/ingest',
};
const DEBUG_DUMP_URL = 'https://buildwithsumit.com/api/globus/debug/dump';
const INGEST_INTERVAL_MS = 15000;   // flush each queue every 15s when non-empty
// Per-source batch sizes — Teams messages are much larger than WA
// (multi-paragraph posts, pasted docs), so they need smaller batches
// to stay under the server's body cap.
const MAX_BATCH = { whatsapp: 80, teams: 20 };
// Min batch size we'll auto-split down to. Below this, on persistent
// 413 we drop the head message (it's individually too big for the cap).
const MIN_SPLIT = 1;

// Per-source state. lastFlush is per-source so a slow Teams response
// doesn't delay WA flushing.
function newQueue() {
  return {
    queue: [], lastFlush: 0, lastError: null, lastSentCount: 0,
  };
}
const state = {
  whatsapp: newQueue(),
  teams: newQueue(),
  token: null,
  member: null,
};

// ---------- helpers ----------

async function loadToken() {
  const r = await chrome.storage.local.get(['globusToken', 'memberEmail']);
  state.token = r.globusToken || null;
  state.member = r.memberEmail || null;
}

async function postBatch(source, batch) {
  const url = INGEST_URLS[source];
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + state.token,
    },
    body: JSON.stringify({
      messages: batch,
      ext_version: chrome.runtime.getManifest().version,
      sent_at: Date.now(),
    }),
  });
  return r;
}

async function flushSource(source, force = false) {
  const s = state[source];
  if (!s || !s.queue.length) return;
  if (!state.token) {
    if (s.queue.length > 5000) {
      s.queue.splice(0, s.queue.length - 5000);
    }
    return;
  }
  const now = Date.now();
  if (!force && now - s.lastFlush < INGEST_INTERVAL_MS) return;
  s.lastFlush = now;

  let batchSize = MAX_BATCH[source] || 50;
  const batch = s.queue.splice(0, batchSize);
  try {
    let r = await postBatch(source, batch);
    // 413 => batch too big for server cap. Split: send first half, push
    // the second half back to the head of the queue. Recursively halves
    // down to MIN_SPLIT. If a single message can't fit, drop it (after
    // logging) so the queue actually drains.
    while (!r.ok && r.status === 413 && batch.length > MIN_SPLIT) {
      const half = Math.max(MIN_SPLIT, Math.floor(batch.length / 2));
      const tail = batch.splice(half);
      s.queue.unshift(...tail);
      console.warn(`[globus-bridge ${source}] 413, splitting batch -> ${batch.length}`);
      r = await postBatch(source, batch);
    }
    if (!r.ok && r.status === 413 && batch.length === MIN_SPLIT) {
      // Single message still too big — drop it so we don't loop forever.
      const dropped = batch[0] || {};
      console.warn(`[globus-bridge ${source}] dropping oversize msg from chat:`,
                   (dropped.chat || '?').slice(0, 60),
                   'body_len:', (dropped.body || '').length);
      s.lastError = `dropped oversize msg from "${(dropped.chat || '?').slice(0, 40)}"`;
      return;  // counted as processed; don't restore to queue
    }
    if (!r.ok) {
      s.queue.unshift(...batch);
      s.lastError = `HTTP ${r.status}`;
      if (r.status === 401 || r.status === 403) {
        state.token = null;
        await chrome.storage.local.remove(['globusToken']);
      }
    } else {
      s.lastError = null;
      s.lastSentCount += batch.length;
    }
  } catch (e) {
    s.queue.unshift(...batch);
    s.lastError = String(e).slice(0, 120);
  }
}

async function flushAll(force = false) {
  await flushSource('whatsapp', force);
  await flushSource('teams', force);
}

// ---------- listeners ----------

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'wa-messages' && Array.isArray(msg.messages)) {
    state.whatsapp.queue.push(...msg.messages);
    if (state.whatsapp.queue.length >= MAX_BATCH.whatsapp) flushSource('whatsapp', true);
    send && send({ queued: msg.messages.length });
    return true;
  }

  if (msg.type === 'teams-messages' && Array.isArray(msg.messages)) {
    state.teams.queue.push(...msg.messages);
    if (state.teams.queue.length >= MAX_BATCH.teams) flushSource('teams', true);
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
      whatsapp: {
        queued: state.whatsapp.queue.length,
        lastSent: state.whatsapp.lastSentCount,
        lastError: state.whatsapp.lastError,
        lastFlushAgoSec: state.whatsapp.lastFlush ?
          Math.round((Date.now() - state.whatsapp.lastFlush) / 1000) : null,
      },
      teams: {
        queued: state.teams.queue.length,
        lastSent: state.teams.lastSentCount,
        lastError: state.teams.lastError,
        lastFlushAgoSec: state.teams.lastFlush ?
          Math.round((Date.now() - state.teams.lastFlush) / 1000) : null,
      },
    });
    return true;
  }

  if (msg.type === 'flush-now') {
    flushAll(true).then(() => send && send({ ok: true }));
    return true;
  }

  if (msg.type === 'upload-debug') {
    // Forward the page source to the server for Claude to inspect.
    // Async; reply via callback so the content script's Promise resolves.
    (async () => {
      if (!state.token) { send && send({ error: 'no token' }); return; }
      try {
        const r = await fetch(DEBUG_DUMP_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + state.token,
          },
          body: JSON.stringify({
            site: msg.site || 'unknown',
            url: msg.url || '',
            chat: msg.chat || '',
            ext_version: chrome.runtime.getManifest().version,
            html: msg.html || '',
          }),
        });
        const body = await r.text();
        send && send({ ok: r.ok, status: r.status, body: body.slice(0, 400) });
      } catch (e) {
        send && send({ error: String(e).slice(0, 200) });
      }
    })();
    return true;  // keep channel open for async send
  }
});

// ---------- WhatsApp tab self-heal ----------
// Reload the WhatsApp tab -- and ONLY it -- when capture has gone quiet.
//
// WHY THIS EXISTS: capture silently stopped on 2026-08-26 and nobody noticed for NINE DAYS. The
// tab can end up present-but-wedged (WhatsApp Web drops its socket, or the SPA re-renders into a
// state the observer no longer matches), and from the outside that is indistinguishable from a
// quiet inbox. A reload fixes it; the trick is knowing when to.
//
// It is deliberately CONDITIONAL rather than a blind timer: `lastFlush` already tells us when the
// last batch actually reached the server, so a reload happens only when nothing has for a while.
// A blind 30-second reload would capture LESS -- WhatsApp Web needs several seconds to reconnect
// and re-render, so the tab would spend much of its life loading -- and it looks far more
// automated on an account that matters.
//
// Tunable at runtime, no code edit:
//   chrome.storage.local.set({waRefreshMin: 15, waStaleMin: 10})
//   chrome.storage.local.set({waRefreshMin: 0})   // off
const WA_REFRESH_DEFAULTS = { waRefreshMin: 30, waStaleMin: 20 };
let waRefreshCfg = { ...WA_REFRESH_DEFAULTS };
let lastWaReload = 0;

async function loadWaRefreshCfg() {
  try {
    const r = await chrome.storage.local.get(['waRefreshMin', 'waStaleMin']);
    waRefreshCfg = {
      waRefreshMin: r.waRefreshMin === undefined ? WA_REFRESH_DEFAULTS.waRefreshMin : Number(r.waRefreshMin),
      waStaleMin: r.waStaleMin === undefined ? WA_REFRESH_DEFAULTS.waStaleMin : Number(r.waStaleMin),
    };
  } catch (e) { /* keep defaults */ }
  return waRefreshCfg;
}

async function maybeReloadWhatsApp() {
  const cfg = await loadWaRefreshCfg();
  if (!cfg.waRefreshMin || cfg.waRefreshMin <= 0) return;          // disabled

  // Never reload twice inside one interval, whatever wakes the service worker.
  const now = Date.now();
  if (now - lastWaReload < cfg.waRefreshMin * 60000 * 0.9) return;

  // Only reload when capture has actually gone quiet. waStaleMin = 0 means "always reload".
  if (cfg.waStaleMin > 0) {
    const last = state.whatsapp.lastFlush || 0;
    // With no successful flush ever recorded, treat the extension as freshly started and wait
    // one full interval rather than reloading a tab that may still be pairing.
    if (!last) { lastWaReload = now; return; }
    if (now - last < cfg.waStaleMin * 60000) return;               // still flowing, leave it alone
  }

  // ONLY the WhatsApp tab. This query is scoped by URL and works from host_permissions alone,
  // so the extension never sees any other tab.
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  } catch (e) {
    console.warn('[globus-wa] tab query failed', e);
    return;
  }
  if (!tabs.length) return;

  lastWaReload = now;
  for (const t of tabs) {
    try {
      // bypassCache=false: a normal reload. A hard reload would drop WhatsApp Web's cached
      // assets and make the reconnect slower for no benefit.
      await chrome.tabs.reload(t.id, { bypassCache: false });
      console.log('[globus-wa] reloaded the WhatsApp tab (capture was quiet)', t.id);
    } catch (e) {
      console.warn('[globus-wa] reload failed', e);
    }
  }
}

chrome.alarms.create('globus-wa-refresh', { periodInMinutes: 1 });

// Periodic flush — every ~15s. chrome.alarms minimum is 1 min in MV3
// production, but 0.25 min works fine for active service workers and
// gets clamped server-side when the SW is idle anyway.
chrome.alarms.create('globus-flush', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'globus-flush') flushAll(false);
  if (a.name === 'globus-wa-refresh') maybeReloadWhatsApp();
});

// Boot.
loadToken();
