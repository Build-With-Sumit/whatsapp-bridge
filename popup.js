// Globus WhatsApp bridge — popup script.
// Shows status, accepts pairing token, lets the user force a flush.

const $ = (id) => document.getElementById(id);

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
    $('queuedLine').textContent = s.queued;
    $('sentLine').textContent = s.lastSent;
    $('lastLine').textContent = (s.lastFlushAgoSec === null
      ? 'never' : `${s.lastFlushAgoSec}s ago`);
    $('errLine').textContent = s.lastError ? `error: ${s.lastError}` : '';
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
  if (!raw) {
    toast('Paste a token first.', false);
    return;
  }
  // Token format expected: "<email>|<expires_unix>|<hmac>"
  let member = null;
  const parts = raw.split('|');
  if (parts.length === 3 && parts[0].includes('@')) {
    member = parts[0];
  } else {
    toast('Token looks malformed — expected email|expires|hmac', false);
    return;
  }
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

refresh();
setInterval(refresh, 3000);
