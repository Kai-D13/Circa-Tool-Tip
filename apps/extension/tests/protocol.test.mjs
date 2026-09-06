import test from "node:test";
import assert from "node:assert/strict";

import {
  ERROR_CODES,
  ONE_SHOT_TYPES,
  PORT_REQUEST_TYPES,
  PROTOCOL_VERSION,
  fail,
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
