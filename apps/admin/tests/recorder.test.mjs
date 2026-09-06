import test from "node:test";
import assert from "node:assert/strict";

import {
  appendRecorded,
  newRecordingId,
  originToSite,
  recordReadiness,
  recordedToDraftSteps,
  recordingStartUrl,
  resolveExtensionId,
  siteOrigins,
} from "../lib/guides/recorder.ts";

const REAL_ID = "hgkjieodgaieajjijlbdecfkejaclndf";
const OTHER_ID = "abcdefghijklmnopabcdefghijklmnop";

const SITES = [
  { code: "pos", label: "POS", origin: "https://pos.v2.circa.vn" },
  { code: "admin", label: "Admin", origin: "https://admin.v2.circa.vn" },
];

const ORIGINS = siteOrigins(SITES);
const ORIGIN_SITE = originToSite(SITES);

/** Deterministic ids so the assertions are about the mapping, not about randomness. */
function ids() {
  let n = 0;
  return () => `st_test${String(++n).padStart(5, "0")}`;
}

const click = (over = {}) => ({
  selectors: ["#basic-button"],
  matchText: "Cài Đặt",
  tag: "button",
  urlPattern: "/trang-chu",
  origin: "https://pos.v2.circa.vn",
  ...over,
});

const map = (recorded, over = {}) =>
  recordedToDraftSteps(recorded, { guideSite: "pos", originSite: ORIGIN_SITE, newId: ids(), ...over });

/* ------------------------------------------------------------- extension id */

test("only a well-formed extension id is used", () => {
  assert.equal(resolveExtensionId(REAL_ID, null, true), REAL_ID);
  for (const bad of ["", undefined, "khong-phai-id", REAL_ID.toUpperCase(), REAL_ID + "z", "zzzz"]) {
    assert.equal(resolveExtensionId(bad, null, true), null, `${String(bad)} phải bị từ chối`);
  }
});

test("the localStorage override works in dev and is ignored in production", () => {
  // In production it would let anything that can write to localStorage point the Portal
  // at an extension of its choosing.
  assert.equal(resolveExtensionId(REAL_ID, OTHER_ID, false), OTHER_ID);
  assert.equal(resolveExtensionId(REAL_ID, OTHER_ID, true), REAL_ID);
  assert.equal(resolveExtensionId(REAL_ID, "rác", false), REAL_ID, "override sai định dạng thì bỏ qua");
});

test("a recording id is recognisable and unique", () => {
  const a = newRecordingId();
  const b = newRecordingId();
  assert.match(a, /^rec_[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});

/* ------------------------------------------------------------------ target */

test("a guide path becomes an absolute URL on its own site", () => {
  assert.equal(recordingStartUrl("pos", "/trang-chu", ORIGINS), "https://pos.v2.circa.vn/trang-chu");
  assert.equal(recordingStartUrl("admin", "dashboard", ORIGINS), "https://admin.v2.circa.vn/dashboard");
  assert.equal(recordingStartUrl("pos", "", ORIGINS), "https://pos.v2.circa.vn/");
});

test("a guide with no site, or a site with no origin, has nowhere to record", () => {
  assert.equal(recordingStartUrl(null, "/trang-chu", ORIGINS), "");
  assert.equal(recordingStartUrl("khac", "/trang-chu", ORIGINS), "");
});

test("a trailing slash on the site origin does not produce a double slash", () => {
  const origins = siteOrigins([{ code: "pos", label: "POS", origin: "https://pos.v2.circa.vn/" }]);
  assert.equal(recordingStartUrl("pos", "/trang-chu", origins), "https://pos.v2.circa.vn/trang-chu");
});

test("recording is blocked with a reason the operator can act on", () => {
  assert.equal(recordReadiness({ extensionId: null, siteCode: "pos", startUrl: "x", dirty: false }).ok, false);
  assert.match(
    recordReadiness({ extensionId: null, siteCode: "pos", startUrl: "x", dirty: false }).reason,
    /extension/i,
  );
  assert.match(
    recordReadiness({ extensionId: REAL_ID, siteCode: null, startUrl: "", dirty: false }).reason,
    /site/i,
  );
  assert.equal(recordReadiness({ extensionId: REAL_ID, siteCode: "pos", startUrl: "https://x/", dirty: false }).ok, true);
});

/* ------------------------------------------------------------------ mapping */

test("a click that stays on the same page waits for the operator, not for a URL", () => {
  const steps = map([click(), click({ matchText: "Báo Cáo" })]);
  assert.equal(steps[0].action.type, "click_next");
  assert.equal(steps[0].action.expectedUrl, "");
});

test("a click followed by a different path becomes a wait-url step", () => {
  // Same rule the importer used, so recorded and imported guides behave identically.
  const steps = map([click(), click({ urlPattern: "/don-hang" })]);
  assert.equal(steps[0].action.type, "click_wait_url");
  assert.equal(steps[0].action.expectedUrl, "/don-hang");
  assert.equal(steps[1].action.type, "click_next", "bước cuối không có gì để chờ");
});

test("RISK R1: the recorder never generates an auto-click", () => {
  // 360 of the 409 legacy steps were auto-click, and that is the single biggest risk in
  // the corpus. Nothing that generates guides may add more of it on its own.
  const steps = map([click(), click({ urlPattern: "/a" }), click({ urlPattern: "/b" })]);
  for (const s of steps) assert.ok(!s.action.type.startsWith("auto_"), `${s.action.type} là auto-click`);
});

test("a step on the guide's own site inherits it; only a hop gets siteOverride", () => {
  const steps = map([click(), click({ origin: "https://admin.v2.circa.vn", urlPattern: "/quan-tri" })]);
  assert.equal(steps[0].siteOverride, undefined, "bước trên chính site của bộ không được ghi siteOverride");
  assert.equal(steps[1].siteOverride, "admin");
});

test("a wait that lands on another site says so", () => {
  const steps = map([click(), click({ origin: "https://admin.v2.circa.vn", urlPattern: "/quan-tri" })]);
  assert.equal(steps[0].action.type, "click_wait_url");
  assert.equal(steps[0].action.expectedUrl, "/quan-tri");
  assert.equal(steps[0].action.expectedSiteOverride, "admin");
});

test("a same-site wait carries no site override", () => {
  const steps = map([click(), click({ urlPattern: "/don-hang" })]);
  assert.equal(steps[0].action.expectedSiteOverride, undefined);
});

test("what the extension captured survives the mapping", () => {
  const [step] = map([click({ selectors: ["#a", "b.c"], matchText: "  Lưu  ", tag: "button" })]);
  assert.deepEqual(step.selectors, ["#a", "b.c"]);
  assert.equal(step.matchText, "Lưu", "matchText đi qua normalizeText như matcher");
  assert.equal(step.tag, "button");
  assert.equal(step.urlPattern, "/trang-chu");
  assert.equal(step.navigationUrl, "/trang-chu");
  assert.equal(step.title, "", "tiêu đề để người duyệt viết");
});

test("an unknown origin does not invent a site", () => {
  const steps = map([click({ origin: "https://khong-biet.example" })]);
  assert.equal(steps[0].siteOverride, undefined);
});

test("every mapped step gets its own id", () => {
  const steps = map([click(), click(), click()]);
  assert.equal(new Set(steps.map((s) => s.id)).size, 3);
});

/* ------------------------------------------------------------------- append */

test("append mode keeps every existing step, in order, ahead of the new ones", () => {
  const existing = [
    { id: "st_old1", selectors: ["#x"], matchText: "cũ 1", tag: "a", title: "", content: "", urlPattern: "/a", navigationUrl: "", action: { type: "highlight", expectedUrl: "", timeoutMs: 0 } },
    { id: "st_old2", selectors: ["#y"], matchText: "cũ 2", tag: "a", title: "", content: "", urlPattern: "/b", navigationUrl: "", action: { type: "highlight", expectedUrl: "", timeoutMs: 0 } },
  ];
  const out = appendRecorded(existing, [click()], { guideSite: "pos", originSite: ORIGIN_SITE, newId: ids() });

  assert.equal(out.length, 3);
  assert.deepEqual(out.slice(0, 2), existing, "bước cũ phải nguyên vẹn, đúng thứ tự");
  assert.equal(out[2].matchText, "Cài Đặt");
});

test("recording nothing changes nothing", () => {
  const existing = [{ id: "st_old1", selectors: [], matchText: "", tag: "", title: "", content: "", urlPattern: "", navigationUrl: "", action: { type: "highlight", expectedUrl: "", timeoutMs: 0 } }];
  assert.deepEqual(appendRecorded(existing, [], { guideSite: "pos", originSite: ORIGIN_SITE }), existing);
});
