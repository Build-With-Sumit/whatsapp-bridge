// Globus WhatsApp bridge — content script.
//
// Runs on https://web.whatsapp.com/*. Passively observes the DOM to harvest
// messages as the user clicks through their chats.
//
// Strategy: every message bubble has a `data-pre-plain-text` attribute
// like "[12:34, 21/05/2026] Sumit: " — this attribute has been stable in
// WhatsApp Web for many years (the rest of the class soup churns every
// few months). We scan globally for all such elements on every mutation.
//
// We expose window.__globusDiag() so you can inspect from DevTools:
//   F12 -> Console -> __globusDiag()

(function () {
  "use strict";

  console.log('[globus-wa] content script loaded at', new Date().toISOString());

  // ---------- helpers ----------

  function safeText(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').trim();
  }

  function currentChatName() {
    const candidates = [
      'header[data-testid="conversation-header"] span[dir="auto"]',
      'header[data-testid="conversation-header"] span[title]',
      '#main header span[dir="auto"][title]',
      '#main header span[dir="auto"]',
      'div[data-testid="conversation-info-header"] span',
      // Last-ditch: any header span inside the main pane.
      '#main header span',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      const t = safeText(el);
      if (t) return t;
    }
    return '(unknown chat)';
  }

  // De-dup: hash on (chat, ts, sender, body[:200]) so re-rendered bubbles
  // don't spam the server. Survives across scans within a session.
  const seen = new Set();
  function fingerprint(chat, ts, sender, body) {
    return `${chat}::${ts}::${sender}::${(body || '').slice(0, 200)}`;
  }

  function parsePrePlain(s) {
    // Format examples:
    //   "[12:34, 21/05/2026] Sumit: "
    //   "[7:11 pm, 21/05/2026] +91 1234567890: "
    //   "[21/05/2026, 12:34] Sumit: "
    if (!s) return { ts: '', sender: '' };
    const m = s.match(/^\[([^\]]+)\]\s*([^:]+):\s*$/);
    if (!m) return { ts: '', sender: s.trim() };
    return { ts: m[1].trim(), sender: m[2].trim() };
  }

  function detectDirection(el) {
    // Walk up to a wrapper that's tagged message-in or message-out.
    let cur = el;
    for (let i = 0; i < 12 && cur; i++) {
      const cls = cur.className || '';
      if (typeof cls === 'string') {
        if (cls.indexOf('message-out') >= 0) return 'out';
        if (cls.indexOf('message-in')  >= 0) return 'in';
      }
      cur = cur.parentElement;
    }
    return 'unknown';
  }

  function extractFromBubble(bubble) {
    const preText = bubble.getAttribute('data-pre-plain-text') || '';
    const { ts, sender } = parsePrePlain(preText);
    // The text body is usually in a .selectable-text span inside; fallback to
    // the bubble's own text if not found.
    const bodyEl = bubble.querySelector('span.selectable-text') ||
                   bubble.querySelector('[dir="ltr"] span') ||
                   bubble;
    const body = safeText(bodyEl);
    if (!body) return null;
    const direction = detectDirection(bubble);
    return { ts, sender, body, direction };
  }

  function scanAll() {
    const chatName = currentChatName();
    // The most stable identifier — bubbles with embedded metadata.
    const bubbles = document.querySelectorAll('[data-pre-plain-text]');
    const out = [];
    bubbles.forEach((b) => {
      try {
        const parsed = extractFromBubble(b);
        if (!parsed) return;
        const fp = fingerprint(chatName, parsed.ts, parsed.sender, parsed.body);
        if (seen.has(fp)) return;
        seen.add(fp);
        out.push({
          chat: chatName,
          ts: parsed.ts,
          sender: parsed.sender,
          body: parsed.body,
          direction: parsed.direction,
        });
      } catch (e) { /* swallow per-bubble parse errors */ }
    });
    if (out.length) {
      console.log('[globus-wa] captured', out.length,
                  'new msg(s) from chat:', chatName);
    }
    return out;
  }

  function trimSeen() {
    if (seen.size <= 5000) return;
    const keep = Array.from(seen).slice(-4000);
    seen.clear();
    keep.forEach((k) => seen.add(k));
  }

  // True once the extension's runtime has been invalidated (typically because
  // the extension was reloaded while this tab stayed open). Stops us from
  // spamming the console with sendMessage errors — the user just needs to
  // refresh the page once.
  let runtimeDead = false;

  function flushBatch(messages) {
    if (!messages.length || runtimeDead) return;
    // chrome.runtime may be undefined on an orphaned content script (after
    // the extension was reloaded). Guard before calling.
    if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      if (!runtimeDead) {
        runtimeDead = true;
        console.warn('[globus-wa] extension runtime gone — '
                     + 'refresh this page to re-inject.');
      }
      return;
    }
    try {
      chrome.runtime.sendMessage(
        { type: 'wa-messages', messages, url: location.href, ts: Date.now() },
        (_resp) => {
          // lastError access required to suppress the unchecked-runtime warning.
          if (chrome.runtime && chrome.runtime.lastError) {
            // Common case: extension reloaded mid-session. Mark dead so we
            // stop trying until refresh.
            runtimeDead = true;
            console.warn('[globus-wa] send to bg failed (probably extension '
                         + 'reloaded); refresh the WA tab. '
                         + chrome.runtime.lastError.message);
          }
        }
      );
    } catch (e) {
      runtimeDead = true;
      console.warn('[globus-wa] sendMessage threw (extension context likely '
                   + 'invalidated); refresh the WA tab.', e.message);
    }
  }

  // ---------- observer ----------
  //
  // Attach to document.body — captures every WhatsApp re-render anywhere
  // on the page (chat switch, new incoming, scroll-load history).
  // Coalesce bursts on requestAnimationFrame so we don't pound on every
  // micro-mutation.

  let scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        const msgs = scanAll();
        if (msgs.length) {
          flushBatch(msgs);
          trimSeen();
        }
      } catch (e) {
        console.warn('[globus-wa] scan failed', e);
      }
    });
  }

  let observer = null;
  function attachObserver() {
    if (observer) return true;
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });
    console.log('[globus-wa] observer attached to document.body');
    return true;
  }

  // Initial scan loop: WA Web takes a few seconds to render after auth.
  // Try every 3s for the first 90s; once we've seen messages or attached,
  // settle into the MutationObserver.
  let bootRetries = 0;
  function boot() {
    attachObserver();
    scheduleScan();
    bootRetries++;
    if (bootRetries < 30) {
      setTimeout(boot, 3000);
    }
  }
  setTimeout(boot, 1500);

  // ---------- diagnostic helpers exposed on window ----------

  window.__globusDiag = function () {
    const bubbles = document.querySelectorAll('[data-pre-plain-text]');
    const main = document.querySelector('#main');
    const header = document.querySelector('header[data-testid="conversation-header"]');
    const info = {
      url: location.href,
      hasMain: !!main,
      hasHeader: !!header,
      currentChat: currentChatName(),
      bubblesVisible: bubbles.length,
      seenFingerprints: seen.size,
      observerAttached: !!observer,
    };
    console.log('[globus-wa] diag:', info);
    if (bubbles.length > 0) {
      const sample = extractFromBubble(bubbles[0]);
      console.log('[globus-wa] first bubble extract:', sample);
      console.log('[globus-wa] first bubble pre-plain-text:',
                  bubbles[0].getAttribute('data-pre-plain-text'));
    } else {
      console.log('[globus-wa] No [data-pre-plain-text] elements found. '
                  + 'Possible causes: WA Web not loaded yet, or you are on '
                  + 'the chat-list view (open a chat first).');
    }
    return info;
  };

  window.__globusForceScan = function () {
    const msgs = scanAll();
    console.log('[globus-wa] force-scan captured', msgs.length, 'msg(s)');
    if (msgs.length) flushBatch(msgs);
    return msgs.length;
  };

  // popup ping
  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (msg && msg.type === 'wa-ping') {
      send({
        ok: true,
        chat: currentChatName(),
        url: location.href,
        seenCount: seen.size,
        bubblesVisible: document.querySelectorAll('[data-pre-plain-text]').length,
        observerAttached: !!observer,
      });
      return true;
    }
  });
})();
