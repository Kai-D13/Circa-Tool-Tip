import test from "node:test";
import assert from "node:assert/strict";

import {
  ERROR_CODES,
  ONE_SHOT_TYPES,
  PORT_REQUEST_TYPES,
  PROTOCOL_VERSION,
  CONTENT_COMMANDS,
  CONTENT_TYPES,
  fail,
  isAllowedTargetUrl,
  isLoopbackOrigin,
  ok,
  originsFromMatches,
  parseRequest,
  portalSenderOk,
} from "../src/protocol.js";

const sender = (over = {}) => ({ origin: "http://localhost:3000", tab: { id: 7 }, ...over });

test("every reply carries the version and a stable ok flag", () => {
  assert.deepEqual(ok("HELLO", { a: 1 }), { v: PROTOCOL_VERSION, ok: true, type: "HELLO", data: { a: 1 } });
  assert.deepEqual(fail("HELLO", ERROR_CODES.INTERNAL, "x"), {
    v: PROTOCOL_VERSION, ok: false, type: "HELLO", error: { code: ERROR_CODES.INTERNAL, message: "x" },
  });
});

test("a valid request parses and keeps its payload", () => {
  const r = parseRequest({ v: 1, type: "GET_RECORDING", payload: { sessionId: "s1" } }, ONE_SHOT_TYPES);
  assert.equal(r.ok, true);
  assert.equal(r.type, "GET_RECORDING");
  assert.deepEqual(r.payload, { sessionId: "s1" });
});

test("a request with no payload still parses, with an empty payload", () => {
  const r = parseRequest({ v: 1, type: "HELLO" }, ONE_SHOT_TYPES);
  assert.deepEqual(r.payload, {});
});

test("a wrong protocol version is refused with a distinguishable code", () => {
  const r = parseRequest({ v: 2, type: "HELLO" }, ONE_SHOT_TYPES);
  assert.equal(r.ok, false);
  assert.equal(r.response.error.code, ERROR_CODES.VERSION_MISMATCH);
  assert.equal(r.response.type, "HELLO", "vẫn giữ type để Portal biết cái gì hỏng");
});

test("garbage is refused rather than thrown", () => {
  for (const bad of [null, undefined, "hello", 42, []]) {
    const r = parseRequest(bad, ONE_SHOT_TYPES);
    assert.equal(r.ok, false);
    assert.equal(r.response.error.code, ERROR_CODES.BAD_ENVELOPE);
  }
});

test("an unknown type is refused, and port types are not accepted as one-shot", () => {
  assert.equal(parseRequest({ v: 1, type: "NUKE" }, ONE_SHOT_TYPES).response.error.code, ERROR_CODES.UNKNOWN_TYPE);
  // START only makes sense on the port; sending it as a one-shot must not work.
  assert.equal(parseRequest({ v: 1, type: "START" }, ONE_SHOT_TYPES).response.error.code, ERROR_CODES.UNKNOWN_TYPE);
  assert.equal(parseRequest({ v: 1, type: "START" }, PORT_REQUEST_TYPES).ok, true);
});

/* ------------------------------------------------------------------ sender check */

test("match patterns become the origins they allow", () => {
  assert.deepEqual(originsFromMatches(["http://localhost/*"]), ["http://localhost"]);
  assert.deepEqual(originsFromMatches(["https://circa-tool-tip.vercel.app/*"]), ["https://circa-tool-tip.vercel.app"]);
  assert.deepEqual(originsFromMatches(["https://*.vercel.app/*"]), [], "wildcard subdomain không tạo origin cụ thể");
});

test("a dev build accepts localhost on any port", () => {
  const allowed = originsFromMatches(["http://localhost/*"]);
  assert.equal(portalSenderOk(sender(), allowed), true);
  assert.equal(portalSenderOk(sender({ origin: "http://localhost:5173" }), allowed), true);
});

test("another extension is refused even from an allowed origin", () => {
  // sender.id set means the caller is an extension, not a page.
  const allowed = originsFromMatches(["http://localhost/*"]);
  assert.equal(portalSenderOk(sender({ id: "abcdefghijklmnop" }), allowed), false);
});

test("a message with no tab is refused", () => {
  const allowed = originsFromMatches(["http://localhost/*"]);
  assert.equal(portalSenderOk(sender({ tab: undefined }), allowed), false);
});

test("REGRESSION: a hostname that merely starts with localhost is not loopback", () => {
  // `"http://localhost.evil.example".startsWith("http://localhost")` is true, so a prefix
  // check would hand an attacker-controlled domain the dev portal's trust.
  assert.equal(isLoopbackOrigin("http://localhost"), true);
  assert.equal(isLoopbackOrigin("http://localhost:3000"), true);
  assert.equal(isLoopbackOrigin("http://127.0.0.1:3000"), true);

  assert.equal(isLoopbackOrigin("http://localhost.evil.example"), false);
  assert.equal(isLoopbackOrigin("http://localhost-evil.example"), false);
  assert.equal(isLoopbackOrigin("http://evil.example/?x=http://localhost"), false);
  assert.equal(isLoopbackOrigin("https://localhost"), false, "https không phải origin dev của ta");
  assert.equal(isLoopbackOrigin("không phải url"), false);
});

test("a foreign origin cannot drive a dev build", () => {
  const allowed = originsFromMatches(["http://localhost/*"]);
  for (const origin of ["https://evil.example", "http://localhost.evil.example", "https://pos.v2.circa.vn", ""]) {
    assert.equal(portalSenderOk(sender({ origin }), allowed), false, `${origin} phải bị từ chối`);
  }
});

test("a release build does not accept localhost", () => {
  const allowed = originsFromMatches(["https://circa-tool-tip.vercel.app/*"]);
  assert.equal(portalSenderOk(sender({ origin: "http://localhost:3000" }), allowed), false);
  assert.equal(portalSenderOk(sender({ origin: "https://circa-tool-tip.vercel.app" }), allowed), true);
});

test("garbage senders are refused rather than thrown", () => {
  for (const bad of [null, undefined, "x", 1]) assert.equal(portalSenderOk(bad, ["http://localhost"]), false);
});

/* ---------------------------------------------- 2B.2B: mở tab để ghi hướng dẫn */

const TARGETS = originsFromMatches(["https://pos.v2.circa.vn/*", "https://admin.v2.circa.vn/*"]);

test("the extension only opens a page it actually runs on", () => {
  assert.equal(isAllowedTargetUrl("https://pos.v2.circa.vn/trang-chu", TARGETS), true);
  assert.equal(isAllowedTargetUrl("https://admin.v2.circa.vn/dashboard?a=1#b", TARGETS), true);
});

test("START cannot turn the extension into an open redirector", () => {
  // The Portal is trusted to say WHAT to record. It is not trusted to say what the
  // browser opens: that is a bigger power than the recorder needs.
  for (const bad of [
    "https://pos.v2.circa.vn.evil.example/",   // suffix, not the origin
    "https://evil.example/?x=https://pos.v2.circa.vn",
    "http://pos.v2.circa.vn/trang-chu",        // plaintext
    "javascript:alert(1)",
    "data:text/html,<h1>x",
    "chrome://settings",
    "file:///C:/Windows/System32",
    "",
    null,
    undefined,
    "khong-phai-url",
  ]) {
    assert.equal(isAllowedTargetUrl(bad, TARGETS), false, `${String(bad)} phải bị từ chối`);
  }
});

test("an empty allow list opens nothing", () => {
  assert.equal(isAllowedTargetUrl("https://pos.v2.circa.vn/", []), false);
  assert.equal(isAllowedTargetUrl("https://pos.v2.circa.vn/", undefined), false);
});

test("content-script messages are a separate namespace from the Portal's", () => {
  // They are authorised differently — by tab, not by origin — so mixing the two lists
  // would let a page reach a handler that assumes it is talking to a content script.
  for (const t of CONTENT_TYPES) assert.ok(!ONE_SHOT_TYPES.includes(t), `${t} không được là message của Portal`);
  for (const t of CONTENT_TYPES) assert.ok(t.startsWith("tg:"), `${t} phải mang tiền tố tg:`);
  for (const c of CONTENT_COMMANDS) assert.ok(c.startsWith("tg:"));
});

test("every session-store failure has a protocol code to report it with", () => {
  // background.js maps a SessionError code straight onto the wire; a code the protocol
  // does not know silently degrades to INTERNAL and the Portal cannot react to it.
  for (const code of ["INVALID_SESSION", "SESSION_EXISTS", "TAB_BUSY", "DUPLICATE_TAB", "TAB_MISMATCH"]) {
    assert.equal(ERROR_CODES[code], code, `thiếu mã ${code}`);
  }
});

/* --------------------------------------------------- 3A: message đồng bộ release */

test("đồng bộ là message một chiều của Portal, không phải message của trang", () => {
  for (const type of ["SYNC_NOW", "GET_SYNC_STATUS"]) {
    assert.ok(ONE_SHOT_TYPES.includes(type), `thiếu ${type}`);
    assert.ok(!CONTENT_TYPES.includes(type), `${type} không được để trang POS gọi`);
  }
});

test("có mã riêng cho build thiếu cấu hình Supabase", () => {
  // Khác hẳn INTERNAL: đây không phải lỗi chạy, mà là bản build không thể đồng bộ. Portal
  // cần phân biệt để nói "build lại" thay vì "thử lại".
  assert.equal(ERROR_CODES.NOT_CONFIGURED, "NOT_CONFIGURED");
});
