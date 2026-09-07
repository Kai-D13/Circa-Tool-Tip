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
 * @param {{create(opts):Promise<{id:number}>, sendMessage(tabId:number, msg:object):Promise<any>}} deps.tabs
 * @param {string[]} deps.targetOrigins origins the extension may open and accept steps from
 * @param {{extVersion:string, schemaVersion:number|null}} deps.info
 */
export function createHub({ store, tabs, targetOrigins, info }) {
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
          capabilities: ["record"],
        });

      case "GET_RECORDING": {
        const session = await store.get(payload.sessionId);
        if (!session) {
          return fail("GET_RECORDING", ERROR_CODES.NO_SESSION, "Phiên ghi không tồn tại hoặc đã bị xoá.");
        }
        return ok("GET_RECORDING", { session });
      }

      default:
        return fail(type, ERROR_CODES.UNKNOWN_TYPE, `Chưa xử lý "${type}".`);
    }
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

      default:
        port.postMessage(fail(type, ERROR_CODES.UNKNOWN_TYPE, `Chưa xử lý "${type}".`));
    }
  }

  async function handleContent(type, raw, tabId) {
    switch (type) {
      // A content script cannot know its own tab id; the worker is the only one who can
      // tell it. Every per-tab state key hangs off this value.
      case "tg:hello": {
        // findByTab throws DUPLICATE_TAB when the one-recorder-per-tab invariant broke.
        // Report it instead of handing the page an arbitrary session.
        const session = await store.findByTab(tabId);
        return ok("tg:hello", { tabId, recording: session });
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

      default:
        return fail(type, ERROR_CODES.UNKNOWN_TYPE, `Chưa xử lý "${type}".`);
    }
  }

  /**
   * Closing the recorded tab ends the recording.
   *
   * Without this the session stays `recording` forever: it keeps holding a tab id that no
   * longer exists, the Portal waits for steps that can never arrive, and the operator has
   * no way to tell what happened. The captured steps are kept — only the status changes.
   */
  async function onTabRemoved(tabId) {
    const session = await store.findByTab(tabId).catch(() => null);
    if (!session) return;
    const done = await store.stop(session.id);
    pushToPortal(session.id, ok("DONE", { session: done, reason: "tab-closed" }));
  }

  /** A disconnected port must stop being treated as somewhere to send steps. */
  function releasePort(port) {
    for (const [sessionId, p] of ports) if (p === port) ports.delete(sessionId);
  }

  return { ports, handleOneShot, handlePort, handleContent, onTabRemoved, releasePort };
}
