// Globus — Teams & WhatsApp bridge — content script.
//
// Runs on web.whatsapp.com AND teams.live.com. Site detection at the
// bottom routes to bootWhatsApp() or bootTeams() so the two scrapers
// stay isolated (their DOM shapes are totally different).
//
// Common pattern in both modules:
//   - MutationObserver on document.body, coalesced via rAF
//   - Per-message fingerprint set for de-dup within session
//   - Active cycler that clicks unread chats at random 1-10 min intervals
//   - __globus* helpers exposed on window for console debugging (via the
//     page-bridge.js round-trip; isolated worlds can't share window).

(function () {
  "use strict";

  // ============================================================
  // Shared helpers (used by both modules)
  // ============================================================

  function safeText(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').trim();
  }
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function injectPageBridge() {
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("page-bridge.js");
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      console.warn("[globus-bridge] inject failed", e);
    }
  }

  // ============================================================
  // bootWhatsApp() — original WA Web scraper, kept verbatim except
  // for the bg-message type ('wa-messages' below) and the unified
  // bridge dispatcher at the bottom of this IIFE.
  // ============================================================
  function bootWhatsApp() {
    console.log('[globus-wa] content script loaded at', new Date().toISOString());
    injectPageBridge();

    function currentChatName() {
      // WA Web updated 2026-06 — was <header data-testid="conversation-header">,
      // now <div data-testid="conversation-header">. Also the chat name
      // moved into a span[title="..."] inside the header div (for groups
      // the title is a comma-separated participant list; for 1:1 it's
      // the contact name). Try the title-attribute path first, fall
      // back to descendant text. Old tag-anchored selectors kept as
      // last-ditch in case WA reverts.
      const candidates = [
        '[data-testid="conversation-header"] span[title]',
        '[data-testid="conversation-header"] span[dir="auto"][title]',
        '[data-testid="conversation-info-header-chat-title"]',
        '[data-testid="conversation-info-header"] span[title]',
        // Legacy fallbacks
        'header[data-testid="conversation-header"] span[dir="auto"]',
        'header[data-testid="conversation-header"] span[title]',
        '#main header span[dir="auto"][title]',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (!el) continue;
        // Prefer the title attribute (full name, even when truncated visually)
        const t = (el.getAttribute && el.getAttribute('title')) || safeText(el);
        if (t) return t;
      }
      return '(unknown chat)';
    }

    const seen = new Set();
    function fingerprint(chat, ts, sender, body) {
      return `${chat}::${ts}::${sender}::${(body || '').slice(0, 200)}`;
    }

    function parsePrePlain(s) {
      if (!s) return { ts: '', sender: '' };
      const m = s.match(/^\[([^\]]+)\]\s*([^:]+):\s*$/);
      if (!m) return { ts: '', sender: s.trim() };
      return { ts: m[1].trim(), sender: m[2].trim() };
    }

    function detectDirection(el) {
      // WA Web 2026-06: dropped the human-readable 'message-in' /
      // 'message-out' classes — only Facebook's hashed atomic class
      // names remain (e.g. x10l6tqk), unstable across builds. We try
      // a few hints; if none match, return 'unknown' (acceptable,
      // doesn't break message capture).
      let cur = el;
      for (let i = 0; i < 12 && cur; i++) {
        const cls = (cur.className || '').toString();
        if (cls.indexOf('message-out') >= 0) return 'out';
        if (cls.indexOf('message-in')  >= 0) return 'in';
        // Some builds set data-id="true_..." (out) / "false_..." (in)
        const did = cur.getAttribute && cur.getAttribute('data-id');
        if (did) {
          if (did.startsWith('true_')) return 'out';
          if (did.startsWith('false_')) return 'in';
        }
        cur = cur.parentElement;
      }
      return 'unknown';
    }

    function extractFromBubble(bubble) {
      const preText = bubble.getAttribute('data-pre-plain-text') || '';
      const { ts, sender } = parsePrePlain(preText);
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
            chat: chatName, ts: parsed.ts, sender: parsed.sender,
            body: parsed.body, direction: parsed.direction,
          });
        } catch (e) {}
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

    let runtimeDead = false;
    function flushBatch(messages) {
      if (!messages.length || runtimeDead) return;
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        if (!runtimeDead) {
          runtimeDead = true;
          console.warn('[globus-wa] extension runtime gone — refresh this page.');
        }
        return;
      }
      try {
        chrome.runtime.sendMessage(
          { type: 'wa-messages', messages, url: location.href, ts: Date.now() },
          (_resp) => {
            if (chrome.runtime && chrome.runtime.lastError) {
              runtimeDead = true;
              console.warn('[globus-wa] bg send failed — refresh the WA tab. '
                           + chrome.runtime.lastError.message);
            }
          }
        );
      } catch (e) {
        runtimeDead = true;
        console.warn('[globus-wa] sendMessage threw — refresh the WA tab.', e.message);
      }
    }

    let scheduled = false;
    function scheduleScan() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        try {
          const msgs = scanAll();
          if (msgs.length) { flushBatch(msgs); trimSeen(); }
        } catch (e) { console.warn('[globus-wa] scan failed', e); }
      });
    }

    let observer = null;
    function attachObserver() {
      if (observer) return true;
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, {
        childList: true, subtree: true, characterData: true,
      });
      console.log('[globus-wa] observer attached');
      return true;
    }

    let bootRetries = 0;
    function bootLoop() {
      attachObserver();
      scheduleScan();
      bootRetries++;
      if (bootRetries < 30) setTimeout(bootLoop, 3000);
    }
    setTimeout(bootLoop, 1500);

    // Heartbeat every 30s: prints what the scraper sees so a "0 uploads"
    // report can be diagnosed by opening F12 -> Console -> filter '[globus-wa]'.
    setInterval(() => {
      console.log('[globus-wa] heartbeat', {
        chat: currentChatName(),
        bubbles: document.querySelectorAll('[data-pre-plain-text]').length,
        seen: seen.size,
        observer: !!observer,
        cyclerActive, cyclesRun,
      });
    }, 30000);

    // Cycler state
    let cyclerActive = true;
    let cyclesRun = 0;
    let lastCycleAt = null;
    let cyclerTimer = null;
    let lastUserAction = Date.now();
    ['click', 'mousemove', 'keydown', 'wheel'].forEach((ev) =>
      document.addEventListener(ev, () => { lastUserAction = Date.now(); },
                                { capture: true, passive: true })
    );

    function findUnreadChatRows() {
      const sels = [
        'span[aria-label$="unread message"]',
        'span[aria-label$="unread messages"]',
        'span[aria-label*="unread"]',
        'span[data-icon="unread-count"]',
      ];
      const rowSet = new Set();
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach((badge) => {
          let cur = badge;
          for (let i = 0; i < 12 && cur; i++) {
            const role = cur.getAttribute && cur.getAttribute('role');
            if (role === 'listitem' || role === 'row' || role === 'gridcell') {
              rowSet.add(cur);
              break;
            }
            cur = cur.parentElement;
          }
        });
      }
      return Array.from(rowSet);
    }

    function humanClick(el) {
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      setTimeout(() => {
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
      }, 30 + Math.random() * 80);
    }

    async function cycleOnce() {
      const idle = Date.now() - lastUserAction;
      if (idle < 60000) {
        console.log('[globus-wa cycler] user active', Math.round(idle / 1000),
                    's ago — skip');
        return;
      }
      const unread = findUnreadChatRows();
      if (!unread.length) {
        console.log('[globus-wa cycler] no unread chats');
        return;
      }
      for (let i = unread.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [unread[i], unread[j]] = [unread[j], unread[i]];
      }
      const subset = unread.slice(0, 10);
      console.log('[globus-wa cycler] visiting', subset.length, 'unread chat(s)');
      for (const row of subset) {
        try { humanClick(row); }
        catch (e) { console.warn('[globus-wa cycler] click failed', e); continue; }
        await sleep(randInt(2000, 7000));
      }
      cyclesRun++;
      lastCycleAt = new Date().toISOString();
    }

    function scheduleNextCycle() {
      if (!cyclerActive) return;
      if (cyclerTimer) { clearTimeout(cyclerTimer); cyclerTimer = null; }
      const delayMs = randInt(60, 600) * 1000;
      console.log('[globus-wa cycler] next cycle in', Math.round(delayMs / 1000), 's');
      cyclerTimer = setTimeout(async () => {
        try { await cycleOnce(); } catch (e) { console.warn(e); }
        scheduleNextCycle();
      }, delayMs);
    }

    function startCycler() {
      if (!cyclerActive || cyclerTimer) return;
      console.log('[globus-wa cycler] starting');
      scheduleNextCycle();
    }
    setTimeout(startCycler, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') startCycler();
    });

    // Diag helpers (registered for the bridge dispatcher below)
    window.__globusDiag = function () {
      const bubbles = document.querySelectorAll('[data-pre-plain-text]');
      const info = {
        site: 'whatsapp', url: location.href,
        hasMain: !!document.querySelector('#main'),
        currentChat: currentChatName(),
        bubblesVisible: bubbles.length,
        seenFingerprints: seen.size,
        observerAttached: !!observer,
      };
      console.log('[globus-wa] diag:', info);
      return info;
    };
    window.__globusForceScan = function () {
      const msgs = scanAll();
      console.log('[globus-wa] force-scan captured', msgs.length);
      if (msgs.length) flushBatch(msgs);
      return msgs.length;
    };
    window.__globusCyclerStatus = function () {
      return {
        site: 'whatsapp',
        cyclerActive, cyclesRun, lastCycleAt,
        unreadVisible: findUnreadChatRows().length,
        userIdleMs: Date.now() - lastUserAction,
        nextCycleScheduled: !!cyclerTimer,
      };
    };
    window.__globusCyclerEnable = function (on) {
      cyclerActive = on === undefined ? true : !!on;
      if (!cyclerActive && cyclerTimer) { clearTimeout(cyclerTimer); cyclerTimer = null; }
      if (cyclerActive) scheduleNextCycle();
      return { cyclerActive, cyclesRun, lastCycleAt };
    };
    window.__globusCycleNow = async function () {
      console.log('[globus-wa cycler] manual fire');
      await cycleOnce();
      return { cyclesRun, lastCycleAt };
    };

    // Popup ping
    chrome.runtime.onMessage.addListener((msg, _sender, send) => {
      if (msg && msg.type === 'wa-ping') {
        send({
          ok: true, site: 'whatsapp',
          chat: currentChatName(), url: location.href,
          seenCount: seen.size,
          bubblesVisible: document.querySelectorAll('[data-pre-plain-text]').length,
          observerAttached: !!observer,
          cyclerActive, cyclesRun, lastCycleAt,
        });
        return true;
      }
    });
  }

  // ============================================================
  // bootTeams() — Microsoft Teams personal (teams.live.com/v2/) scraper.
  //
  // Teams 2.0 (the /v2/ client) uses Fluent UI + data-tid attributes for
  // most testable surfaces. The selectors below are best-guess + fallback
  // — Microsoft does change these without notice, so __globusTeamsDiag()
  // logs the raw DOM matches so we can iterate from the Console.
  //
  // Scope per Sumit 2026-06-25: group chats only. We still scan messages
  // in any open chat though — the chat_type field tells the server which
  // ones to keep (group vs 1:1 filter happens server-side at insert).
  // ============================================================
  function bootTeams() {
    console.log('[globus-teams] content script loaded at', new Date().toISOString());
    injectPageBridge();

    // ---- selectors (tuned to teams.live.com/v2 DOM, 2026-06-25) ----
    // Confirmed from a real chat-pane-message dump:
    //   container: data-tid="chat-pane-message" with data-mid="<msTimestamp>"
    //   body:      <div data-message-content id="content-{mid}"> with <p>s
    //   author:    SEPARATE element with id="author-{mid}" (sits in a
    //              sibling/header block — one per consecutive-from-same-sender
    //              run). Look it up by id, not by descendant query.
    //   timestamp: data-mid IS the ms-since-epoch timestamp (snowflake).
    const SEL = {
      chatHeader: [
        // Document title is the reliable signal on this build
        // ("(1) Chat | SEO BHILAI | Microsoft Teams"). DOM selectors
        // below are fallbacks.
        '[data-tid="chat-pane-header-title"]',
        '[data-tid="chat-header-title"]',
        '[role="banner"] [role="heading"]',
      ],
      messageContainer: ['[data-tid="chat-pane-message"]'],
      // Chat list (left sidebar) — Teams 2.0 uses Fluent UI Tree.
      // Each chat row is role="treeitem" with data-testid="list-item"
      // (the folder rows are role="treeitem" too but have
      // data-conversation-folder="true" instead — exclude them).
      chatListItem: [
        '[role="treeitem"][data-testid="list-item"]',
      ],
      // Per-chat unread markers. 2026-07-05 DOM sample confirmed
      // Teams 2.0 renders `data-tid="unread"` on the row-side unread
      // indicator; aria-label variants kept as fallback.
      unreadBadge: [
        '[data-tid="unread"]',
        '[data-tid="chat-list-item-unread-count"]',
        '[aria-label*="unread message" i]',
        '[aria-label*="new message" i]',
      ],
    };

    function querySelOne(sels, root) {
      root = root || document;
      for (const s of sels) {
        const el = root.querySelector(s);
        if (el) return el;
      }
      return null;
    }
    function querySelAll(sels, root) {
      root = root || document;
      const out = new Set();
      for (const s of sels) {
        root.querySelectorAll(s).forEach((el) => out.add(el));
      }
      return Array.from(out);
    }

    function currentChatName() {
      // Document title is the most reliable signal — Teams sets it to
      // "(N) Chat | <chat name> | Microsoft Teams" or
      // "<chat name> | Microsoft Teams".
      const docT = (document.title || '').trim();
      if (docT) {
        const parts = docT.split('|').map((p) => p.trim()).filter(Boolean);
        // Pick the middle/longest non-"Microsoft Teams" / non-"Chat" piece
        const candidates = parts.filter((p) =>
          p && !/^microsoft teams$/i.test(p) && !/^\(?\d+\)?\s*chat$/i.test(p)
            && !/^chat$/i.test(p));
        if (candidates.length) return candidates[candidates.length - 1] || candidates[0];
      }
      const el = querySelOne(SEL.chatHeader);
      const t = safeText(el);
      return t || '(unknown chat)';
    }

    // Author lookup by id — Teams renders ONE author header per
    // consecutive run from the same sender, and the message container's
    // aria-labelledby references it: "author-<mid>". So document-wide
    // getElementById is both correct and cheap.
    function extractAuthor(container, mid) {
      const el = mid ? document.getElementById('author-' + mid) : null;
      const t = safeText(el);
      if (t) return t;
      // Fallback: walk up to the nearest fui-ChatMessage or [role="group"]
      // wrapper and look for any element whose id starts with "author-"
      let cur = container.parentElement;
      for (let i = 0; i < 6 && cur; i++) {
        const a = cur.querySelector('[id^="author-"]');
        if (a) {
          const t2 = safeText(a);
          if (t2) return t2;
        }
        cur = cur.parentElement;
      }
      return '';
    }

    // Body extraction — Teams puts message content in
    // <div data-message-content id="content-{mid}"> with <p> children
    // (one per line). Concatenate <p>s with \n so multi-line messages
    // stay readable; fall back to safeText if structure differs.
    function extractBody(container, mid) {
      let el = mid ? document.getElementById('content-' + mid) : null;
      if (!el) el = container.querySelector('[data-message-content]');
      if (!el) return '';
      const ps = el.querySelectorAll(':scope > p');
      if (ps.length) {
        const parts = [];
        ps.forEach((p) => { const t = safeText(p); if (t || parts.length) parts.push(t); });
        return parts.join('\n').trim();
      }
      return safeText(el);
    }

    // Timestamp: data-mid IS a Teams snowflake / ms-since-epoch. Convert
    // to ISO 8601 so the server gets a real DATETIME (no string-parsing).
    function extractTimestamp(mid) {
      if (!mid) return '';
      const ms = parseInt(mid, 10);
      if (!isFinite(ms) || ms < 1e12 || ms > 1e14) return '';
      try { return new Date(ms).toISOString(); }
      catch (e) { return ''; }
    }

    // Direction: msgs from "me" vs others. Teams marks own-author chip
    // with a "You" badge in some places, but the most reliable signal
    // here is comparing the extracted sender to the document title /
    // own-profile name. Without a clean signal, default 'in'.
    function detectDirection(container, sender) {
      if (!sender) return 'unknown';
      // Cheap heuristic: the avatar badge near own-author is labeled
      // "Profile picture of <self>." — we read it once and cache.
      if (!detectDirection._selfName) {
        const av = document.querySelector('[data-tid="me-control-avatar"]');
        const aria = (av && av.getAttribute('aria-label')) || '';
        const m = aria.match(/picture of\s+(.+?)\.?$/i);
        detectDirection._selfName = (m && m[1].trim()) || '';
      }
      if (detectDirection._selfName &&
          sender.toLowerCase() === detectDirection._selfName.toLowerCase()) {
        return 'out';
      }
      return 'in';
    }

    function classifyChatType(chatName) {
      // Definitive group marker — Teams 2.0 renders a specific data-tid
      // when the chat is a group. (Confirmed in 2026-06-25 DOM dump.)
      if (document.querySelector('[data-tid="chat-title-name-group-chat"]')) {
        return 'group';
      }
      // Participant-count chip exists for groups too
      if (document.querySelector('[data-tid="chat-header-participant-count"]')) {
        return 'group';
      }
      if (!chatName) return 'unknown';
      if (/,/.test(chatName)) return 'group';
      return 'oneonone';
    }

    // De-dup by Teams' own message id (data-mid) — stable across
    // re-renders, way cheaper than hashing chat+ts+sender+body.
    const seen = new Set();

    // Teams messages can be huge multi-paragraph posts (pasted docs,
    // long status updates). Cap each at this size before queueing so
    // the background batches stay shippable. Server still re-caps at
    // its own limit (6000) before insert.
    const MAX_BODY_CHARS = 9000;

    function scanAll() {
      const chatName = currentChatName();
      const chatType = classifyChatType(chatName);
      const containers = querySelAll(SEL.messageContainer);
      const out = [];
      containers.forEach((c) => {
        try {
          const mid = c.getAttribute && c.getAttribute('data-mid');
          if (!mid) return;
          // De-dup by mid (real Teams message id, stable across re-renders)
          if (seen.has(mid)) return;
          let body = extractBody(c, mid);
          if (!body) return;
          if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS);
          const sender = extractAuthor(c, mid);
          const ts = extractTimestamp(mid);
          seen.add(mid);
          out.push({
            chat: chatName,
            chat_type: chatType,
            mid,            // real Teams message id (server uses for dedup)
            ts, sender, body,
            direction: detectDirection(c, sender),
          });
        } catch (e) {}
      });
      if (out.length) {
        console.log('[globus-teams] captured', out.length,
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

    let runtimeDead = false;
    function flushBatch(messages) {
      if (!messages.length || runtimeDead) return;
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        if (!runtimeDead) {
          runtimeDead = true;
          console.warn('[globus-teams] runtime gone — refresh this page.');
        }
        return;
      }
      try {
        chrome.runtime.sendMessage(
          { type: 'teams-messages', messages, url: location.href, ts: Date.now() },
          (_resp) => {
            if (chrome.runtime && chrome.runtime.lastError) {
              runtimeDead = true;
              console.warn('[globus-teams] bg send failed — refresh the tab. '
                           + chrome.runtime.lastError.message);
            }
          }
        );
      } catch (e) {
        runtimeDead = true;
        console.warn('[globus-teams] sendMessage threw — refresh the tab.', e.message);
      }
    }

    // Teams scraper auto-enables in v0.3.3 — the v0.3.0 hang was caused
    // by per-rAF scanning + cloneNode(true) on huge containers, both
    // removed. Current scan is 3s-debounced + direct selectors, no
    // clones. Kill switch: __globusTeamsEnable(false) from console.
    let scrapingEnabled = true;

    // Long debounce (3s after last mutation) instead of rAF.
    // Teams renders new things every animation frame.
    let scanTimer = null;
    const SCAN_DEBOUNCE_MS = 3000;
    function scheduleScan() {
      if (!scrapingEnabled) return;
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        scanTimer = null;
        try {
          const msgs = scanAll();
          if (msgs.length) { flushBatch(msgs); trimSeen(); }
        } catch (e) { console.warn('[globus-teams] scan failed', e); }
      }, SCAN_DEBOUNCE_MS);
    }

    let observer = null;
    function attachObserver() {
      if (observer) return true;
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, {
        childList: true, subtree: true, characterData: false,
      });
      console.log('[globus-teams] observer attached');
      return true;
    }
    function detachObserver() {
      if (observer) { observer.disconnect(); observer = null; }
      if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
      console.log('[globus-teams] observer detached');
    }

    // ---- cycler ----
    // Cycler is also opt-in; only starts when scrapingEnabled is set.
    let cyclerActive = false;
    let cyclesRun = 0;
    let lastCycleAt = null;
    let cyclerTimer = null;
    let lastUserAction = Date.now();
    ['click', 'mousemove', 'keydown', 'wheel'].forEach((ev) =>
      document.addEventListener(ev, () => { lastUserAction = Date.now(); },
                                { capture: true, passive: true })
    );

    function findUnreadChatRows() {
      // Walk all chat-list rows (treeitems w/ data-testid="list-item")
      // and pick the ones whose own aria-label / badge children indicate
      // unread state. Excludes folder rows via data-conversation-folder.
      const rows = document.querySelectorAll(SEL.chatListItem[0]);
      const out = [];
      rows.forEach((row) => {
        if (row.getAttribute('data-conversation-folder') === 'true') return;
        // aria-label fingerprint: Teams labels unread chats with a count
        // like "1 unread message, Chat with X" — substring match.
        const aria = (row.getAttribute('aria-label') || '').toLowerCase();
        if (/\bunread\b/.test(aria) || /\bnew message/.test(aria)) {
          out.push(row); return;
        }
        // Badge child fallback
        for (const sel of SEL.unreadBadge) {
          if (row.querySelector(sel)) { out.push(row); return; }
        }
      });
      return out;
    }

    function humanClick(el) {
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      setTimeout(() => {
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
      }, 30 + Math.random() * 80);
    }

    async function cycleOnce() {
      const idle = Date.now() - lastUserAction;
      if (idle < 60000) {
        console.log('[globus-teams cycler] user active', Math.round(idle / 1000),
                    's ago — skip');
        return;
      }
      const unread = findUnreadChatRows();
      if (!unread.length) {
        console.log('[globus-teams cycler] no unread chats');
        return;
      }
      for (let i = unread.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [unread[i], unread[j]] = [unread[j], unread[i]];
      }
      const subset = unread.slice(0, 10);
      console.log('[globus-teams cycler] visiting', subset.length, 'unread chat(s)');
      for (const row of subset) {
        try { humanClick(row); }
        catch (e) { console.warn('[globus-teams cycler] click failed', e); continue; }
        await sleep(randInt(2000, 7000));
      }
      cyclesRun++;
      lastCycleAt = new Date().toISOString();
    }

    function scheduleNextCycle() {
      if (!cyclerActive) return;
      if (cyclerTimer) { clearTimeout(cyclerTimer); cyclerTimer = null; }
      const delayMs = randInt(60, 600) * 1000;
      console.log('[globus-teams cycler] next cycle in', Math.round(delayMs / 1000), 's');
      cyclerTimer = setTimeout(async () => {
        try { await cycleOnce(); } catch (e) { console.warn(e); }
        scheduleNextCycle();
      }, delayMs);
    }

    function startCycler() {
      if (!cyclerActive || cyclerTimer) return;
      console.log('[globus-teams cycler] starting');
      scheduleNextCycle();
    }

    // Auto-boot: attach observer + cycler now that selectors are tight.
    // Wait 5s to let teams.live.com finish its initial render storm.
    setTimeout(() => {
      if (!scrapingEnabled) return;
      attachObserver();
      cyclerActive = true;
      scheduleNextCycle();
      scheduleScan();
      console.log('[globus-teams] auto-enabled (observer + cycler running)');
    }, 5000);

    // Heartbeat every 30s: prints what the scraper sees so a "0 uploads"
    // report can be diagnosed by opening F12 -> Console -> filter '[globus-teams]'.
    setInterval(() => {
      if (!scrapingEnabled) return;
      console.log('[globus-teams] heartbeat', {
        chat: currentChatName(),
        containers: querySelAll(SEL.messageContainer).length,
        chatRows: querySelAll(SEL.chatListItem).length,
        unreadHits: querySelAll(SEL.unreadBadge).length,
        seen: seen.size,
        observer: !!observer,
        cyclerActive, cyclesRun,
      });
    }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && scrapingEnabled
          && !observer) {
        attachObserver();
        scheduleScan();
      }
    });

    // ---- opt-in switch (Teams scraper is OFF by default in v0.3.2) ----
    window.__globusTeamsEnable = function (on) {
      const prev = scrapingEnabled;
      scrapingEnabled = (on === undefined) ? true : !!on;
      if (scrapingEnabled && !prev) {
        attachObserver();
        cyclerActive = true;
        scheduleNextCycle();
        scheduleScan();
        console.log('[globus-teams] SCRAPER ENABLED (observer + cycler running)');
      } else if (!scrapingEnabled && prev) {
        detachObserver();
        cyclerActive = false;
        if (cyclerTimer) { clearTimeout(cyclerTimer); cyclerTimer = null; }
        console.log('[globus-teams] scraper disabled');
      }
      return { scrapingEnabled, observerAttached: !!observer,
               cyclerActive, cyclesRun, lastCycleAt };
    };

    // ---- dev helper: upload the entire rendered page source to the
    // server so Claude can debug DOM structure without copy-paste. The
    // server stashes it at /var/tmp/globus-debug-{member}-{ts}.html and
    // returns the saved filename. ----
    window.__globusUploadSource = function () {
      return new Promise((resolve) => {
        try {
          const html = document.documentElement.outerHTML;
          console.log('[globus-teams] uploading page source ('
                      + html.length + ' chars)...');
          chrome.runtime.sendMessage(
            { type: 'upload-debug', site: 'teams', url: location.href,
              chat: currentChatName(), html },
            (resp) => {
              if (chrome.runtime && chrome.runtime.lastError) {
                console.warn('[globus-teams] upload failed:',
                             chrome.runtime.lastError.message);
                resolve({ error: chrome.runtime.lastError.message });
              } else {
                console.log('[globus-teams] upload ok:', resp);
                resolve(resp);
              }
            }
          );
        } catch (e) {
          console.warn('[globus-teams] upload threw:', e);
          resolve({ error: String(e && e.message || e) });
        }
      });
    };

    // ---- dev helper: dump one message's outerHTML for selector tuning ----
    // Logs the raw HTML of the Nth message container (default: first one).
    // After v0.3.2 lands, Sumit calls this on Teams and screenshots the
    // output so I can write tight sender/timestamp/body selectors.
    window.__globusDumpHTML = function (n) {
      n = n || 0;
      const containers = querySelAll(SEL.messageContainer);
      if (!containers.length) {
        console.log('[globus-teams] no message containers found');
        return null;
      }
      const c = containers[n] || containers[0];
      const html = c.outerHTML || '';
      console.log('[globus-teams] container #' + n + ' (' + html.length
                  + ' chars):');
      // Print in 4KB chunks so the DevTools log doesn't truncate.
      const CHUNK = 4000;
      for (let i = 0; i < html.length; i += CHUNK) {
        console.log(html.slice(i, i + CHUNK));
      }
      // Also stash on window so it survives if you scroll the console.
      window.__globusLastHTML = html;
      return { length: html.length, savedTo: '__globusLastHTML' };
    };

    // Diag helpers (also routed via bridge dispatcher below)
    window.__globusDiag = function () {
      const containers = querySelAll(SEL.messageContainer);
      const chats = querySelAll(SEL.chatListItem);
      const info = {
        site: 'teams', url: location.href,
        currentChat: currentChatName(),
        chatType: classifyChatType(currentChatName()),
        messagesVisible: containers.length,
        chatListItemsVisible: chats.length,
        seenFingerprints: seen.size,
        observerAttached: !!observer,
        // Selector hit count — helps diagnose which selectors actually work
        // on Sumit's specific Teams build
        selectorHits: {
          header: SEL.chatHeader.map((s) => [s, document.querySelectorAll(s).length]),
          messageContainer: SEL.messageContainer.map((s) => [s, document.querySelectorAll(s).length]),
          chatListItem: SEL.chatListItem.map((s) => [s, document.querySelectorAll(s).length]),
          unreadBadge: SEL.unreadBadge.map((s) => [s, document.querySelectorAll(s).length]),
          messageBodyById: document.querySelectorAll('[id^="content-"]').length,
          authorById: document.querySelectorAll('[id^="author-"]').length,
        },
      };
      console.log('[globus-teams] diag:', info);
      if (containers.length > 0) {
        const c = containers[0];
        console.log('[globus-teams] first container sample:', {
          ariaLabel: c.getAttribute && c.getAttribute('aria-label'),
          dataTid:   c.getAttribute && c.getAttribute('data-tid'),
          sender:    extractAuthor(c),
          ts:        extractTimestamp(c),
          body:      (extractBody(c) || '').slice(0, 120),
        });
      }
      return info;
    };
    window.__globusForceScan = function () {
      const msgs = scanAll();
      console.log('[globus-teams] force-scan captured', msgs.length);
      if (msgs.length) flushBatch(msgs);
      return msgs.length;
    };
    window.__globusCyclerStatus = function () {
      return {
        site: 'teams',
        cyclerActive, cyclesRun, lastCycleAt,
        unreadVisible: findUnreadChatRows().length,
        userIdleMs: Date.now() - lastUserAction,
        nextCycleScheduled: !!cyclerTimer,
      };
    };
    window.__globusCyclerEnable = function (on) {
      cyclerActive = on === undefined ? true : !!on;
      if (!cyclerActive && cyclerTimer) { clearTimeout(cyclerTimer); cyclerTimer = null; }
      if (cyclerActive) scheduleNextCycle();
      return { cyclerActive, cyclesRun, lastCycleAt };
    };
    window.__globusCycleNow = async function () {
      console.log('[globus-teams cycler] manual fire');
      await cycleOnce();
      return { cyclesRun, lastCycleAt };
    };

    chrome.runtime.onMessage.addListener((msg, _sender, send) => {
      if (msg && msg.type === 'wa-ping') {  // popup uses the same ping
        send({
          ok: true, site: 'teams',
          chat: currentChatName(), url: location.href,
          seenCount: seen.size,
          bubblesVisible: querySelAll(SEL.messageContainer).length,
          observerAttached: !!observer,
          cyclerActive, cyclesRun, lastCycleAt,
        });
        return true;
      }
    });
  }

  // ============================================================
  // Bridge dispatcher — handles postMessage requests from
  // page-bridge.js (page main world) so window.__globus* helpers
  // are callable from the regular DevTools console. The actual
  // functions are registered on `window` by whichever bootXxx()
  // module ran above.
  // ============================================================
  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (!d || d.src !== "globus-bridge" || d.dir !== "req") return;
    let result;
    try {
      switch (d.kind) {
        case "cyclerStatus":
          result = window.__globusCyclerStatus && window.__globusCyclerStatus();
          break;
        case "cyclerEnable":
          result = window.__globusCyclerEnable && window.__globusCyclerEnable(d.args && d.args.on);
          break;
        case "cycleNow":
          result = window.__globusCycleNow && await window.__globusCycleNow();
          break;
        case "diag":
          result = window.__globusDiag && window.__globusDiag();
          break;
        case "forceScan":
          result = window.__globusForceScan && window.__globusForceScan();
          break;
        case "teamsEnable":
          result = window.__globusTeamsEnable
                   ? window.__globusTeamsEnable(d.args && d.args.on)
                   : { error: "teamsEnable not on this site" };
          break;
        case "uploadSource":
          result = window.__globusUploadSource
                   ? await window.__globusUploadSource()
                   : { error: "uploadSource not on this site" };
          break;
        case "dumpHTML":
          result = window.__globusDumpHTML
                   ? window.__globusDumpHTML(d.args && d.args.n)
                   : { error: "dumpHTML not on this site" };
          break;
        default:
          result = { error: "unknown kind: " + d.kind };
      }
    } catch (e) {
      result = { error: String(e && e.message || e) };
    }
    window.postMessage(
      { src: "globus-bridge", dir: "res", id: d.id, result: result }, "*");
  });

  // ============================================================
  // Site dispatch — only ONE module boots per tab based on hostname.
  // ============================================================
  const host = location.hostname;
  if (host.indexOf("web.whatsapp.com") >= 0) {
    bootWhatsApp();
  } else if (host.indexOf("teams.live.com") >= 0) {
    bootTeams();
  } else {
    console.warn("[globus-bridge] unrecognized host:", host);
  }
})();
