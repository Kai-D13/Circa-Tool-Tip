import test from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, sha256Hex, sha256Tagged } from "../src/checksum.ts";

test("sha256 matches the published vectors", async () => {
  assert.equal(await sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("sha256Tagged names its algorithm", async () => {
  assert.match(await sha256Tagged("abc"), /^sha256:[0-9a-f]{64}$/);
});

test("canonical JSON is insensitive to key order", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});

test("canonical JSON preserves array order", () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("canonical JSON sorts nested keys too", () => {
  assert.equal(canonicalJson({ x: { z: 1, y: 2 } }), '{"x":{"y":2,"z":1}}');
});

test("undefined is dropped rather than serialised inconsistently", () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test("unicode survives the round trip", () => {
  const s = canonicalJson({ name: "BAN HANG TAI QUAY", vi: "Đơn hàng" });
  assert.equal(JSON.parse(s).vi, "Đơn hàng");
});

test("the artifact content checksum ignores key order but not content", async () => {
  // What the legacy importer relies on: the same content, serialised in a different key
  // order, must hash the same; a real change must not.
  const a = await sha256Tagged(canonicalJson({ guides: [{ name: "A", site: "pos" }], stats: { steps: 1 } }));
  const b = await sha256Tagged(canonicalJson({ stats: { steps: 1 }, guides: [{ site: "pos", name: "A" }] }));
  const c = await sha256Tagged(canonicalJson({ guides: [{ name: "B", site: "pos" }], stats: { steps: 1 } }));
  assert.equal(a, b);
  assert.notEqual(a, c);
});
