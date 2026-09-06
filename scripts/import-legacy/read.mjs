/**
 * Step 1 of the legacy import: read and prove the source file is what we think it is.
 *
 * Every assertion here exists because the importer's later stages depend on it. If one
 * fails, the right answer is to stop and look, not to import partial data.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { LEGACY_ENVELOPE_TYPE, LEGACY_SCHEMA_VERSION } from "../../packages/guide-schema/src/constants.ts";

export const EXPECTED_SOURCE = {
  bytes: 378029,
  sha256: "8d791365a0b7dda183727ebf64f9148ef76fc2459d3c57d2a8d4d3a09ad7fb3e",
  guides: 48,
  steps: 409,
};

export function readLegacyExport(filePath, opts = {}) {
  const expect = { ...EXPECTED_SOURCE, ...(opts.expect || {}) };
  const problems = [];

  const bytes = statSync(filePath).size;
  const buf = readFileSync(filePath);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const raw = JSON.parse(buf.toString("utf8"));

  if (expect.bytes && bytes !== expect.bytes) {
    problems.push(`Kích thước file ${bytes} khác kỳ vọng ${expect.bytes}`);
  }
  if (expect.sha256 && sha256 !== expect.sha256) {
    problems.push(`SHA256 ${sha256} khác kỳ vọng ${expect.sha256}`);
  }
  if (raw?._type !== LEGACY_ENVELOPE_TYPE) {
    problems.push(`_type = ${JSON.stringify(raw?._type)}, cần "${LEGACY_ENVELOPE_TYPE}"`);
  }
  if (raw?._version !== LEGACY_SCHEMA_VERSION) {
    problems.push(`_version = ${JSON.stringify(raw?._version)}, cần ${LEGACY_SCHEMA_VERSION}`);
  }

  const config = raw?.config;
  if (!config || typeof config !== "object") problems.push("Thiếu object config");
  const guides = Array.isArray(config?.guides) ? config.guides : [];
  const stepCount = guides.reduce((n, g) => n + (Array.isArray(g.steps) ? g.steps.length : 0), 0);

  if (expect.guides && guides.length !== expect.guides) {
    problems.push(`Có ${guides.length} guide, kỳ vọng ${expect.guides}`);
  }
  if (expect.steps && stepCount !== expect.steps) {
    problems.push(`Có ${stepCount} step, kỳ vọng ${expect.steps}`);
  }

  // Structural invariants the later stages rely on.
  const ids = new Set();
  guides.forEach((g, i) => {
    if (!g?.id) problems.push(`Guide #${i + 1} thiếu id`);
    else if (ids.has(g.id)) problems.push(`Guide id trùng: ${g.id}`);
    else ids.add(g.id);
    if (!Array.isArray(g?.steps) || !g.steps.length) problems.push(`Guide "${g?.name}" không có step`);
  });

  // v4 duplicated `selector` into `selectorCandidates[0]` on every step. normalize.mjs
  // drops `selector` on that basis, so prove it before dropping anything.
  let mismatched = 0;
  for (const g of guides) {
    for (const s of g.steps || []) {
      const first = Array.isArray(s.selectorCandidates) ? s.selectorCandidates[0] : undefined;
      if (String(s.selector || "") !== String(first || "")) mismatched++;
    }
  }
  if (mismatched) {
    problems.push(`${mismatched} step có selector khác selectorCandidates[0] — không được bỏ trường selector`);
  }

  return {
    filePath,
    bytes,
    sha256,
    exportedAt: raw?.exportedAt || "",
    legacyVersion: raw?._version,
    targetDomain: config?.targetDomain || "",
    guides,
    stepCount,
    problems,
  };
}
