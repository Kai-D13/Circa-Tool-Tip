/**
 * Importer regression tests.
 *
 * Runs the real pipeline over a synthetic fixture, so CI exercises it without the
 * production export (which contains real customer data and is not in the repo).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FLAGS } from "../../packages/guide-schema/src/flags.ts";
import { readLegacyExport } from "./read.mjs";
import { assertNoPii, containsPhone, scrubStepUrls, scrubUrl } from "./scrub.mjs";
import { findDuplicateNames, legacyStepId, transformGuide } from "./transform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "fixtures", "legacy-sample.v4.json");

function runPipeline() {
  const source = readLegacyExport(FIXTURE, {
    expect: { bytes: null, sha256: null, guides: 2, steps: 5 },
  });
  assert.deepEqual(source.problems, [], "fixture phải hợp lệ");
  const duplicateNames = findDuplicateNames(source.guides);
  return {
    source,
    guides: source.guides.map((g, i) => transformGuide(g, { sortOrder: (i + 1) * 10, duplicateNames })),
  };
}

const flagsOf = (step) => step.flags || [];

/* ------------------------------------------------------------- scrubUrl unit */

test("P0-4: a record id becomes a wildcard VALUE, keeping the parameter name", () => {
  const r = scrubUrl("/sellback/create?id=98f7f76b-53e0-450c-8843-d557e8145f5a");
  assert.equal(r.url, "/sellback/create?id=*");
  assert.equal(r.dynamic, true);
  assert.ok(r.flags.includes(FLAGS.URL_UUID_STRIPPED));
});

test("P0-4: a store id behaves the same way", () => {
  const r = scrubUrl("/sellback/eligible?pos=e71c515b-38a9-481c-a4f1-84eb640db60d");
  assert.equal(r.url, "/sellback/eligible?pos=*");
});

test("P0-4: other parameters survive alongside the wildcarded id", () => {
  const r = scrubUrl("/sellback/new?id=deb5b23f-eb01-4b3d-bf69-dbaa59f7dbf6&tab=chi-tiet");
  assert.equal(r.url, "/sellback/new?id=*&tab=chi-tiet");
});

test("P0-4: stale params are still dropped from a dynamic URL", () => {
  const r = scrubUrl("/sellback/new?id=deb5b23f-eb01-4b3d-bf69-dbaa59f7dbf6&keyword=DIZZO");
  assert.equal(r.url, "/sellback/new?id=*");
});

test("P0-4: a UUID in the path becomes a wildcard segment", () => {
  const r = scrubUrl("/don-hang/98f7f76b-53e0-450c-8843-d557e8145f5a/chi-tiet");
  assert.equal(r.url, "/don-hang/*/chi-tiet");
  assert.equal(r.dynamic, true);
});

test("P0-4: a dynamic URL clears navigationUrl - there is no single page to open", () => {
  const r = scrubStepUrls({
    urlPattern: "/sellback/new?id=deb5b23f-eb01-4b3d-bf69-dbaa59f7dbf6",
    navigationUrl: "/sellback/new?id=deb5b23f-eb01-4b3d-bf69-dbaa59f7dbf6",
  });
  assert.equal(r.urlPattern, "/sellback/new?id=*");
  assert.equal(r.navigationUrl, "");
  assert.equal(r.dynamic, true);
});

test("a plain URL is left alone", () => {
  const r = scrubStepUrls({ urlPattern: "/trang-chu", navigationUrl: "/trang-chu" });
  assert.equal(r.urlPattern, "/trang-chu");
  assert.equal(r.navigationUrl, "/trang-chu");
  assert.equal(r.changed, false);
});

test("stale environment params are dropped, meaningful ones survive", () => {
  const r = scrubUrl("/don-hang?keyword=DIZZO&page=2&date_from_dashboard=2026-05-27T17%3A00%3A00Z");
  assert.equal(r.url, "/don-hang?page=2");
  assert.ok(r.flags.includes(FLAGS.URL_STALE_QUERY_STRIPPED));
});

test("a phone hidden inside an encoded JSON filter is found and removed", () => {
  const filter = encodeURIComponent(JSON.stringify({ status: "ALL", customer_phone: "0900000000" }));
  const original = "/don-hang?filter=" + filter;
  assert.ok(containsPhone(original), "phải phát hiện được trước khi scrub");
  const r = scrubUrl(original);
  assert.ok(!containsPhone(r.url), "sau khi scrub không còn dấu vết");
  assert.ok(r.flags.includes(FLAGS.PII_SCRUBBED));
  assert.ok(r.url.includes("filter="), "phần lọc còn lại vẫn được giữ");
});

test("a filter left with nothing meaningful is dropped entirely", () => {
  const filter = encodeURIComponent(JSON.stringify({ customer_phone: "0900000000", dateRange: ["a", "b"] }));
  const r = scrubUrl("/don-hang?filter=" + filter);
  assert.equal(r.url, "/don-hang");
});

/* --------------------------------------------------------------- full pipeline */

test("fixture imports with no loss", () => {
  const { source, guides } = runPipeline();
  assert.equal(guides.length, 2);
  assert.equal(guides.reduce((n, g) => n + g.steps.length, 0), source.stepCount);
});

test("every imported guide stays unassigned - a human assigns the site", () => {
  const { guides } = runPipeline();
  assert.ok(guides.every((g) => g.siteCode === null && g.status === "unassigned"));
});

test("step ids are deterministic across runs", () => {
  const a = runPipeline().guides.map((g) => g.steps.map((s) => s.id));
  const b = runPipeline().guides.map((g) => g.steps.map((s) => s.id));
  assert.deepEqual(a, b);
  assert.equal(a[0][0], legacyStepId("fixaaaaaaaaa1", 0));
});

test("P0-4 end to end: the wait chain still points at the widened URL", () => {
  const { guides } = runPipeline();
  const g = guides[0];
  assert.equal(g.steps[1].urlPattern, "/sellback/create?id=*");
  assert.equal(g.steps[1].navigationUrl, "");
  // Step 0 waits for step 1's pattern; step 1 waits for step 2's. Both are the wildcard,
  // so validateDraftGuide's "previous step must navigate here" rule is satisfied.
  assert.equal(g.steps[0].action.expectedUrl, "/sellback/create?id=*");
  assert.equal(g.steps[1].action.expectedUrl, "/sellback/create?id=*");
  assert.deepEqual(g.validation.errors, []);
});

test("no PII survives the pipeline", () => {
  const { guides } = runPipeline();
  assert.deepEqual(assertNoPii(guides), []);
});

test("the zero-width-only anchor is reported rather than trusted", () => {
  const { guides } = runPipeline();
  const step = guides[1].steps[0];
  assert.equal(step.matchText, "");
  assert.ok(flagsOf(step).includes(FLAGS.MATCH_TEXT_ZERO_WIDTH_ONLY));
  assert.ok(flagsOf(step).includes(FLAGS.NO_TEXT_ANCHOR));
});

test("auto-click on a structural selector with no text is flagged", () => {
  const { guides } = runPipeline();
  assert.ok(flagsOf(guides[1].steps[0]).includes(FLAGS.AUTO_CLICK_UNANCHORED));
});

test("a broad selector rescued by a text anchor warns instead of erroring", () => {
  const { guides } = runPipeline();
  const step = guides[1].steps[1];
  assert.ok(flagsOf(step).includes(FLAGS.SEL_BROAD));
  assert.deepEqual(guides[1].validation.errors, []);
  assert.ok(guides[1].validation.warnings.some((w) => w.includes("text anchor")));
});

test("the guide start URL is scrubbed too", () => {
  const { guides } = runPipeline();
  assert.equal(guides[1].startUrl, "/dashboard", "ngày tuyệt đối bị gỡ khỏi startUrl");
});

test("classification only ever guesses - it never assigns", () => {
  const { guides } = runPipeline();
  for (const g of guides) {
    assert.equal(g.siteCode, null);
    assert.ok(Object.prototype.hasOwnProperty.call(g, "siteGuess"));
    assert.ok(g.siteEvidence.confidence);
  }
});
