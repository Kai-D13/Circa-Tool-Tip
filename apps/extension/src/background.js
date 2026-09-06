/**
 * Service worker: the only place that talks to Chrome APIs.
 *
 * Everything with logic in it lives in protocol.js / session.js / selector.js so it can
 * be unit-tested without a browser; this file is deliberately thin wiring.
 *
 * Scope through Batch 2B.2B: handshake, recorder session plumbing, the long-lived port,
 * opening the tab being recorded, and relaying captured steps back to the Portal. The
 * Tool-tip menu, the 15-minute sync and the tour runtime are Batch 3.
 *
 * Two things this file is careful about, because both are silent when they go wrong:
 *   - the Portal's port can die at any moment (worker eviction, Portal reload) while the
 *     recording keeps going. Storage is the source of truth; the port is only a fast
 *     path, and the Portal falls back to polling GET_RECORDING.
 *   - a content script message proves which TAB it came from and nothing else, so every
 *     write is checked against the tab the session is actually recording.
 */

import "./vendor/guide-schema.global.js";
import {
  ERROR_CODES,
  ONE_SHOT_TYPES,
  PORT_NAME,
  PORT_REQUEST_TYPES,
  fail,
  isAllowedTargetUrl,
  ok,
  originsFromMatches,
  parseRequest,
  portalSenderOk,
} from "./protocol.js";
import { createRecorderStore } from "./session.js";

/** A SessionError carries a code the protocol already knows; anything else is INTERNAL. */
function errorCodeOf(err) {
  const code = err?.code;
  return code && Object.values(ERROR_CODES).includes(code) ? code : ERROR_CODES.INTERNAL;
}

const MANIFEST = chrome.runtime.getManifest();
const EXT_VERSION = MANIFEST.version;
/** Single source of truth: whatever the manifest allows, nothing else. */
const ALLOWED_PORTAL_ORIGINS = originsFromMatches(MANIFEST.externally_connectable?.matches ?? []);
/** The pages the extension may open and accept recorded steps from. */
const TARGET_ORIGINS = originsFromMatches(MANIFEST.host_permissions ?? []);

const store = createRecorderStore({
  get: (keys) => chrome.storage.session.get(keys),
  set: (items) => chrome.storage.session.set(items),
  remove: (keys) => chrome.storage.session.remove(keys),
});

/**
 * sessionId -> the Portal port currently watching it.
 *
 * Deliberately NOT persisted: a port cannot survive a worker restart anyway, and a stale
 * entry would make the worker think the Portal is listening when it is not.
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

/**
 * Content scripts cannot read chrome.storage.session unless the worker opens it up.
 * Miss this and every session read returns undefined with no error at all — the failure
 * mode is silence, so it runs on BOTH lifecycle events rather than just onInstalled.
 */
async function openSessionStorageToContentScripts() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
  } catch (err) {
    console.error("[tooltip] setAccessLevel thất bại — content script sẽ không đọc được session:", err);
  }
}

chrome.runtime.onInstalled.addListener(() => void openSessionStorageToContentScripts());
chrome.runtime.onStartup.addListener(() => void openSessionStorageToContentScripts());

/** Tell a recorded tab to stop intercepting clicks. Best effort: the tab may be gone. */
function disarmTab(tabId) {
  if (tabId === null || tabId === undefined) return;
  chrome.tabs.sendMessage(tabId, { type: "tg:disarm" }).catch(() => {});
}

/* -------------------------------------------------------------- one-shot messages */

chrome.runtime.onMessageExternal.addListener((raw, sender, sendResponse) => {
  if (!portalSenderOk(sender, ALLOWED_PORTAL_ORIGINS)) {
    sendResponse(fail("UNKNOWN", ERROR_CODES.FORBIDDEN_SENDER, "Origin không được phép gọi extension."));
    return false;
  }

  const parsed = parseRequest(raw, ONE_SHOT_TYPES);
  if (!parsed.ok) {
    sendResponse(parsed.response);
    return false;
  }

  handleOneShot(parsed)
    .then(sendResponse)
    .catch((err) => sendResponse(fail(parsed.type, errorCodeOf(err), String(err?.message ?? err))));
  return true; // async response
});

async function handleOneShot({ type, payload }) {
  switch (type) {
    case "HELLO":
      return ok("HELLO", {
        extVersion: EXT_VERSION,
        protocolVersion: 1,
        schemaVersion: globalThis.GUIDE_SCHEMA?.SCHEMA_VERSION ?? null,
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

/* ------------------------------------------------------------------- recorder port */

chrome.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== PORT_NAME) {
    port.disconnect();
    return;
  }
  if (!portalSenderOk(port.sender, ALLOWED_PORTAL_ORIGINS)) {
    port.postMessage(fail("ERROR", ERROR_CODES.FORBIDDEN_SENDER, "Origin không được phép mở port."));
    port.disconnect();
    return;
  }

  port.onMessage.addListener((raw) => {
    const parsed = parseRequest(raw, PORT_REQUEST_TYPES);
    if (!parsed.ok) {
      port.postMessage(parsed.response);
      return;
    }
    handlePort(parsed, port).catch((err) =>
      port.postMessage(fail(parsed.type, errorCodeOf(err), String(err?.message ?? err))),
    );
  });

  port.onDisconnect.addListener(() => {
    for (const [sessionId, p] of ports) if (p === port) ports.delete(sessionId);
  });
});

async function handlePort({ type, payload }, port) {
  switch (type) {
    case "START": {
      const requested = payload.session ?? {};
      const url = String(requested.startUrl || "");

      // The Portal decides WHAT to record; it does not get to decide what the extension
      // opens. Only a page the content script runs on can be recorded anyway.
      if (!isAllowedTargetUrl(url, TARGET_ORIGINS)) {
        port.postMessage(
          fail(
            "START",
            ERROR_CODES.BAD_URL,
            `URL "${url}" không thuộc site nào extension được phép mở (${TARGET_ORIGINS.join(", ")}).`,
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
        tab = await chrome.tabs.create({ url, active: true });
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
      port.postMessage(
        session
          ? ok("UNDO", { session })
          : fail("UNDO", ERROR_CODES.NO_SESSION, "Phiên ghi không còn hoạt động."),
      );
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
      disarmTab(session.tabId);
      port.postMessage(ok("DONE", { session, reason: "stopped" }));
      return;
    }

    default:
      port.postMessage(fail(type, ERROR_CODES.UNKNOWN_TYPE, `Chưa xử lý "${type}".`));
  }
}

/* --------------------------------------------------- content script <-> background */

/**
 * A content script message proves the tab it came from, and nothing more. Anything on
 * pos/admin runs this script, including pages nobody is recording — so the origin is
 * checked here and the TAB is checked again inside the session store.
 */
function contentSenderTabId(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return null;
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") return null;
  const origin = sender.origin || (sender.url ? new URL(sender.url).origin : "");
  return TARGET_ORIGINS.includes(origin) ? tabId : null;
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const type = raw?.type;
  if (typeof type !== "string" || !type.startsWith("tg:")) return false;

  const tabId = contentSenderTabId(sender);
  if (tabId === null) {
    sendResponse(fail(type, ERROR_CODES.FORBIDDEN_SENDER, "Message không đến từ tab được phép."));
    return false;
  }

  handleContent(type, raw, tabId)
    .then(sendResponse)
    .catch((err) => sendResponse(fail(type, errorCodeOf(err), String(err?.message ?? err))));
  return true; // async response
});

async function handleContent(type, raw, tabId) {
  switch (type) {
    // A content script cannot know its own tab id; the worker is the only one who can
    // tell it. Every per-tab state key hangs off this value.
    case "tg:hello": {
      // DUPLICATE_TAB means the one-recorder-per-tab invariant broke. Report it instead
      // of handing the page an arbitrary session.
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
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const session = await store.findByTab(tabId).catch(() => null);
    if (!session) return;
    const done = await store.stop(session.id);
    pushToPortal(session.id, ok("DONE", { session: done, reason: "tab-closed" }));
  })();
});
