import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  blankStep,
  buildValidationPayload,
  canPublish,
  formatSelectors,
  groupIssues,
  insertStepAfter,
  isDirty,
  metadataOf,
  moveStep,
  newStepId,
  parseSelectors,
  patchStep,
  removeStep,
  serializeSteps,
  validateForEditor,
} from "../lib/guides/editor.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ARTIFACT = JSON.parse(readFileSync(resolve(REPO, "data/legacy-import.v5.json"), "utf8"));

const SITES = ["pos", "admin"];

const meta = (over = {}) => ({
  name: "BÁN HÀNG TẠI QUẦY",
  siteCode: "pos",
  groupName: "Bán hàng",
  startUrl: "/trang-chu",
  sortOrder: 10,
  notes: "",
  ...over,
});

const step = (over = {}) => ({
  id: "st_1",
  selectors: ["button.primary"],
  matchText: "Xác nhận",
  tag: "button",
  title: "xac nhan",
  content: "Bấm xác nhận",
  urlPattern: "/trang-chu",
  navigationUrl: "/trang-chu",
  action: { type: "highlight", expectedUrl: "", timeoutMs: 0 },
  ...over,
});

/* ------------------------------------------------------- serialisation round trip */

test("ACCEPTANCE: all 409 production steps survive a load->save round trip byte for byte", () => {
  // The strongest guarantee we can give for "mở và lưu lại không mất field": re-serialise
  // every real step and require deep equality with what is in the database today.
  let total = 0;
  for (const guide of ARTIFACT.guides) {
    const out = serializeSteps(guide.steps);
    assert.deepEqual(out, guide.steps, `guide "${guide.name}" bị đổi khi round-trip`);
    total += out.length;
  }
  assert.equal(ARTIFACT.guides.length, 48);
  assert.equal(total, 409);
});

test("round trip preserves step order exactly", () => {
  const guide = ARTIFACT.guides.find((g) => g.steps.length > 5);
  assert.deepEqual(
    serializeSteps(guide.steps).map((s) => s.id),
    guide.steps.map((s) => s.id),
  );
});

test("importer flags are carried through a save, not dropped", () => {
  const flagged = ARTIFACT.guides.flatMap((g) => g.steps).find((s) => (s.flags || []).length > 0);
  assert.ok(flagged, "artifact phải có ít nhất một step mang flag");
  assert.deepEqual(serializeSteps([flagged])[0].flags, flagged.flags);
});

test("defaults stay omitted so a save does not inflate the row", () => {
  const s = serializeSteps([step({ intent: "exact", position: "auto", urlMatchMode: "path" })])[0];
  assert.equal(s.intent, undefined);
  assert.equal(s.position, undefined);
  assert.equal(s.urlMatchMode, undefined, "path suy ra được từ /trang-chu");
});

test("non-default intent, position and match mode are kept", () => {
  const s = serializeSteps([
    step({ intent: "first_item", position: "top", urlPattern: "/don-hang?tab=x", urlMatchMode: "exact" }),
  ])[0];
  assert.equal(s.intent, "first_item");
  assert.equal(s.position, "top");
  assert.equal(s.urlMatchMode, "exact");
});

test("siteOverride survives only when set", () => {
  assert.equal(serializeSteps([step()])[0].siteOverride, undefined);
  assert.equal(serializeSteps([step({ siteOverride: "admin" })])[0].siteOverride, "admin");
});

test("an unknown action type degrades to highlight rather than being written through", () => {
  const s = serializeSteps([step({ action: { type: "rm -rf", expectedUrl: "", timeoutMs: 0 } })])[0];
  assert.equal(s.action.type, "highlight");
});

/* ------------------------------------------------------------------- list ops */

test("moveStep reorders and is a no-op at the edges", () => {
  const list = [step({ id: "a" }), step({ id: "b" }), step({ id: "c" })];
  assert.deepEqual(moveStep(list, 0, 1).map((s) => s.id), ["b", "a", "c"]);
  assert.deepEqual(moveStep(list, 2, -1).map((s) => s.id), ["a", "c", "b"]);
  assert.deepEqual(moveStep(list, 0, -1).map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual(moveStep(list, 2, 1).map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual(list.map((s) => s.id), ["a", "b", "c"], "không mutate input");
});

test("patch, remove and insert keep the rest of the list untouched", () => {
  const list = [step({ id: "a" }), step({ id: "b" })];
  assert.equal(patchStep(list, "b", { title: "mới" })[1].title, "mới");
  assert.equal(patchStep(list, "b", { title: "mới" })[0].title, list[0].title);
  assert.deepEqual(removeStep(list, "a").map((s) => s.id), ["b"]);
  assert.deepEqual(insertStepAfter(list, 0, blankStep("x")).map((s) => s.id), ["a", "x", "b"]);
});

test("new step ids look like importer ids", () => {
  assert.match(newStepId(() => "0123abcd-4567-89ef-0123-456789abcdef"), /^st_[0-9a-f]{10}$/);
});

test("a blank step is valid input for the database shape check", () => {
  const s = serializeSteps([blankStep("st_new")])[0];
  assert.equal(s.id, "st_new");
  assert.ok(Array.isArray(s.selectors));
  assert.equal(s.action.type, "highlight");
});

/* ---------------------------------------------------------------- selectors io */

test("selector textarea round trips and drops blanks and duplicates", () => {
  assert.deepEqual(parseSelectors("  #a \n\n b.c \n#a\n"), ["#a", "b.c"]);
  assert.equal(formatSelectors(["#a", "b.c"]), "#a\nb.c");
  assert.deepEqual(parseSelectors(formatSelectors(["#a", "b.c"])), ["#a", "b.c"]);
});

/* ------------------------------------------------------------------ validation */

test("validation issues are grouped onto the step that caused them", () => {
  const steps = [
    step({ id: "s1", title: "" }),
    step({ id: "s2", selectors: [], matchText: "", action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 0 } }),
  ];
  const grouped = groupIssues(validateForEditor(meta(), steps, "draft", SITES));
  assert.ok(grouped.byStep[1].warnings.some((w) => w.includes("thiếu tiêu đề")));
  assert.ok(grouped.byStep[2].errors.some((e) => e.includes("TỰ click")));
  assert.equal(grouped.byStep[1].errors.length, 0);
});

test("guide-level messages do not get attached to a step", () => {
  const grouped = groupIssues(validateForEditor(meta({ name: "" }), [step()], "draft", SITES));
  assert.ok(grouped.guide.errors.some((e) => e.includes("tên")));
});

test("an unassigned guide is not nagged about its missing site, a draft is", () => {
  const noSite = meta({ siteCode: null });
  assert.deepEqual(validateForEditor(noSite, [step()], "unassigned", SITES).errors, []);
  assert.ok(validateForEditor(noSite, [step()], "draft", SITES).errors.some((e) => e.includes("chưa được gán site")));
});

test("warnings allow publishing; errors and a missing site do not", () => {
  const warn = validateForEditor(meta(), [step({ title: "" })], "draft", SITES);
  assert.equal(warn.errors.length, 0);
  assert.ok(warn.warnings.length > 0);
  assert.equal(canPublish(warn, "pos"), true);

  const bad = validateForEditor(
    meta(),
    [step({ selectors: [], matchText: "", action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 0 } })],
    "draft",
    SITES,
  );
  assert.equal(canPublish(bad, "pos"), false);
  assert.equal(canPublish(warn, null), false, "chưa gán site thì không publish được");
});

test("every production guide still validates with zero errors through the editor path", () => {
  for (const g of ARTIFACT.guides) {
    const m = { name: g.name, siteCode: "pos", groupName: "", startUrl: g.startUrl, sortOrder: 0, notes: "" };
    const r = validateForEditor(m, g.steps, "draft", SITES);
    assert.deepEqual(r.errors, [], `guide "${g.name}" có lỗi validate không mong đợi`);
  }
});

test("saving validation preserves importer flags in the same column", () => {
  const result = { errors: ["e"], warnings: ["w"] };
  const payload = buildValidationPayload(result, { errors: [], warnings: [], flags: ["GUIDE_HAS_AUTO_CLICK_UNANCHORED"] });
  assert.deepEqual(payload.flags, ["GUIDE_HAS_AUTO_CLICK_UNANCHORED"]);
  assert.deepEqual(payload.errors, ["e"]);
  assert.deepEqual(buildValidationPayload(result, null).flags, []);
});

/* ----------------------------------------------------------------------- dirty */

test("dirty tracking ignores field order and default representation", () => {
  const a = { meta: meta(), steps: [step()] };
  const b = { meta: meta(), steps: [step({ intent: "exact", position: "auto" })] };
  assert.equal(isDirty(a, b), false, "intent/position mặc định không tính là thay đổi");
  assert.equal(isDirty(a, { meta: meta({ name: "Khác" }), steps: [step()] }), true);
  assert.equal(isDirty(a, { meta: meta(), steps: [step({ title: "khác" })] }), true);
});

test("metadataOf maps null columns to empty strings the form can bind to", () => {
  const m = metadataOf({ name: "G", site_code: null, group_name: "", start_url: "", sort_order: 0, notes: null });
  assert.equal(m.notes, "");
  assert.equal(m.siteCode, null);
});
