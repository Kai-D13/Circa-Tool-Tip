/**
 * Service worker: the only place that talks to Chrome APIs.
 *
 * Nothing here decides anything. Every decision lives in hub.js / protocol.js /
 * session.js, where a test can drive it without a browser — this file is the wiring that
 * connects Chrome's events to those, and the authorisation checks that can only be made
 * against a real `sender`.
 */

import "./vendor/guide-schema.global.js";
import {
  ERROR_CODES,
  ONE_SHOT_TYPES,
  PORT_NAME,
  PORT_REQUEST_TYPES,
  errorCodeOf,
  fail,
  originsFromMatches,
  parseRequest,
  portalSenderOk,
} from "./protocol.js";
import { createHub } from "./hub.js";
import { createRecorderStore } from "./session.js";

const MANIFEST = chrome.runtime.getManifest();
/** Single source of truth: whatever the manifest allows, nothing else. */
const ALLOWED_PORTAL_ORIGINS = originsFromMatches(MANIFEST.externally_connectable?.matches ?? []);
/** The pages the extension may open and accept recorded steps from. */
const TARGET_ORIGINS = originsFromMatches(MANIFEST.host_permissions ?? []);

const store = createRecorderStore({
  get: (keys) => chrome.storage.session.get(keys),
  set: (items) => chrome.storage.session.set(items),
  remove: (keys) => chrome.storage.session.remove(keys),
});

const hub = createHub({
  store,
  tabs: {
    create: (options) => chrome.tabs.create(options),
    remove: (tabId) => chrome.tabs.remove(tabId),
    sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  },
  targetOrigins: TARGET_ORIGINS,
  info: {
    extVersion: MANIFEST.version,
    schemaVersion: globalThis.GUIDE_SCHEMA?.SCHEMA_VERSION ?? null,
  },
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

  hub
    .handleOneShot(parsed)
    .then(sendResponse)
    .catch((err) => sendResponse(fail(parsed.type, errorCodeOf(err), String(err?.message ?? err))));
  return true; // async response
});

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
    hub
      .handlePort(parsed, port)
      .catch((err) => port.postMessage(fail(parsed.type, errorCodeOf(err), String(err?.message ?? err))));
  });

  port.onDisconnect.addListener(() => hub.releasePort(port));
});

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

  hub
    .handleContent(type, raw, tabId)
    .then(sendResponse)
    .catch((err) => sendResponse(fail(type, errorCodeOf(err), String(err?.message ?? err))));
  return true; // async response
});

chrome.tabs.onRemoved.addListener((tabId) => void hub.onTabRemoved(tabId));
