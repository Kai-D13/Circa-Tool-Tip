/**
 * Everything the service worker DOES, with the Chrome APIs handed in.
 *
 * background.js used to hold this, and nothing could test it: importing it runs
 * `chrome.runtime.getManifest()` at module scope. Two of the three defects found in the
 * 2B.2B audit were in that file, which is the argument for this split — the wiring stays
 * in background.js, the decisions live here where fakes can drive them.
 *
 * Three parties talk to this hub and they are trusted differently:
 *   - the Portal, over an externally_connectable port. It says WHAT to record. It does
 *     not get to say what the browser opens (see START).
 *   - the content script, over runtime messages. It proves a tab and nothing else, so
 *     every write is re-checked against the tab the session is actually recording.
 *   - Chrome itself, when a tab goes away.
 */

import { ERROR_CODES, fail, isAllowedTargetUrl, ok } from "./protocol.js";

/**
 * @param {object} deps
 * @param {object} deps.store           createRecorderStore(...)
 * @param {{create(opts):Promise<{id:number}>, remove(tabId:number):Promise<any>, sendMessage(tabId:number, msg:object):Promise<any>}} deps.tabs
 * @param {string[]} deps.targetOrigins origins the extension may open and accept steps from
 * @param {{extVersion:string, schemaVersion:number|null}} deps.info
 * @param {{syncAll():Promise<object>, status():Promise<object>}|null} deps.sync
 */
export function createHub({ store, tabs, targetOrigins, info, sync = null }) {
  /**
   * sessionId -> the Portal port currently watching it.
   *
   * Deliberately NOT persisted: a port cannot survive a worker restart anyway, and a
   * stale entry would make the worker think the Portal is listening when it is not.
   */
  const ports = new Map();

  function pushToPortal(sessionId, message) {
    const port = ports.get(sessionId);
    if (!port) return;
    try {
      port.postMessage(message);
    } catch {
      // The Portal went away between the check and the send. The step is already in
      // storage, and the Portal's poll will pick it up.
      ports.delete(sessionId);
    }
  }

  /** Best effort: the tab may be gone, or may never have loaded the content script. */
  function pushToTab(tabId, message) {
    if (tabId === null || tabId === undefined) return;
    Promise.resolve(tabs.sendMessage(tabId, message)).catch(() => {});
  }

  async function handleOneShot({ type, payload }) {
    switch (type) {
      case "HELLO":
        return ok("HELLO", {
          extVersion: info.extVersion,
          protocolVersion: 1,
          schemaVersion: info.schemaVersion,
          // Everything this build can actually do. The Portal will gate features on
          // this list, so a capability missing here is a feature it will refuse to use.
          // `sync` drops out when the build carries no Supabase config — an honest
          // answer, rather than advertising something that would fail on first use.
          capabilities: ["record", "probe", "preview", ...(sync ? ["sync"] : [])],
        });

      case "GET_RECORDING": {
        const session = await store.get(payload.sessionId);
        if (!session) {
          return fail("GET_RECORDING", ERROR_CODES.NO_SESSION, "Phiên ghi không tồn tại hoặc đã bị xoá.");
        }
        return ok("GET_RECORDING", { session });
      }

      case "SYNC_NOW": {
        if (!sync) return notConfigured("SYNC_NOW");
        // syncAll() shares one pipeline, so a run already under way is joined rather
        // than duplicated — pressing Đồng bộ twice costs one download, not two.
        return ok("SYNC_NOW", await sync.syncAll());
      }

      case "GET_SYNC_STATUS": {
        if (!sync) return notConfigured("GET_SYNC_STATUS");
        return ok("GET_SYNC_STATUS", { sites: await sync.status() });
      }

      default:
        return fail(type, ERROR_CODES.UNKNOWN_TYPE, `Chưa xử lý "${type}".`);
    }
  }

  function notConfigured(type) {
    return fail(
      type,
      ERROR_CODES.NOT_CONFIGURED,
      "Bản build này không có cấu hình Supabase — build lại với SUPABASE_URL và SUPABASE_PUBLISHABLE_KEY.",
    );
  }

  /**
   * Give a job its own fresh tab and drop the one it had.
   *
   * Deliberately not "navigate the existing tab": setting the same URL again may or may
   * not reload, so a push to the content script would sometimes reach the old page and
   * answer about it. A new tab has exactly one meaning.
   */
  async function moveToFreshTab(session, url) {
    const previous = session.tabId;
    const tab = await tabs.create({ url, active: true });
    const attached = (await store.attachTab(session.id, tab.id)) ?? session;
    if (previous !== null && previous !== undefined && previous !== tab.id) {
      Promise.resolve(tabs.remove(previous)).catch(() => {});
    }
    return attached;
  }

  /** A step the resolver can actually work with. */
  function usableStep(step) {
    return !!step && typeof step === "object" && Array.isArray(step.selectors);
  }

  /**
   * Start a job, or take over the session already running under this id.
   *
   * Probing step after step reuses one session, so the operator ends up with one tab
   * rather than one tab per click.
   */
  async function openJob({ sessionId, guideId, site, url, kind, job }) {
    const existing = await store.get(sessionId);
    if (existing && existing.status === "recording") {
      return (await store.setJob(sessionId, job)) ?? existing;
    }
    return store.start({ id: sessionId, guideId, site, startUrl: url, kind, job });
  }

  async function handlePort({ type, payload }, port) {
    switch (type) {
      case "START": {
        const requested = payload.session ?? {};
        const url = String(requested.startUrl || "");

        // The Portal decides WHAT to record; it does not get to decide what the extension
        // opens. Only a page the content script runs on can be recorded anyway.
        if (!isAllowedTargetUrl(url, targetOrigins)) {
          port.postMessage(
            fail(
              "START",
              ERROR_CODES.BAD_URL,
              `URL "${url}" không thuộc site nào extension được phép mở (${targetOrigins.join(", ")}).`,
            ),
          );
          return;
        }

        // Reserve the id first, with no tab: if tab creation fails there is a session to
        // clean up rather than a half-created one nobody owns.
        const session = await store.start({ ...requested, tabId: null });
        ports.set(session.id, port);

        let tab;
        try {
          tab = await tabs.create({ url, active: true });
        } catch (err) {
          await store.discard(session.id);
          ports.delete(session.id);
          throw err;
        }

        const attached = await store.attachTab(session.id, tab.id);
        port.postMessage(ok("READY", { session: attached ?? session }));
        return;
      }

      case "UNDO": {
        const session = await store.undo(payload.sessionId);
        if (!session) {
          port.postMessage(fail("UNDO", ERROR_CODES.NO_SESSION, "Phiên ghi không còn hoạt động."));
          return;
        }
        port.postMessage(ok("UNDO", { session }));
        // The content script renders the step counter from its OWN copy of the session.
        // Undo happens entirely between the Portal and the worker, so without this push
        // the bar on POS keeps showing the step that was just removed until the next
        // click or a reload.
        pushToTab(session.tabId, { type: "tg:session", session });
        return;
      }

      case "STOP": {
        const session = await store.stop(payload.sessionId);
        if (!session) {
          port.postMessage(fail("STOP", ERROR_CODES.NO_SESSION, "Phiên ghi không tồn tại."));
          return;
        }
        // Stop intercepting clicks on the recorded tab before telling the Portal, so the
        // operator never gets a window where the page still swallows their clicks.
        pushToTab(session.tabId, { type: "tg:disarm" });
        port.postMessage(ok("DONE", { session, reason: "stopped" }));
        return;
      }

      case "PROBE_SELECTOR": {
        const url = String(payload.url || "");
        if (!isAllowedTargetUrl(url, targetOrigins)) {
          port.postMessage(fail("PROBE_SELECTOR", ERROR_CODES.BAD_URL, `URL "${url}" không thuộc site được phép.`));
          return;
        }
        if (!usableStep(payload.step)) {
          port.postMessage(
            fail("PROBE_SELECTOR", ERROR_CODES.BAD_STEP, "Thiếu bước, hoặc bước không có danh sách selector."),
          );
          return;
        }

        const session = await openJob({
          sessionId: payload.sessionId,
          guideId: payload.guideId,
          site: payload.site,
          url,
          kind: "probe",
          job: { kind: "probe", probeId: String(payload.probeId || ""), step: payload.step },
        });
        ports.set(session.id, port);
        // The answer does not come from here. The page has to load, resolve the selector
        // against the real DOM, and report back as tg:probe-result.
        await moveToFreshTab(session, url);
        return;
      }

      case "PREVIEW_GUIDE": {
        const url = String(payload.url || "");
        if (!isAllowedTargetUrl(url, targetOrigins)) {
          port.postMessage(fail("PREVIEW_GUIDE", ERROR_CODES.BAD_URL, `URL "${url}" không thuộc site được phép.`));
          return;
        }
        const steps = payload.guide && payload.guide.steps;
        if (!Array.isArray(steps) || !steps.length) {
          port.postMessage(fail("PREVIEW_GUIDE", ERROR_CODES.BAD_STEP, "Bộ này chưa có bước nào để chạy thử."));
          return;
        }

        const session = await openJob({
          sessionId: payload.sessionId,
          guideId: payload.guideId,
          site: payload.site,
          url,
          kind: "preview",
          // The DRAFT travels in this payload and is never read back from the database.
          // That is what makes it a preview: nothing has been saved, and nothing needs to
          // be. No release is touched either.
          job: { kind: "preview", guide: payload.guide, sites: payload.sites ?? {} },
        });
        ports.set(session.id, port);
        const attached = await moveToFreshTab(session, url);
        port.postMessage(ok("PREVIEW_READY", { session: attached }));
        return;
      }

      case "PREVIEW_STOP": {
        const session = await store.stop(payload.sessionId);
        if (!session) {
          port.postMessage(fail("PREVIEW_STOP", ERROR_CODES.NO_SESSION, "Phiên chạy thử không tồn tại."));
          return;
        }
        pushToTab(session.tabId, { type: "tg:disarm" });
        port.postMessage(ok("PREVIEW_DONE", { session, reason: "stopped" }));
        return;
      }

      default:
        port.postMessage(fail(type, ERROR_CODES.UNKNOWN_TYPE, `Chưa xử lý "${type}".`));
    }
  }

  async function handleContent(type, raw, tabId) {
    switch (type) {
      // A content script cannot know its own tab id; the worker is the only one who can
      // tell it. Every per-tab state key hangs off this value.
      case "tg:hello": {
        // findByTab throws DUPLICATE_TAB when the one-job-per-tab invariant broke. Report
        // it instead of handing the page an arbitrary session.
        const session = await store.findByTab(tabId);
        // One reply for all three kinds; the page branches on session.kind.
        return ok("tg:hello", { tabId, job: session });
      }

      case "tg:step": {
        const session = await store.appendStep(raw.sessionId, raw.step, tabId);
        if (!session) {
          return fail("tg:step", ERROR_CODES.NO_SESSION, "Phiên ghi đã dừng — bước này không được ghi.");
        }
        pushToPortal(session.id, ok("STEP", { session }));
        return ok("tg:step", { session });
      }

      case "tg:navigated": {
        const session = await store.findByTab(tabId);
        if (!session) return ok("tg:navigated", { ignored: true });
        pushToPortal(session.id, ok("NAVIGATED", { sessionId: session.id, url: String(raw.url || "") }));
        return ok("tg:navigated", { ignored: false });
      }

      case "tg:probe-result": {
        const session = await store.findByTab(tabId);
        if (!session || session.kind !== "probe") {
          return fail("tg:probe-result", ERROR_CODES.NO_SESSION, "Tab này không đang kiểm tra selector.");
        }
        // A result for an earlier question, arriving after the operator moved on, must not
        // overwrite the answer to the one they are looking at.
        const probeId = String(raw.probeId || "");
        if (probeId !== String((session.job && session.job.probeId) || "")) {
          return ok("tg:probe-result", { ignored: true });
        }
        pushToPortal(session.id, ok("PROBE_RESULT", { probeId, url: String(raw.url || ""), result: raw.result }));
        return ok("tg:probe-result", { ignored: false });
      }

      case "tg:preview-step": {
        const session = await store.findByTab(tabId);
        if (!session || session.kind !== "preview") {
          return fail("tg:preview-step", ERROR_CODES.NO_SESSION, "Tab này không đang chạy thử bộ nào.");
        }
        if (raw.exit) {
          const done = await store.stop(session.id);
          pushToPortal(session.id, ok("PREVIEW_DONE", { session: done, reason: "exited" }));
          return ok("tg:preview-step", { stopped: true });
        }
        const moved = await store.setIndex(session.id, raw.index, tabId);
        if (!moved) return fail("tg:preview-step", ERROR_CODES.NO_SESSION, "Phiên chạy thử đã kết thúc.");
        const total = (moved.job && moved.job.guide && moved.job.guide.steps.length) || 0;
        pushToPortal(session.id, ok("PREVIEW_STEP", { index: moved.index, total }));
        return ok("tg:preview-step", { index: moved.index });
      }

      default:
        return fail(type, ERROR_CODES.UNKNOWN_TYPE, `Chưa xử lý "${type}".`);
    }
  }

  /**
   * Closing the tab ends whatever was running in it.
   *
   * Without this the session stays active forever: it keeps holding a tab id that no
   * longer exists, the Portal waits for something that can never arrive, and the operator
   * has no way to tell what happened. Captured steps are kept — only the status changes.
   *
   * The event has to be reported in the vocabulary of the JOB, not of the recorder. A
   * preview that ends with `DONE` is a message the Portal's preview state never listens
   * for, so the panel sits on "Đang chạy thử" forever; a probe that ends with silence
   * leaves its button on "Đang kiểm tra…".
   */
  async function onTabRemoved(tabId) {
    const session = await store.findByTab(tabId).catch(() => null);
    if (!session) return;
    const done = await store.stop(session.id);

    if (session.kind === "preview") {
      pushToPortal(session.id, ok("PREVIEW_DONE", { session: done, reason: "tab-closed" }));
      return;
    }
    if (session.kind === "probe") {
      // The page never got to answer, and never will.
      pushToPortal(
        session.id,
        fail(
          "PROBE_RESULT",
          ERROR_CODES.TAB_CLOSED,
          "Tab kiểm tra bị đóng trước khi trang kịp trả lời.",
        ),
      );
      return;
    }
    pushToPortal(session.id, ok("DONE", { session: done, reason: "tab-closed" }));
  }

  /** A disconnected port must stop being treated as somewhere to send steps. */
  function releasePort(port) {
    for (const [sessionId, p] of ports) if (p === port) ports.delete(sessionId);
  }

  return { ports, handleOneShot, handlePort, handleContent, onTabRemoved, releasePort };
}
