import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FILTER,
  applyAssignment,
  confidenceOf,
  filterGuides,
  hasWarnings,
  highConfidenceSuggestions,
  progressOf,
  unknownFirst,
} from "../lib/guides/triage.ts";

let seq = 0;
const guide = (over = {}) => ({
  id: "g" + ++seq,
  legacy_id: null,
  site_code: null,
  group_name: "",
  name: "BỘ " + seq,
  status: "unassigned",
  start_url: "/x",
  sort_order: seq * 10,
  step_count: 3,
  validation: {},
  site_guess: null,
  site_evidence: { confidence: "none" },
  notes: null,
  updated_at: "2026-09-06T00:00:00Z",
  ...over,
});

test("confidence defaults to none when evidence is missing or unknown", () => {
  assert.equal(confidenceOf(guide({ site_evidence: {} })), "none");
  assert.equal(confidenceOf(guide({ site_evidence: { confidence: "weird" } })), "none");
  assert.equal(confidenceOf(guide({ site_evidence: { confidence: "high" } })), "high");
});

test("the four unknown guides sort to the top", () => {
  const list = [
    guide({ name: "A", site_evidence: { confidence: "high" }, sort_order: 1 }),
    guide({ name: "B", site_evidence: { confidence: "none" }, sort_order: 2 }),
    guide({ name: "C", site_evidence: { confidence: "medium" }, sort_order: 3 }),
    guide({ name: "D", site_evidence: { confidence: "none" }, sort_order: 4 }),
  ];
  assert.deepEqual(unknownFirst(list).map((g) => g.name), ["B", "D", "C", "A"]);
});

test("default filter shows only unassigned guides", () => {
  const list = [guide(), guide({ status: "draft", site_code: "pos" })];
  assert.equal(filterGuides(list, DEFAULT_FILTER).length, 1);
});

test("scope filters by assigned site", () => {
  const list = [guide({ status: "draft", site_code: "pos" }), guide({ status: "draft", site_code: "admin" })];
  assert.equal(filterGuides(list, { ...DEFAULT_FILTER, scope: "pos" }).length, 1);
  assert.equal(filterGuides(list, { ...DEFAULT_FILTER, scope: "admin" }).length, 1);
  assert.equal(filterGuides(list, { ...DEFAULT_FILTER, scope: "all" }).length, 2);
});

test("search is diacritic-insensitive", () => {
  const list = [guide({ name: "TẠO VOUCHER GIẢM GIÁ" }), guide({ name: "BÁN HÀNG TẠI QUẦY" })];
  assert.equal(filterGuides(list, { ...DEFAULT_FILTER, query: "voucher giam" }).length, 1);
  assert.equal(filterGuides(list, { ...DEFAULT_FILTER, query: "ban hang" }).length, 1);
});

test("warning filter uses flags, warnings and errors", () => {
  assert.equal(hasWarnings(guide()), false);
  assert.equal(hasWarnings(guide({ validation: { flags: ["GUIDE_HAS_AUTO_CLICK_UNANCHORED"] } })), true);
  assert.equal(hasWarnings(guide({ validation: { warnings: ["x"] } })), true);
  const list = [guide(), guide({ validation: { warnings: ["w"] } })];
  assert.equal(filterGuides(list, { ...DEFAULT_FILTER, onlyWarnings: true }).length, 1);
});

test("assignment flips unassigned -> draft, sets site and group, and does not mutate", () => {
  const list = [guide(), guide()];
  const next = applyAssignment(list, list[0].id, "pos", "  Bán hàng ");
  assert.equal(list[0].status, "unassigned", "input untouched");
  assert.equal(next[0].status, "draft");
  assert.equal(next[0].site_code, "pos");
  assert.equal(next[0].group_name, "Bán hàng");
  assert.equal(next[1].status, "unassigned");
});

test("counter goes 48 -> 47 after one assignment", () => {
  const list = Array.from({ length: 48 }, () => guide());
  assert.deepEqual(progressOf(list), { total: 48, assigned: 0, unassigned: 48 });
  const next = applyAssignment(list, list[5].id, "admin", "");
  assert.deepEqual(progressOf(next), { total: 48, assigned: 1, unassigned: 47 });
});

test("a published guide keeps its status when re-assigned locally", () => {
  const list = [guide({ status: "published", site_code: "pos" })];
  assert.equal(applyAssignment(list, list[0].id, "admin", "")[0].status, "published");
});

test("bulk suggestions are only high-confidence, unassigned, with a concrete guess", () => {
  const list = [
    guide({ site_guess: "pos", site_evidence: { confidence: "high" } }),
    guide({ site_guess: "admin", site_evidence: { confidence: "medium" } }),
    guide({ site_guess: null, site_evidence: { confidence: "high" } }),
    guide({ site_guess: "admin", site_evidence: { confidence: "high" }, status: "draft", site_code: "admin" }),
  ];
  assert.equal(highConfidenceSuggestions(list).length, 1);
});
