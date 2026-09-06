/**
 * Portal <-> extension message contract.
 *
 * Every message carries a version and every reply has the same shape, so the Portal can
 * tell "extension not installed" from "extension refused" from "extension crashed"
 * without guessing from a thrown string.
 *
 *   request : { v: 1, type: "HELLO", payload?: {...} }
 *   success : { v: 1, ok: true,  type: "HELLO", data: {...} }
 *   failure : { v: 1, ok: false, type: "HELLO", error: { code, message } }
 *
 * Pure module: no chrome APIs, so it is unit-tested directly with `node --test`.
 */

export const PROTOCOL_VERSION = 1;

/** One-shot messages (chrome.runtime.sendMessage). */
export const ONE_SHOT_TYPES = ["HELLO", "GET_RECORDING"];

/** Messages carried over the long-lived `tg-recorder` port. */
export const PORT_NAME = "tg-recorder";
export const PORT_REQUEST_TYPES = ["START", "UNDO", "STOP"];
export const PORT_EVENT_TYPES = ["READY", "STEP", "NAVIGATED", "ERROR", "DONE"];

export const ERROR_CODES = {
  BAD_ENVELOPE: "BAD_ENVELOPE",
  VERSION_MISMATCH: "VERSION_MISMATCH",
  UNKNOWN_TYPE: "UNKNOWN_TYPE",
  FORBIDDEN_SENDER: "FORBIDDEN_SENDER",
  NO_SESSION: "NO_SESSION",
  SESSION_EXISTS: "SESSION_EXISTS",
  TAB_BUSY: "TAB_BUSY",
  DUPLICATE_TAB: "DUPLICATE_TAB",
  INTERNAL: "INTERNAL",
};

export function ok(type, data = {}) {
  return { v: PROTOCOL_VERSION, ok: true, type, data };
}

export function fail(type, code, message) {
  return { v: PROTOCOL_VERSION, ok: false, type, error: { code, message } };
}

/**
 * Validate an incoming envelope. Returns either the parsed request or a ready-made
 * failure response — callers never have to build an error shape themselves.
 */
export function parseRequest(raw, allowedTypes) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, response: fail("UNKNOWN", ERROR_CODES.BAD_ENVELOPE, "Message phải là object.") };
  }
  const type = typeof raw.type === "string" ? raw.type : "UNKNOWN";
  if (raw.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      response: fail(
        type,
        ERROR_CODES.VERSION_MISMATCH,
        `Phiên bản giao thức ${String(raw.v)} không khớp, extension dùng ${PROTOCOL_VERSION}.`,
      ),
    };
  }
  if (!allowedTypes.includes(type)) {
    return { ok: false, response: fail(type, ERROR_CODES.UNKNOWN_TYPE, `Không hiểu message "${type}".`) };
  }
  return { ok: true, type, payload: raw.payload ?? {} };
}

/** `externally_connectable` match patterns -> the origins they allow. */
export function originsFromMatches(matches) {
  const origins = [];
  for (const m of matches || []) {
    const cleaned = String(m).replace(/\/\*$/, "");
    if (/^https?:\/\/[^/*]+$/.test(cleaned) && !origins.includes(cleaned)) origins.push(cleaned);
  }
  return origins;
}

/**
 * True only for a real loopback origin.
 *
 * A prefix test is NOT enough: `"http://localhost.evil.example".startsWith("http://localhost")`
 * is true, so a prefix check hands an attacker-controlled domain the same trust as the
 * dev portal. The hostname has to be compared after parsing.
 */
export function isLoopbackOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:") return false;
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Defence in depth on top of `externally_connectable`.
 *
 * `sender.id` set means another EXTENSION is calling, not a web page — always refused.
 * Match patterns ignore the port, so a dev build's `http://localhost/*` also admits
 * `http://localhost:9999`; that is fine for dev and is deliberately never what a release
 * build relies on, because a release build has no loopback origin in its allow list.
 */
export function portalSenderOk(sender, allowedOrigins) {
  if (!sender || typeof sender !== "object") return false;
  if (sender.id) return false;
  if (!sender.tab) return false;
  const origin = typeof sender.origin === "string" ? sender.origin : "";
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  return isLoopbackOrigin(origin) && allowedOrigins.some(isLoopbackOrigin);
}
