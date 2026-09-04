// page-bridge.js — runs in the PAGE's main world (not the isolated
// content-script world), so functions exposed on window are callable
// directly from DevTools Console.
//
// Communicates with content.js via window.postMessage round-trips.
// content.js attaches a listener and replies with the data.

(function () {
  "use strict";
  const PFX = "globus-bridge";
  const pending = new Map();     // requestId -> resolve
  let reqCounter = 0;

  function call(kind, args) {
    const id = "r" + (++reqCounter);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      window.postMessage({ src: PFX, dir: "req", id, kind, args: args || {} }, "*");
      // 5s safety timeout — if content script doesn't reply, resolve undef
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ __bridgeTimeout: true });
        }
      }, 5000);
    });
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.src !== PFX || d.dir !== "res") return;
    const r = pending.get(d.id);
    if (r) { pending.delete(d.id); r(d.result); }
  });

  // Expose diag functions to the page console — these are what fixes
  // the 'ReferenceError: __globusCyclerStatus is not defined' that
  // happens when calling content-script functions from the regular tab
  // console (isolated worlds don't share window).
  window.__globusCyclerStatus = function () { return call("cyclerStatus"); };
  window.__globusCyclerEnable = function (on) { return call("cyclerEnable", { on: on }); };
  window.__globusCycleNow     = function () { return call("cycleNow"); };
  window.__globusDiag         = function () { return call("diag"); };
  window.__globusForceScan    = function () { return call("forceScan"); };
  // Teams-only helpers (no-op on WA pages)
  window.__globusTeamsEnable  = function (on) { return call("teamsEnable", { on: on }); };
  window.__globusUploadSource = function () { return call("uploadSource"); };
  window.__globusDumpHTML     = function (n) { return call("dumpHTML", { n: n }); };

  console.log("[globus-bridge] page-side helpers ready: "
              + "__globusCyclerStatus / __globusCycleNow / __globusCyclerEnable / "
              + "__globusDiag / __globusForceScan / __globusTeamsEnable / "
              + "__globusUploadSource / __globusDumpHTML");
})();
