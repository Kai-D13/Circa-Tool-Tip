#!/usr/bin/env node
/**
 * Legacy importer — Batch 1A.
 *
 *   node scripts/import-legacy/cli.mjs [--source <file>] [--out <json>] [--report <md>]
 *                                      [--allow-source-mismatch]
 *
 * Reads the v4 export, scrubs it, converts it to v5 drafts, writes the artifact that
 * Batch 1B feeds to `admin_import_legacy`, and writes docs/IMPORT_REPORT.md.
 *
 * It touches NOTHING outside this repository and talks to no network service.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Tagged } from "../../packages/guide-schema/src/checksum.ts";
import { SCHEMA_VERSION } from "../../packages/guide-schema/src/constants.ts";
import { readLegacyExport } from "./read.mjs";
import { assertNoPii } from "./scrub.mjs";
import { buildReport } from "./report.mjs";
import { findDuplicateNames, transformGuide } from "./transform.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEFAULTS = {
  source: "C:/Users/Administrator/Downloads/tooltip-guide-pos.v2.circa.vn (1) (1).json",
  out: resolve(REPO_ROOT, "data", "legacy-import.v5.json"),
  report: resolve(REPO_ROOT, "docs", "IMPORT_REPORT.md"),
};

function parseArgs(argv) {
  const args = { ...DEFAULTS, allowSourceMismatch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") args.source = argv[++i];
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--report") args.report = resolve(argv[++i]);
    else if (a === "--allow-source-mismatch") args.allowSourceMismatch = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Tham số không hiểu: ${a}`);
  }
  return args;
}

function fail(message) {
  console.error("\n  IMPORT DỪNG LẠI: " + message + "\n");
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "node scripts/import-legacy/cli.mjs [--source <file>] [--out <json>] [--report <md>] [--allow-source-mismatch]",
    );
    return;
  }

  console.log("Đọc  :", args.source);
  const source = readLegacyExport(args.source);

  if (source.problems.length) {
    console.error("\nVấn đề ở file nguồn:");
    for (const p of source.problems) console.error("  - " + p);
    if (!args.allowSourceMismatch) {
      fail("file nguồn không khớp kỳ vọng. Dùng --allow-source-mismatch nếu đây là chủ ý.");
    }
    console.error("(bỏ qua theo --allow-source-mismatch)\n");
  }
  console.log(`       ${source.guides.length} guide / ${source.stepCount} step, sha256 ${source.sha256.slice(0, 16)}…`);

  const duplicateNames = findDuplicateNames(source.guides);
  const guides = source.guides.map((g, i) => transformGuide(g, { sortOrder: (i + 1) * 10, duplicateNames }));

  // Hard gate: nothing leaves this script while it still smells of PII.
  const piiHits = assertNoPii(guides);
  if (piiHits.length) {
    console.error("\nCòn dấu vết dữ liệu cá nhân (giá trị đã được che):");
    for (const h of piiHits) console.error(`  - ${h.guide} / bước ${h.step} / ${h.field}`);
    fail("scrub chưa sạch — không ghi artifact.");
  }

  const outSteps = guides.reduce((n, g) => n + g.steps.length, 0);
  if (guides.length !== source.guides.length || outSteps !== source.stepCount) {
    fail(`mất mát dữ liệu: ${guides.length}/${source.guides.length} guide, ${outSteps}/${source.stepCount} step.`);
  }

  const content = {
    _type: "circa-tooltip-legacy-import",
    schemaVersion: SCHEMA_VERSION,
    source: {
      filename: args.source.split(/[\\/]/).pop(),
      bytes: source.bytes,
      sha256: source.sha256,
      exportedAt: source.exportedAt,
      legacyVersion: source.legacyVersion,
      targetDomain: source.targetDomain,
    },
    stats: { guides: guides.length, steps: outSteps },
    guides,
  };
  // Checksum covers content only — no timestamp — so re-running is byte-identical.
  const payloadChecksum = await sha256Tagged(canonicalJson(content));

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify({ ...content, checksum: payloadChecksum }, null, 2) + "\n", "utf8");
  console.log("Ghi  :", args.out);

  const report = buildReport({
    source,
    guides,
    payloadChecksum,
    piiHits,
    generatedAt: new Date().toISOString(),
  });
  mkdirSync(dirname(args.report), { recursive: true });
  writeFileSync(args.report, report, "utf8");
  console.log("Ghi  :", args.report);

  const flagCounts = new Map();
  for (const g of guides) for (const s of g.steps) for (const f of s.flags || []) {
    flagCounts.set(f, (flagCounts.get(f) || 0) + 1);
  }

  console.log("\nTổng kết");
  console.log(`  guide            : ${guides.length}`);
  console.log(`  step             : ${outSteps}`);
  console.log(`  chưa gán site    : ${guides.filter((g) => g.siteCode === null).length}`);
  console.log(`  PII còn lại      : ${piiHits.length}`);
  console.log(`  checksum         : ${payloadChecksum}`);
  console.log("  flag:");
  for (const [f, n] of [...flagCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${f}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
