/**
 * Service worker: the only place that talks to Chrome APIs.
 *
 * Nothing here decides anything. Every decision lives in hub.js / protocol.js /
 * session.js, where a test can drive it without a browser — this file is the wiring that
 * connects Chrome's events to those, and the authorisation checks that can only be made
 * against a real `sender`.
 */

import "./vendor/guide-schema.global.js";
// Classic scripts, imported for their side effect exactly like the schema bundle. The
// worker needs the SAME decision table the page uses: it is what decides whether a tour
// has arrived where it was heading, and a second copy here would be a second answer.
import "./resolve.js";
import "./tour.js";
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
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";
import { createHub } from "./hub.js";
import { createRecorderStore } from "./session.js";
import { createApi } from "./supabase.js";
import { createSync } from "./sync.js";

const MANIFEST = chrome.runtime.getManifest();
/** Single source of truth: whatever the manifest allows, nothing else. */
const ALLOWED_PORTAL_ORIGINS = originsFromMatches(MANIFEST.externally_connectable?.matches ?? []);
/**
 * The pages the extension may open and accept recorded steps from.
 *
 * Derived from `content_scripts`, NOT from `host_permissions`. Those two lists stopped
 * being the same thing when Supabase was added: the extension needs permission to FETCH
 * from the API host, but the API host is not a page anyone records on, previews, or opens
 * a tab to. Reading this from host_permissions would have quietly made it one.
 */
const TARGET_ORIGINS = originsFromMatches((MANIFEST.content_scripts ?? []).flatMap((cs) => cs.matches ?? []));

const store = createRecorderStore({
  get: (keys) => chrome.storage.session.get(keys),
  set: (items) => chrome.storage.session.set(items),
  remove: (keys) => chrome.storage.session.remove(keys),
});

/**
 * Release cache lives in `chrome.storage.local`, not `session`.
 *
 * Session storage is cleared when the browser closes and on every extension update. Using
 * it here would mean every machine starts each morning, and every update, with no guides
 * at all until a sync finished.
 */
const sync = buildSync();

function buildSync() {
  try {
    return createSync({
      storage: {
        get: (keys) => chrome.storage.local.get(keys),
        set: (items) => chrome.storage.local.set(items),
      },
      api: createApi({ url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY }),
      schema: globalThis.GUIDE_SCHEMA,
    });
  } catch (err) {
    // A build with no config must say so when asked, not crash the worker on load and
    // take the recorder down with it.
    console.error("[tooltip] không cấu hình được đồng bộ release:", err);
    return null;
  }
}

const SYNC_ALARM = "tg-sync";
/**
 * Chrome treats this as a floor, not a promise — a throttled or sleeping browser fires
 * later, sometimes much later. The UI says "khoảng mỗi 15 phút" for that reason, and
 * nothing is allowed to depend on the exact interval.
 */
const SYNC_PERIOD_MINUTES = 15;

/**
 * Alarms do not survive every worker lifecycle event reliably, so this runs on both
 * install and startup and only creates one when it is genuinely missing — re-creating it
 * would reset the period and could starve a machine that is rarely restarted.
 */
async function ensureSyncAlarm() {
  try {
    const existing = await chrome.alarms.get(SYNC_ALARM);
    if (!existing) await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
  } catch (err) {
    console.error("[tooltip] không tạo được alarm đồng bộ:", err);
  }
}

function runSync(reason) {
  if (!sync) return;
  void sync
    .syncAll()
    .then((result) => console.debug(`[tooltip] đồng bộ (${reason}):`, result))
    .catch((err) => console.error(`[tooltip] đồng bộ (${reason}) lỗi:`, err));
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) runSync("alarm");
});

const hub = createHub({
  store,
  sync,
  schema: globalThis.GUIDE_SCHEMA,
  tour: globalThis.TG_TOUR,
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

function onLifecycle(reason) {
  void openSessionStorageToContentScripts();
  void ensureSyncAlarm();
  runSync(reason);
}

chrome.runtime.onInstalled.addListener(() => onLifecycle("installed"));
chrome.runtime.onStartup.addListener(() => onLifecycle("startup"));

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
