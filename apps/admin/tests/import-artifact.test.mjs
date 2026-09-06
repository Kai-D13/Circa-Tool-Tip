import test from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, sha256Tagged } from "@circa/guide-schema";

import { ARTIFACT_TYPE, EXPECTED_LEGACY, checkArtifact } from "../lib/guides/import-artifact.ts";

const SMALL = { guides: 1, steps: 2 };

async function artifact(overrides = {}) {
  const content = {
    _type: ARTIFACT_TYPE,
    schemaVersion: 5,
    source: { sourceFileSha256: "a".repeat(64) },
    stats: { guides: 1, steps: 2 },
    guides: [{ legacyId: "x", name: "G", steps: [{ id: "s1" }, { id: "s2" }] }],
    ...overrides,
  };
  const contentChecksum = await sha256Tagged(canonicalJson(content));
  return { text: JSON.stringify({ ...content, contentChecksum }), content, contentChecksum };
}

test("a valid artifact passes and the recomputed checksum equals the embedded one", async () => {
  const { text, contentChecksum } = await artifact();
  const r = await checkArtifact(text, "a.json", SMALL);
  assert.equal(r.ok, true, r.errors.join(" | "));
  assert.equal(r.summary.computedChecksum, contentChecksum);
  assert.equal(r.summary.embeddedChecksum, contentChecksum);
  assert.equal(r.summary.guides, 1);
  assert.equal(r.summary.steps, 2);
});

test("editing content without updating the embedded checksum is detected", async () => {
  const { content, contentChecksum } = await artifact();
  const tampered = { ...content, guides: [{ ...content.guides[0], name: "SUA ROI" }], contentChecksum };
  const r = await checkArtifact(JSON.stringify(tampered), "a.json", SMALL);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("Checksum tính lại")));
});

test("the checksum sent to the RPC is the recomputed one, which differs from a stale embedded value", async () => {
  const { content } = await artifact();
  const stale = { ...content, contentChecksum: "sha256:" + "f".repeat(64) };
  const r = await checkArtifact(JSON.stringify(stale), "a.json", SMALL);
  assert.equal(r.ok, false);
  assert.notEqual(r.summary.computedChecksum, r.summary.embeddedChecksum);
});

test("the wrong schema version is rejected", async () => {
  const { text } = await artifact({ schemaVersion: 4 });
  const r = await checkArtifact(text, "a.json", SMALL);
  assert.ok(r.errors.some((e) => e.includes("schemaVersion")));
});

test("the wrong _type is rejected", async () => {
  const { text } = await artifact({ _type: "tooltip-guide-config" });
  const r = await checkArtifact(text, "a.json", SMALL);
  assert.ok(r.errors.some((e) => e.includes("_type")));
});

test("stats that disagree with the actual arrays are rejected", async () => {
  const { text } = await artifact({ stats: { guides: 9, steps: 9 } });
  const r = await checkArtifact(text, "a.json", SMALL);
  assert.ok(r.errors.some((e) => e.includes("stats khai")));
});

test("the production migration expects exactly 48/409 by default", async () => {
  const { text } = await artifact();
  const r = await checkArtifact(text, "a.json");
  assert.equal(EXPECTED_LEGACY.guides, 48);
  assert.equal(EXPECTED_LEGACY.steps, 409);
  assert.ok(r.errors.some((e) => e.includes("cần đúng 48/409")));
});

test("invalid JSON is reported, not thrown", async () => {
  const r = await checkArtifact("{not json", "a.json", SMALL);
  assert.equal(r.ok, false);
  assert.equal(r.payload, null);
});

test("a JSON array at the root is rejected", async () => {
  const r = await checkArtifact("[]", "a.json", SMALL);
  assert.equal(r.ok, false);
});
