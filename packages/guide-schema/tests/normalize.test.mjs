import test from "node:test";
import assert from "node:assert/strict";

import {
  isUnmapped,
  looksBroadSelector,
  looksDynamicUrl,
  materializeReleaseStep,
  normalizeAction,
  normalizeDraftStep,
} from "../src/normalize.ts";

const ZW = String.fromCharCode(0x200b);

const v4 = (over = {}) => ({
  selector: "button.primary",
  selectorCandidates: ["button.primary", "form > button:nth-of-type(1)"],
  matchText: "Xac nhan",
  tag: "button",
  intent: "exact",
  title: "xac nhan",
  content: "Bam xac nhan",
  position: "auto",
  urlPattern: "/ban-hang",
  navigationUrl: "/ban-hang",
  urlMatchMode: "path",
  action: { type: "auto_click_wait_url", expectedUrl: "", timeoutMs: 0 },
  ...over,
});

test("normalizeAction migrates the v3 advanceOnClick boolean", () => {
  assert.equal(normalizeAction({ advanceOnClick: true }).type, "click_next");
  assert.equal(normalizeAction({ advanceOnClick: false }).type, "highlight");
});

test("an unknown action degrades to highlight, never to an auto-click", () => {
  assert.equal(normalizeAction({ action: { type: "rm -rf" } }).type, "highlight");
});

test("selector is folded into selectors[0] without duplicating it", () => {
  const s = normalizeDraftStep(v4(), { id: "st_1" });
  assert.deepEqual(s.selectors, ["button.primary", "form > button:nth-of-type(1)"]);
  assert.equal(s.selector, undefined, "v5 has no `selector` field");
});

test("defaults are omitted so they cannot drift", () => {
  const s = normalizeDraftStep(v4(), { id: "st_1" });
  assert.equal(s.intent, undefined);
  assert.equal(s.position, undefined);
  assert.equal(s.urlMatchMode, undefined, "path is inferable from the pattern");
});

test("a non-inferable urlMatchMode is preserved", () => {
  const s = normalizeDraftStep(v4({ urlPattern: "/don-hang?tab=x", urlMatchMode: "exact" }), { id: "st_1" });
  assert.equal(s.urlMatchMode, "exact");
});

test("non-default intent and position survive", () => {
  const s = normalizeDraftStep(v4({ intent: "first_item", position: "top" }), { id: "st_1" });
  assert.equal(s.intent, "first_item");
  assert.equal(s.position, "top");
});

test("zero-width characters are stripped out of matchText", () => {
  const s = normalizeDraftStep(v4({ matchText: ZW + " " + ZW }), { id: "st_1" });
  assert.equal(s.matchText, "", "a zero-width-only anchor must not read as truthy");
});

test("expectedUrl is materialized for wait-url actions", () => {
  const s = normalizeDraftStep(v4(), { id: "st_1", expectedUrl: "/ban-hang/abc" });
  assert.equal(s.action.expectedUrl, "/ban-hang/abc");
});

test("expectedUrl is NOT injected into a non-wait action", () => {
  const s = normalizeDraftStep(v4({ action: { type: "highlight", expectedUrl: "", timeoutMs: 0 } }), {
    id: "st_1",
    expectedUrl: "/should-not-appear",
  });
  assert.equal(s.action.expectedUrl, "");
});

test("siteOverride is only written when explicitly asked for", () => {
  assert.equal(normalizeDraftStep(v4(), { id: "st_1" }).siteOverride, undefined);
  assert.equal(normalizeDraftStep(v4(), { id: "st_1", siteOverride: "admin" }).siteOverride, "admin");
});

test("materializeReleaseStep fills site and drops authoring-only fields", () => {
  const draft = normalizeDraftStep(v4(), { id: "st_1", flags: ["NO_TEXT_ANCHOR"] });
  const rel = materializeReleaseStep(draft, "pos");
  assert.equal(rel.site, "pos");
  assert.equal(rel.flags, undefined);
  assert.equal(rel.siteOverride, undefined);
});

test("materializeReleaseStep honours siteOverride for a cross-site step", () => {
  const draft = normalizeDraftStep(v4(), { id: "st_1", siteOverride: "admin" });
  assert.equal(materializeReleaseStep(draft, "pos").site, "admin");
});

test("materializeReleaseStep refuses a step with no site at all", () => {
  const draft = normalizeDraftStep(v4(), { id: "st_1" });
  assert.throws(() => materializeReleaseStep(draft, ""), /has no site/);
});

test("isUnmapped needs either a selector or a text anchor", () => {
  const base = { selectors: [], matchText: "" };
  assert.ok(isUnmapped(base));
  assert.ok(!isUnmapped({ selectors: ["#a"], matchText: "" }));
  assert.ok(!isUnmapped({ selectors: [], matchText: "Luu" }));
  assert.ok(isUnmapped({ selectors: [], matchText: ZW }), "zero-width is not an anchor");
});

test("looksBroadSelector catches page-level selectors", () => {
  assert.ok(looksBroadSelector("body"));
  assert.ok(looksBroadSelector("html"));
  assert.ok(looksBroadSelector("*"));
  assert.ok(!looksBroadSelector("button.primary"));
  assert.ok(!looksBroadSelector("#basic-button"));
});

test("looksDynamicUrl spots pinned records but not wildcards", () => {
  assert.ok(looksDynamicUrl("/sellback/create?id=98f7f76b-53e0-450c-8843-d557e8145f5a"));
  assert.ok(looksDynamicUrl("/don-hang/123456"));
  assert.ok(!looksDynamicUrl("/ban-hang/*"));
  assert.ok(!looksDynamicUrl("/trang-chu"));
});
