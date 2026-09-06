/**
 * Content script on pos.v2.circa.vn and admin.v2.circa.vn.
 *
 * Batch 2B.2A scope: nothing but the handshake that tells this page which tab it is in,
 * and a re-arm check so a page that loads inside an active recording knows about it.
 * Element picking arrives in 2B.2B; the Tool-tip nav entry and the tour runtime are
 * Batch 3.
 *
 * Classic script, not a module: `content_scripts` cannot load ES modules, and it shares
 * a scope with vendor/guide-schema.global.js which is loaded just before it.
 */

(() => {
  "use strict";

  if (window.__circaTooltipLoaded) return;
  window.__circaTooltipLoaded = true;

  /** Filled by the handshake. Every per-tab session key is derived from it. */
  let TAB_ID = null;

  chrome.runtime.sendMessage({ type: "tg:hello" }, (reply) => {
    if (chrome.runtime.lastError) {
      // The worker was asleep or the extension was reloaded mid-navigation. Not fatal:
      // nothing is recording yet, and the next navigation handshakes again.
      console.debug("[tooltip] handshake chưa tới được background:", chrome.runtime.lastError.message);
      return;
    }
    if (!reply?.ok) {
      console.warn("[tooltip] handshake bị từ chối:", reply?.error);
      return;
    }

    TAB_ID = reply.data.tabId;

    // Loudly flag the one mistake that fails silently: if setAccessLevel was never
    // called, session reads come back undefined and every resume quietly no-ops.
    if (TAB_ID === null) {
      console.warn("[tooltip] không lấy được tabId — state theo tab sẽ không hoạt động.");
    }

    if (reply.data.recording) {
      console.debug(
        `[tooltip] tab ${TAB_ID} đang trong phiên ghi ${reply.data.recording.id}`,
        `(${reply.data.recording.steps.length} bước)`,
      );
    }
  });
})();
