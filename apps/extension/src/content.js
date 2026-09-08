/**
 * Content script on pos.v2.circa.vn and admin.v2.circa.vn.
 *
 * Inert until the worker says this tab has a job. There are three:
 *
 *   record  — an element picker. Hover highlights, a click captures a step.
 *   probe   — resolve one step's selectors against this page, report what was found.
 *   preview — walk a DRAFT guide the Portal is holding, without anything being saved.
 *
 * How a recorded click is captured, and why in this order (2B.2B acceptance):
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
 * scope with the four scripts loaded just before it.
 */

(() => {
  "use strict";

  if (window.__circaTooltipLoaded) return;
  window.__circaTooltipLoaded = true;

  const PICK = globalThis.TG_SELECTOR;
  const RESOLVE = globalThis.TG_RESOLVE;
  const TOUR = globalThis.TG_TOUR;
  const OVERLAY = globalThis.TG_OVERLAY;
  const SCHEMA = globalThis.GUIDE_SCHEMA;

  /** Filled by the handshake. Every per-tab state key hangs off it. */
  let TAB_ID = null;
  /** The job this tab is running, or null. */
  let job = null;
  /** True while a captured click is being persisted; a second click must not queue up. */
  let busy = false;
  let ui = null;
  let watcher = null;
  let lastUrl = location.href;
  /** Live tour only: DOM observer and its timeout, while waiting for a step's element. */
  let observer = null;
  let observerTimer = null;

  const send = (message) => chrome.runtime.sendMessage(message);

  function locationParts() {
    return { origin: location.origin, pathname: location.pathname, search: location.search, hash: location.hash };
  }

  /** The only place the resolver is allowed to touch the document. */
  function domApi() {
    return {
      queryAll: (selector) => Array.prototype.slice.call(document.querySelectorAll(selector)),
      textOf: (el) => (el && (el.innerText || el.textContent)) || "",
      isVisible: (el) => {
        if (!el || typeof el.getBoundingClientRect !== "function") return false;
        const r = el.getBoundingClientRect();
        return !!(r.width || r.height);
      },
    };
  }

  function scrollTo(el) {
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "nearest" });
  }

  /* ------------------------------------------------------------------ handshake */

  /**
   * The service worker attaches this tab to the job immediately after creating it, but
   * "immediately" is two async hops and this script runs at document_idle. The ordering
   * is not guaranteed by anything, so ask again a couple of times before concluding that
   * nothing is happening here.
   */
  const HANDSHAKE_RETRIES_MS = [0, 400, 1500];

  async function handshake(attempt) {
    let reply;
    try {
      reply = await send({ type: "tg:hello", loc: locationParts() });
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

    if (reply.data.job) {
      arm(reply.data.job);
      return;
    }

    const next = HANDSHAKE_RETRIES_MS[attempt + 1];
    if (next !== undefined) setTimeout(() => void handshake(attempt + 1), next);
  }

  setTimeout(() => void handshake(0), HANDSHAKE_RETRIES_MS[0]);

  /**
   * Commands pushed down by the worker.
   *
   * `tg:disarm` ends the job — without it this tab would keep eating clicks after the
   * recording stopped. `tg:session` carries a session that changed without this tab doing
   * anything, which is exactly what Undo is: it happens between the Portal and the worker,
   * so the counter here would otherwise keep showing the step that was just removed until
   * the next click or a reload.
   */
  chrome.runtime.onMessage.addListener((raw) => {
    if (raw?.type === "tg:disarm") {
      disarm();
      return false;
    }
    if (raw?.type === "tg:session") {
      // Only ever adopt the session this tab is already running. A message about some
      // other job must not repaint this one.
      const incoming = raw.session;
      if (job && incoming && incoming.id === job.id) {
        job = incoming;
        render();
      }
    }
    return false;
  });

  /* ------------------------------------------------------------------ arm/disarm */

  function arm(incoming) {
    if (job) {
      job = incoming;
      render();
      return;
    }
    job = incoming;
    ui = OVERLAY.createOverlay(document);

    if (job.kind === "record") {
      document.addEventListener("click", onClick, true);
      document.addEventListener("mouseover", onHover, true);
      document.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onScroll);

      // POS and Admin are single-page apps: a route change never reloads this script, so
      // there is no load event to hang a navigation report on. Polling the URL is a few
      // lines and catches every kind of navigation, including replaceState.
      lastUrl = location.href;
      watcher = setInterval(checkUrl, 700);
      reportNavigation();
    }

    if (job.kind === "live") {
      // Faster than the recorder's poll because a tour ACTS on arriving somewhere: the
      // person is waiting for the next step to appear, not for a status line. Catches
      // pushState, replaceState and popstate alike, which no single event does.
      lastUrl = location.href;
      watcher = setInterval(checkUrl, 350);
      window.addEventListener("pagehide", disarm);
    }

    render();
  }

  function disarm() {
    if (!job) return;
    job = null;
    stopWatching();
    window.removeEventListener("pagehide", disarm);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mouseover", onHover, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
    if (watcher) clearInterval(watcher);
    watcher = null;
    if (ui) ui.destroy();
    ui = null;
  }

  function onScroll() {
    if (ui) ui.hideBox();
  }

  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    onScroll();
    if (job?.kind === "live") {
      // Ask the worker where we are now. It owns the decision: it holds `pending` and the
      // shared matcher, and it is the only place allowed to move the tour forward.
      void resync();
      return;
    }
    reportNavigation();
  }

  async function resync() {
    stopWatching();
    const reply = await send({ type: "tg:hello", loc: locationParts() }).catch(() => null);
    if (!reply?.ok) return;
    if (!reply.data.job) {
      disarm();
      return;
    }
    job = reply.data.job;
    render();
  }

  function reportNavigation() {
    if (!job) return;
    void send({ type: "tg:navigated", sessionId: job.id, url: location.pathname + location.search }).catch(() => {});
  }

  function render() {
    if (!ui || !job) return;
    if (job.kind === "record") return renderRecorder();
    if (job.kind === "probe") return renderProbe();
    if (job.kind === "preview") return renderPreview();
    if (job.kind === "live") return renderLive();
  }

  /* ------------------------------------------------------------------- recorder */

  function renderRecorder() {
    ui.setBar({
      label: "Đang ghi hướng dẫn",
      count: job.steps.length + " bước",
      hint: "Bấm vào phần tử cần hướng dẫn. Dừng ghi ở tab Admin Portal.",
    });
  }

  function flash(message) {
    if (!ui) return;
    ui.setBar({
      label: "Đang ghi hướng dẫn",
      count: (job?.steps?.length ?? 0) + " bước",
      hint: message,
      tone: "warn",
    });
  }

  function onHover(ev) {
    if (!job || job.kind !== "record" || busy) return;
    const el = ev.target;
    if (!(el instanceof Element) || ui.contains(el)) return;
    ui.highlight(PICK.interactiveTarget(el));
  }

  /**
   * `select` opens a native dropdown and `input[type=file]` opens the file chooser, and
   * neither can be reproduced by a scripted click: the dropdown simply will not open, and
   * the file dialog is refused because the user gesture is gone by the time the step has
   * been persisted. For those two the click is left alone and the step is recorded
   * alongside it — neither of them navigates, so nothing can be lost.
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
    if (!job || job.kind !== "record" || !ev.isTrusted || ev.button !== 0) return;
    const raw = ev.target;
    if (!(raw instanceof Element) || ui.contains(raw)) return;

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
      const reply = await send({ type: "tg:step", sessionId: job.id, step });

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
      if (!job) return;
      job = reply.data.session;
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
    // A framework re-render between persist and replay detaches the node we captured; the
    // selector we just recorded is the way back to its replacement.
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

  /* ---------------------------------------------------------------------- probe */

  function renderProbe() {
    const step = job.job?.step;
    if (!step) return;

    const api = domApi();
    const result = RESOLVE.probeStep(step, api);
    const target = RESOLVE.resolveTarget(step, api);

    if (target?.element) {
      scrollTo(target.element);
      ui.highlight(target.element, result.ok ? "ok" : undefined);
    } else {
      ui.hideBox();
    }

    ui.showCard(
      {
        title: "Kiểm tra selector",
        meta: `${result.candidates.length} selector · ${location.pathname}`,
        body: result.candidates
          .map((c) => `${c.invalid ? "sai cú pháp" : c.count + " element"}  ·  ${c.selector}`)
          .join("\n"),
        note: result.ok ? result.reason || "Tìm thấy đúng phần tử." : result.reason,
        noteTone: result.ok ? "good" : "bad",
        actions: [{ id: "close", label: "Đóng", primary: true }],
      },
      (id) => {
        if (id === "close") ui.hideCard();
      },
    );

    // The Portal asked the question; the answer belongs there too, next to the step.
    void send({
      type: "tg:probe-result",
      sessionId: job.id,
      probeId: job.job.probeId,
      url: location.pathname + location.search,
      result,
    }).catch(() => {});
  }

  /* -------------------------------------------------------------------- preview */

  function previewContext() {
    const guide = job.job?.guide ?? { steps: [] };
    return {
      guide,
      steps: guide.steps || [],
      ctx: { sites: job.job?.sites ?? {}, guideSite: guide.site ?? job.site ?? null },
    };
  }

  function renderPreview() {
    const { guide, steps, ctx } = previewContext();
    if (!steps.length) return;

    const index = Math.min(Math.max(job.index || 0, 0), steps.length - 1);
    const step = steps[index];
    const meta = `Bước ${index + 1}/${steps.length}${guide.name ? " · " + guide.name : ""}`;
    const last = index === steps.length - 1;
    const nav = [
      { id: "prev", label: "Trước", disabled: index === 0 },
      { id: "next", label: last ? "Kết thúc" : "Tiếp", primary: true },
      { id: "exit", label: "Thoát" },
    ];

    // A step belongs to a page. If we are not on it, say so and offer to go there rather
    // than highlighting whatever happens to match on the wrong screen.
    if (!SCHEMA.stepMatchesLocation(step, locationParts(), ctx)) {
      const url = SCHEMA.resolveStepUrl(step, ctx);
      ui.hideBox();
      ui.showCard(
        {
          title: step.title || "(bước chưa có tiêu đề)",
          meta,
          body: step.content || "",
          note: url ? `Bước này ở trang ${url}` : "Bước này dùng URL động nên không mở thẳng được.",
          noteTone: "bad",
          actions: [{ id: "goto", label: "Đi tới trang của bước", primary: true, disabled: !url }].concat(nav),
        },
        onPreviewAction,
      );
      return;
    }

    const target = RESOLVE.resolveTarget(step, domApi());
    // Found is not the same as usable. A text mismatch means the page changed under the
    // guide: the element is shown in RED so the author can see what the step is pointing
    // at, and is never presented as a step that works.
    const usable = RESOLVE.isActionableResolution(target);
    if (target?.element) {
      scrollTo(target.element);
      ui.highlight(target.element, usable ? "ok" : "");
    } else {
      ui.hideBox();
    }

    const auto = String(step.action?.type || "").startsWith("auto_");
    ui.showCard(
      {
        title: step.title || "(bước chưa có tiêu đề)",
        meta,
        body: step.content || "",
        // Preview never performs an auto-click. Firing a real business action at an
        // element that may have resolved wrong is the whole of risk R1, and a rehearsal
        // is exactly where nobody expects an order to be placed.
        note: !target
          ? "Không tìm thấy phần tử trên trang này."
          : !usable
            ? "Tìm thấy element theo selector nhưng TEXT trên trang đã khác — runtime sẽ không dùng element này."
            : auto
              ? "Khi chạy thật bước này TỰ bấm. Bản chạy thử chỉ tô sáng, không bấm hộ."
              : "",
        noteTone: usable ? "good" : "bad",
        actions: nav,
      },
      onPreviewAction,
    );
  }

  function onPreviewAction(id) {
    const { steps, ctx } = previewContext();
    const index = Math.min(Math.max(job.index || 0, 0), steps.length - 1);

    if (id === "exit") return void exitPreview();
    if (id === "goto") {
      const url = SCHEMA.resolveStepUrl(steps[index], ctx);
      if (url) location.href = url;
      return;
    }
    if (id === "prev") return void goToStep(index - 1);
    return void goToStep(index + 1);
  }

  async function goToStep(index) {
    const { steps, ctx } = previewContext();
    if (index < 0) return;
    if (index >= steps.length) return exitPreview();

    // Persist BEFORE navigating, for the same reason a recorded step is: the next step
    // may live on another page, and the page is about to be thrown away.
    const reply = await send({ type: "tg:preview-step", sessionId: job.id, index }).catch(() => null);
    if (!reply?.ok) {
      disarm();
      return;
    }

    job = { ...job, index };
    const step = steps[index];
    if (!SCHEMA.stepMatchesLocation(step, locationParts(), ctx)) {
      const url = SCHEMA.resolveStepUrl(step, ctx);
      if (url) {
        location.href = url;
        return;
      }
    }
    render();
  }

  async function exitPreview() {
    const id = job?.id;
    disarm();
    if (id) await send({ type: "tg:preview-step", sessionId: id, exit: true }).catch(() => {});
  }

  /* ------------------------------------------------------------------ live tour */

  /**
   * Running a released guide.
   *
   * Every decision — what an action means, whether an element may be pressed, whether the
   * browser has arrived — comes from TG_TOUR and TG_RESOLVE. What lives here is the DOM
   * work and the order of operations, and the order is the part that matters: anything
   * that might navigate persists its state through the worker FIRST, because the page is
   * about to be thrown away.
   */

  /** The shape TG_TOUR reads a tour from. */
  function liveView() {
    const pinned = job.job ?? {};
    const state = job.tour ?? {};
    return {
      guide: pinned.guide,
      sites: pinned.sites,
      pending: state.pending ?? null,
      navGuard: state.navGuard ?? null,
    };
  }

  function liveSteps() {
    return job.job?.guide?.steps ?? [];
  }

  function liveIndex() {
    return Math.min(Math.max(job.index || 0, 0), Math.max(liveSteps().length - 1, 0));
  }

  /** The two questions the auto-click gate asks about an element. */
  function gateApi() {
    return {
      isVisible: (el) => {
        if (!el || typeof el.getBoundingClientRect !== "function") return false;
        const r = el.getBoundingClientRect();
        return !!(r.width || r.height);
      },
      isEnabled: (el) => el?.disabled !== true && el?.getAttribute?.("aria-disabled") !== "true",
    };
  }

  function stopWatching() {
    if (watcher) clearInterval(watcher);
    watcher = null;
    stopObserver();
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = null;
  }

  /** Persist through the worker, then adopt what it wrote. Returns false on refusal. */
  async function saveTour(patch) {
    const reply = await send({ type: "tg:tour-state", ...patch }).catch(() => null);
    if (!reply?.ok) return false;
    job = reply.data.job;
    return true;
  }

  const NAV_ACTIONS = [
    { id: "retry", label: "Thử lại" },
    { id: "exit", label: "Thoát" },
  ];

  function liveMeta(index) {
    const guide = job.job?.guide;
    return `Bước ${index + 1}/${liveSteps().length}${guide?.name ? " · " + guide.name : ""}`;
  }

  function navActions(index) {
    return [
      { id: "prev", label: "Quay lại", disabled: index === 0 },
      { id: "next", label: TOUR.isLastStep(liveView(), index) ? "Hoàn tất" : "Tiếp", primary: true },
      { id: "exit", label: "Thoát" },
    ];
  }

  function renderLive() {
    const steps = liveSteps();
    if (!steps.length) return void exitTour();

    const index = liveIndex();
    const step = steps[index];
    stopObserver();

    // 1. Is this even the right page? The worker resolved `pending` before we got here,
    //    so anything still not matching is a step we have to travel to.
    const decision = TOUR.navigationDecision(liveView(), index, locationParts(), SCHEMA);
    if (decision.action === "navigate") return void travelTo(decision.url);
    if (decision.action === "wait") return renderWaiting(index, decision.reason);
    if (decision.action === "stall") return renderStalled(index, decision.reason);

    // 2. Can this step be acted on at all?
    const target = RESOLVE.resolveTarget(step, domApi());
    const readiness = TOUR.stepReadiness(step, target, gateApi());
    if (!readiness.ok) return watchForTarget(step, index, readiness.reason);

    // 3. Show it.
    if (target?.element) {
      scrollTo(target.element);
      ui.highlight(target.element, "ok");
    } else {
      ui.hideBox();
    }

    const behaviour = TOUR.behaviourOf(step.action?.type);
    ui.showCard(
      {
        title: step.title || "(bước chưa có tiêu đề)",
        meta: liveMeta(index),
        body: step.content || "",
        note: behaviour.auto ? "Bước này extension tự thao tác." : "",
        noteTone: "good",
        actions: navActions(index),
      },
      onLiveAction,
    );

    // 4. An auto step acts by itself — once. `executedStepId` is written through the
    //    worker before the click, so a re-render or a repeated event cannot fire a second.
    if (behaviour.auto) void runAuto(step, index, target);
  }

  function renderWaiting(index, reason) {
    ui.hideBox();
    ui.showCard(
      {
        title: "Đang chờ trang",
        meta: liveMeta(index),
        body: reason,
        note: "Nếu đang ở màn hình đăng nhập, hãy đăng nhập rồi bấm Thử lại.",
        noteTone: "bad",
        actions: [{ id: "retry", label: "Thử lại", primary: true }, { id: "wait", label: "Chờ thêm" }, { id: "exit", label: "Thoát" }],
      },
      onLiveAction,
    );
  }

  function renderStalled(index, reason) {
    ui.hideBox();
    ui.showCard(
      { title: "Không mở được trang của bước", meta: liveMeta(index), body: reason, noteTone: "bad", actions: NAV_ACTIONS },
      onLiveAction,
    );
  }

  /**
   * Wait for the element, re-asking the SAME question each time.
   *
   * Not "has the selector appeared": a selector can match an element that is hidden, or
   * whose text has changed underneath the guide. The observer re-runs the full resolver
   * and the full readiness gate, so what wakes the tour up is a target it is actually
   * allowed to act on.
   */
  function watchForTarget(step, index, reason) {
    ui.hideBox();
    ui.showCard(
      {
        title: step.title || "(bước chưa có tiêu đề)",
        meta: liveMeta(index),
        body: step.content || "",
        note: `Đang tìm thành phần… ${reason}`,
        noteTone: "bad",
        actions: [{ id: "retry", label: "Thử lại", primary: true }].concat(navActions(index)),
      },
      onLiveAction,
    );

    const ready = () => TOUR.stepReadiness(step, RESOLVE.resolveTarget(step, domApi()), gateApi()).ok;
    observer = new MutationObserver(() => {
      if (!ready()) return;
      stopObserver();
      render();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    const timeoutMs = Number(step.action?.timeoutMs) || SCHEMA.WAIT_ELEMENT_TIMEOUT_MS;
    observerTimer = setTimeout(() => {
      stopObserver();
      if (job?.kind === "live") renderStalled(index, `Chờ quá lâu mà chưa thấy thành phần. ${reason}`);
    }, timeoutMs);
  }

  /** Remember where we are sending the browser, so a failed arrival cannot loop. */
  async function travelTo(url) {
    const saved = await saveTour({
      tour: { ...(job.tour ?? {}), navGuard: { url, createdAt: new Date().toISOString() }, phase: "waiting_url" },
    });
    if (!saved) return void disarm();
    location.href = url;
  }

  async function runAuto(step, index, target) {
    const state = job.tour ?? {};
    if (state.executedStepId === step.id) return; // already fired for this step
    const behaviour = TOUR.behaviourOf(step.action?.type);

    const next = { ...state, executedStepId: step.id, phase: behaviour.waitsUrl ? "waiting_url" : "showing" };
    if (behaviour.waitsUrl) next.pending = TOUR.pendingFor(liveView(), index, SCHEMA);

    // Written BEFORE the click, and awaited. A click that navigates destroys this page;
    // a pending written afterwards would be a pending that never existed.
    if (!(await saveTour({ tour: next }))) return void renderStalled(index, "Không lưu được trạng thái bước.");

    try {
      target.element.click();
    } catch (err) {
      // A failed click must not advance the tour: the person would be shown the step
      // after one that never happened.
      return void renderStalled(index, `Không bấm được phần tử: ${err?.message ?? err}`);
    }

    if (!behaviour.waitsUrl) await goToLiveStep(index + 1);
  }

  /** The user pressed Tiếp on a step the runtime clicks for them. */
  async function advanceWithClick(step, index) {
    const behaviour = TOUR.behaviourOf(step.action?.type);
    const target = RESOLVE.resolveTarget(step, domApi());
    if (!TOUR.stepReadiness(step, target, gateApi()).ok) {
      return void renderStalled(index, "Không tìm thấy phần tử để bấm.");
    }

    const state = job.tour ?? {};
    const next = { ...state, executedStepId: step.id };
    if (behaviour.waitsUrl) next.pending = TOUR.pendingFor(liveView(), index, SCHEMA);
    if (!(await saveTour({ tour: next }))) return void renderStalled(index, "Không lưu được trạng thái bước.");

    try {
      target.element.click();
    } catch (err) {
      return void renderStalled(index, `Không bấm được phần tử: ${err?.message ?? err}`);
    }

    if (!behaviour.waitsUrl) await goToLiveStep(index + 1);
  }

  async function goToLiveStep(index) {
    if (index < 0) return;
    if (index >= liveSteps().length) return exitTour();
    const saved = await saveTour({
      index,
      tour: { phase: "showing", pending: null, navGuard: null, executedStepId: null },
    });
    if (!saved) return void disarm();
    render();
  }

  async function exitTour() {
    disarm();
    await send({ type: "tg:tour-exit" }).catch(() => {});
  }

  function onLiveAction(id) {
    if (!job || job.kind !== "live") return;
    const index = liveIndex();
    const step = liveSteps()[index];

    if (id === "exit") return void exitTour();
    if (id === "retry" || id === "wait") {
      stopObserver();
      return void render();
    }
    if (id === "prev") return void goToLiveStep(index - 1);

    // Tiếp: a step the runtime clicks needs the click to happen first.
    if (TOUR.behaviourOf(step?.action?.type).clicks) return void advanceWithClick(step, index);
    return void goToLiveStep(index + 1);
  }
})();
