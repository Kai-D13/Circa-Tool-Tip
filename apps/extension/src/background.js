/**
 * Service worker: the only place that talks to Chrome APIs.
 *
 * Everything with logic in it lives in protocol.js / session.js so it can be unit-tested
 * without a browser; this file is deliberately thin wiring.
 *
 * Scope for Batch 2B.2A: handshake, recorder session plumbing and the long-lived port.
 * Element picking is 2B.2B; the guide menu and the 15-minute sync are Batch 3.
 */

import "./vendor/guide-schema.global.js";
import {
  ERROR_CODES,
  ONE_SHOT_TYPES,
  PORT_NAME,
  PORT_REQUEST_TYPES,
  fail,
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

const EXT_VERSION = chrome.runtime.getManifest().version;
/** Single source of truth: whatever the manifest allows, nothing else. */
const ALLOWED_PORTAL_ORIGINS = originsFromMatches(
  chrome.runtime.getManifest().externally_connectable?.matches ?? [],
);

const store = createRecorderStore({
  get: (keys) => chrome.storage.session.get(keys),
  set: (items) => chrome.storage.session.set(items),
  remove: (keys) => chrome.storage.session.remove(keys),
});

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
});

async function handlePort({ type, payload }, port) {
  switch (type) {
    case "START": {
      const session = await store.start(payload.session ?? {});
      port.postMessage(ok("READY", { session }));
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
      port.postMessage(
        session
          ? ok("DONE", { session })
          : fail("STOP", ERROR_CODES.NO_SESSION, "Phiên ghi không tồn tại."),
      );
      return;
    }

    default:
      port.postMessage(fail(type, ERROR_CODES.UNKNOWN_TYPE, `Chưa xử lý "${type}".`));
  }
}

/* --------------------------------------------------- content script <-> background */

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  // A content script cannot know its own tab id; the worker is the only one who can
  // tell it. Every per-tab state key hangs off this value.
  if (raw?.type === "tg:hello") {
    const tabId = sender?.tab?.id ?? null;
    store
      .findByTab(tabId)
      .then((session) => sendResponse(ok("tg:hello", { tabId, recording: session })))
      .catch((err) => {
        // DUPLICATE_TAB means the one-recorder-per-tab invariant broke. Say so instead
        // of handing the page an arbitrary session.
        console.error("[tooltip] findByTab thất bại:", err);
        sendResponse(fail("tg:hello", errorCodeOf(err), String(err?.message ?? err)));
      });
    return true;
  }
  return false;
});
