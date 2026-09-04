// Globus Teams & WhatsApp bridge — popup script.
// Shows per-source status, accepts pairing token, lets the user force a flush.

const $ = (id) => document.getElementById(id);

function fmtLast(secAgo) {
  if (secAgo === null || secAgo === undefined) return 'never';
  return `${secAgo}s ago`;
}

function paintSource(prefix, src) {
  if (!src) return;
  $(prefix + 'Queued').textContent = src.queued;
  $(prefix + 'Sent').textContent = src.lastSent;
  $(prefix + 'Last').textContent = fmtLast(src.lastFlushAgoSec);
  $(prefix + 'Err').textContent = src.lastError ? `error: ${src.lastError}` : '';
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'get-status' }, (s) => {
    if (chrome.runtime.lastError || !s) {
      $('statusPill').textContent = 'background error';
      $('statusPill').className = 'pill err';
      return;
    }
    $('statusPill').textContent = s.tokenSet ? 'paired' : 'unpaired';
    $('statusPill').className = 'pill ' + (s.tokenSet ? 'ok' : 'warn');
    $('memberLine').textContent = s.member || '—';
    paintSource('wa', s.whatsapp);
    paintSource('teams', s.teams);
  });
}

function toast(text, ok) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;left:14px;right:14px;bottom:12px;'
      + 'padding:8px 12px;border-radius:6px;font-size:12px;font-weight:600;'
      + 'text-align:center;z-index:9999;transition:opacity .3s';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.background = ok ? '#2A8000' : '#8a1a1a';
  el.style.color = '#fff';
  el.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.style.opacity = '0'; }, 2400);
}

$('saveBtn').addEventListener('click', () => {
  const raw = $('tokenInput').value.trim();
  if (!raw) { toast('Paste a token first.', false); return; }
  // Expected: "<email>|<expires_unix>|<hmac>"
  const parts = raw.split('|');
  if (parts.length !== 3 || !parts[0].includes('@')) {
    toast('Token looks malformed — expected email|expires|hmac', false);
    return;
  }
  const member = parts[0];
  chrome.runtime.sendMessage(
    { type: 'set-token', token: raw, member },
    () => {
      $('tokenInput').value = '';
      toast('Token saved · paired as ' + member, true);
      refresh();
    }
  );
});

$('flushBtn').addEventListener('click', () => {
  $('flushBtn').disabled = true;
  chrome.runtime.sendMessage({ type: 'flush-now' }, () => {
    setTimeout(() => {
      $('flushBtn').disabled = false;
      refresh();
    }, 600);
  });
});

// Send the active tab's full rendered HTML to the server for debugging.
// We executeScript into the tab to grab document.documentElement.outerHTML,
// then forward via the existing 'upload-debug' bg handler.
$('uploadSourceBtn').addEventListener('click', async () => {
  const btn = $('uploadSourceBtn');
  btn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) { toast('No active tab.', false); return; }
    const host = (() => { try { return new URL(tab.url).hostname; } catch (e) { return ''; } })();
    const isTeams = /teams\.live\.com/.test(host);
    const isWA    = /web\.whatsapp\.com/.test(host);
    if (!isTeams && !isWA) {
      toast('Open Teams or WhatsApp first.', false);
      return;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ html: document.documentElement.outerHTML,
                     url: location.href, title: document.title }),
    });
    const payload = (results && results[0] && results[0].result) || {};
    chrome.runtime.sendMessage(
      { type: 'upload-debug',
        site: isTeams ? 'teams' : 'whatsapp',
        url: payload.url, chat: payload.title || '',
        html: payload.html || '' },
      (resp) => {
        if (resp && resp.ok) {
          toast('Source uploaded (' + (payload.html || '').length + ' chars)', true);
        } else {
          toast('Upload failed: ' + ((resp && (resp.error || resp.status)) || '?'), false);
        }
      }
    );
  } catch (e) {
    toast('Error: ' + (e && e.message || e), false);
  } finally {
    setTimeout(() => { btn.disabled = false; }, 1500);
  }
});

refresh();
setInterval(refresh, 3000);
