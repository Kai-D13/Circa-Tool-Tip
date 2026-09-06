import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Tagged } from "@circa/guide-schema";

import { ARTIFACT_TYPE, EXPECTED_LEGACY, checkArtifact } from "../lib/guides/import-artifact.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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

test("an unrecognised _type is rejected", async () => {
  // The legacy v4 envelope has its own dedicated message; this covers everything else.
  const { text } = await artifact({ _type: "some-other-tool" });
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

test("a missing schemaVersion yields null, never NaN", async () => {
  const { text } = await artifact();
  const without = JSON.parse(text);
  delete without.schemaVersion;
  const r = await checkArtifact(JSON.stringify(without), "a.json", SMALL);
  assert.equal(r.summary.schemaVersion, null);
  assert.ok(!Number.isNaN(r.summary.schemaVersion), "không được là NaN");
  assert.ok(r.errors.some((e) => e.includes("Thiếu schemaVersion")));
});

test("a string schemaVersion is rejected rather than coerced", async () => {
  const { text } = await artifact({ schemaVersion: "5" });
  const r = await checkArtifact(text, "a.json", SMALL);
  assert.equal(r.summary.schemaVersion, null);
  assert.ok(r.errors.some((e) => e.includes("phải là số nguyên")));
});

test("a non-integer schemaVersion is rejected", async () => {
  const { text } = await artifact({ schemaVersion: 5.5 });
  const r = await checkArtifact(text, "a.json", SMALL);
  assert.equal(r.summary.schemaVersion, null);
});

test("the legacy v4 export gets one clear instruction, not a wall of derived errors", async () => {
  const legacy = {
    _type: "tooltip-guide-config",
    _version: 4,
    exportedAt: "2026-08-21T11:12:34.694Z",
    config: { targetDomain: "pos.v2.circa.vn", guides: [{ id: "g1", name: "G", steps: [] }] },
  };
  const r = await checkArtifact(JSON.stringify(legacy), "tooltip-guide-pos.v2.circa.vn (1) (1).json", SMALL);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1, "chỉ một thông báo, không liệt kê lỗi dẫn xuất");
  assert.match(r.errors[0], /legacy v4/);
  assert.match(r.errors[0], /data\/legacy-import\.v5\.json/);
  assert.equal(r.payload, null, "không được gửi file legacy đi đâu cả");
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

test("REGRESSION: the real production artifact still passes at 48/409 with a stable checksum", async () => {
  // Guards the file the operator will actually pick. If the importer ever changes shape,
  // or the artifact is edited by hand, this goes red before anyone reaches the Portal.
  const path = resolve(REPO, "data/legacy-import.v5.json");
  const r = await checkArtifact(readFileSync(path, "utf8"), "legacy-import.v5.json");
  assert.deepEqual(r.errors, [], "artifact production phải hợp lệ");
  assert.equal(r.ok, true);
  assert.equal(r.summary.type, ARTIFACT_TYPE);
  assert.equal(r.summary.schemaVersion, 5);
  assert.equal(r.summary.guides, 48);
  assert.equal(r.summary.steps, 409);
  assert.equal(
    r.summary.computedChecksum,
    "sha256:35d5c7a1ad21d0e0047ca562d02371e2c02f6e4639484851ecca88fe7d8622e9",
  );
  assert.equal(r.summary.embeddedChecksum, r.summary.computedChecksum);
  assert.equal(
    r.summary.sourceFileSha256,
    "8d791365a0b7dda183727ebf64f9148ef76fc2459d3c57d2a8d4d3a09ad7fb3e",
    "phải sinh ra từ đúng file export legacy",
  );
});
