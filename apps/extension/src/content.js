/**
 * Content script on pos.v2.circa.vn and admin.v2.circa.vn.
 *
 * Two states, and it is inert in the first one:
 *   - not recording: a handshake, and nothing else. No listeners, no UI, no cost.
 *   - recording:     an element picker. Hover highlights, a click captures a step.
 *
 * How a click is captured, and why in this order (Batch 2B.2B acceptance):
 *
 *   1. The click is caught in the CAPTURE phase and cancelled, so the page has not seen
 *      it yet and nothing has navigated.
 *   2. The step is persisted through the service worker into chrome.storage.session and
 *      we wait for the confirmation. A hard navigation cannot lose the step, because the
 *      step is already written before anything is allowed to navigate.
 *   3. Only then is the click replayed on the element.
 *
 * The replay does not record a second step because `el.click()` produces an untrusted
 * event and the handler ignores anything with `isTrusted === false`. That is a property
 * of the event, not a flag we have to remember to clear — a flag would survive a thrown
 * exception and silently stop recording.
 *
 * Classic script, not a module: `content_scripts` cannot load ES modules. It shares a
 * scope with vendor/guide-schema.global.js and selector.js, both loaded just before it.
 */

(() => {
  "use strict";

  if (window.__circaTooltipLoaded) return;
  window.__circaTooltipLoaded = true;

  const PICK = globalThis.TG_SELECTOR;

  /** Filled by the handshake. Every per-tab session key is derived from it. */
  let TAB_ID = null;
  /** The recording session this tab belongs to, or null when nothing is recording. */
  let session = null;
  /** True while a captured click is being persisted; a second click must not queue up. */
  let busy = false;
  let ui = null;
  let watcher = null;
  let lastUrl = location.href;

  /* ------------------------------------------------------------------ handshake */

  /**
   * The service worker attaches this tab to the session immediately after creating it,
   * but "immediately" is two async hops and this script runs at document_idle. The
   * ordering is not guaranteed by anything, so ask again a couple of times before
   * concluding that nothing is being recorded here.
   */
  const HANDSHAKE_RETRIES_MS = [0, 400, 1500];

  async function handshake(attempt) {
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: "tg:hello" });
    } catch (err) {
      // The worker was asleep or the extension was reloaded mid-navigation. Not fatal.
      console.debug("[tooltip] handshake chưa tới được background:", err?.message ?? err);
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
      return;
    }

    if (reply.data.recording) {
      arm(reply.data.recording);
      return;
    }

    const next = HANDSHAKE_RETRIES_MS[attempt + 1];
    if (next !== undefined) setTimeout(() => void handshake(attempt + 1), next);
  }

  setTimeout(() => void handshake(0), HANDSHAKE_RETRIES_MS[0]);

  /** The worker tells us when the recording ends; otherwise this tab would keep eating clicks. */
  chrome.runtime.onMessage.addListener((raw) => {
    if (raw?.type === "tg:disarm") disarm();
    return false;
  });

  /* ------------------------------------------------------------------ arm/disarm */

  function arm(recording) {
    const wasArmed = !!session;
    session = recording;
    if (wasArmed) {
      render();
      return;
    }

    buildUi();
    document.addEventListener("click", onClick, true);
    document.addEventListener("mouseover", onHover, true);
    document.addEventListener("scroll", hideBox, true);
    window.addEventListener("resize", hideBox);

    // POS and Admin are single-page apps: a route change never reloads this script, so
    // there is no load event to hang a navigation report on. Polling the URL is a few
    // lines and catches every kind of navigation, including replaceState.
    lastUrl = location.href;
    watcher = setInterval(checkUrl, 700);

    reportNavigation();
    render();
  }

  function disarm() {
    if (!session) return;
    session = null;
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mouseover", onHover, true);
    document.removeEventListener("scroll", hideBox, true);
    window.removeEventListener("resize", hideBox);
    if (watcher) clearInterval(watcher);
    watcher = null;
    destroyUi();
  }

  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    hideBox();
    reportNavigation();
  }

  function reportNavigation() {
    if (!session) return;
    void chrome.runtime
      .sendMessage({ type: "tg:navigated", sessionId: session.id, url: location.pathname + location.search })
      .catch(() => {});
  }

  /* --------------------------------------------------------------------- capture */

  function ours(node) {
    return !!(ui && ui.host && (node === ui.host || ui.host.contains(node)));
  }

  function onHover(ev) {
    if (!session || busy) return;
    const el = ev.target;
    if (!(el instanceof Element) || ours(el)) return;
    showBox(PICK.interactiveTarget(el));
  }

  /**
   * `select` opens a native dropdown and `input[type=file]` opens the file chooser, and
   * neither can be reproduced by a scripted click: the dropdown simply will not open,
   * and the file dialog is refused because the user gesture is gone by the time the
   * step has been persisted. For those two the click is left alone and the step is
   * recorded alongside it — neither of them navigates, so nothing can be lost.
   */
  function mustReplay(el) {
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "select") return false;
    if (tag === "input" && String(el.getAttribute("type") || "").toLowerCase() === "file") return false;
    return true;
  }

  function describeAt(el) {
    return {
      ...PICK.describe(el, (sel) => document.querySelectorAll(sel).length),
      // Path only, no query string. The audit found real phone numbers sitting in POS
      // query parameters, and a recorder that copies the query into a guide would put
      // them straight back into a published release. `path` mode matches regardless of
      // the query; an Admin who needs a narrower pattern adds it in the editor.
      urlPattern: location.pathname,
      origin: location.origin,
      at: new Date().toISOString(),
    };
  }

  function onClick(ev) {
    // Untrusted means this is our own replay (or a script's click) — never a step.
    if (!session || !ev.isTrusted || ev.button !== 0) return;
    const raw = ev.target;
    if (!(raw instanceof Element) || ours(raw)) return;

    const el = PICK.interactiveTarget(raw);
    const replay = mustReplay(el);

    if (replay) {
      // Stop the page from acting on the click until the step is safely stored.
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
    }
    if (busy) return;
    busy = true;

    let step;
    try {
      step = describeAt(el);
    } catch (err) {
      busy = false;
      flash("Không đọc được phần tử: " + (err?.message ?? err));
      return;
    }

    void capture(el, step, replay);
  }

  async function capture(el, step, replay) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "tg:step", sessionId: session.id, step });

      if (!reply?.ok) {
        // The recording is over (stopped elsewhere, tab reassigned, worker reloaded).
        // Stop intercepting and let the click the operator actually made go through,
        // rather than leaving the page silently swallowing every click.
        if (reply?.error?.code === "NO_SESSION" || reply?.error?.code === "TAB_MISMATCH") {
          disarm();
          if (replay) doReplay(el, step);
          return;
        }
        throw new Error(reply?.error?.message || "background từ chối bước này");
      }

      // The recording may have been stopped while the step was in flight; adopting the
      // reply then would leave this tab holding a session nobody is listening to.
      if (!session) return;
      session = reply.data.session;
      render();
      if (replay) doReplay(el, step);
    } catch (err) {
      // Nothing was stored, so nothing is replayed: a click the recorder did not capture
      // must not change the page either, or the guide would be missing a step the
      // operator believes they recorded.
      flash("Chưa ghi được bước: " + (err?.message ?? err) + ". Bấm lại.");
    } finally {
      busy = false;
    }
  }

  function doReplay(el, step) {
    // A framework re-render between persist and replay detaches the node we captured;
    // the selector we just recorded is the way back to its replacement.
    let target = el.isConnected ? el : null;
    if (!target) {
      for (const sel of step.selectors) {
        try {
          const found = document.querySelector(sel);
          if (found) {
            target = found;
            break;
          }
        } catch {
          /* an invalid selector is not worth failing the click over */
        }
      }
    }
    if (!target) {
      flash("Đã ghi bước, nhưng phần tử biến mất trước khi bấm lại — hãy thao tác thủ công.");
      return;
    }
    target.click();
  }

  /* -------------------------------------------------------------------- overlay */

  const CSS = `
    :host { all: initial; }
    .box {
      position: fixed; pointer-events: none; z-index: 2147483647;
      border: 2px solid #d92d20; border-radius: 3px;
      background: rgba(217, 45, 32, 0.08); transition: all .05s linear;
    }
    .bar {
      position: fixed; inset: auto 12px 12px 12px; z-index: 2147483647;
      pointer-events: none; display: flex; gap: 10px; align-items: center;
      padding: 10px 14px; border-radius: 8px; background: #1d2939; color: #fff;
      font: 500 13px/1.4 system-ui, "Segoe UI", sans-serif;
      box-shadow: 0 6px 24px rgba(0,0,0,.35);
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #d92d20; flex: none; }
    .count { background: #344054; border-radius: 999px; padding: 2px 9px; }
    .hint { opacity: .75; font-weight: 400; }
    .warn { color: #fda29b; font-weight: 600; }
  `;

  function buildUi() {
    const host = document.createElement("div");
    host.id = "circa-tooltip-recorder";
    // A shadow root so POS stylesheets cannot restyle the recorder and, more
    // importantly, so the recorder cannot restyle POS.
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;

    const box = document.createElement("div");
    box.className = "box";
    box.style.display = "none";

    const bar = document.createElement("div");
    bar.className = "bar";
    bar.innerHTML =
      '<span class="dot"></span><span class="label"></span>' +
      '<span class="count"></span><span class="hint"></span>';

    shadow.append(style, box, bar);
    (document.body || document.documentElement).appendChild(host);

    ui = {
      host,
      box,
      label: bar.querySelector(".label"),
      count: bar.querySelector(".count"),
      hint: bar.querySelector(".hint"),
    };
  }

  function destroyUi() {
    if (ui?.host?.parentNode) ui.host.parentNode.removeChild(ui.host);
    ui = null;
  }

  function showBox(el) {
    if (!ui) return;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return hideBox();
    Object.assign(ui.box.style, {
      display: "block",
      top: r.top - 2 + "px",
      left: r.left - 2 + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
  }

  function hideBox() {
    if (ui) ui.box.style.display = "none";
  }

  function render() {
    if (!ui || !session) return;
    ui.label.textContent = "Đang ghi hướng dẫn";
    ui.count.textContent = session.steps.length + " bước";
    ui.hint.className = "hint";
    ui.hint.textContent = "Bấm vào phần tử cần hướng dẫn. Dừng ghi ở tab Admin Portal.";
  }

  function flash(message) {
    if (!ui) return;
    ui.hint.className = "warn";
    ui.hint.textContent = message;
  }
})();
