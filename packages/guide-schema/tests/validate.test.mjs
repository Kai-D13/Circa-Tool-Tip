import test from "node:test";
import assert from "node:assert/strict";

import { validateDraftGuide, validateReleasePayload } from "../src/validate.ts";

const step = (over = {}) => ({
  id: "st_1",
  selectors: ["button.primary"],
  matchText: "Xac nhan",
  tag: "button",
  title: "xac nhan",
  content: "noi dung",
  urlPattern: "/ban-hang",
  navigationUrl: "/ban-hang",
  action: { type: "highlight", expectedUrl: "", timeoutMs: 0 },
  ...over,
});

const guide = (over = {}) => ({
  name: "BAN HANG TAI QUAY",
  siteCode: "pos",
  status: "draft",
  startUrl: "/trang-chu",
  steps: [step()],
  ...over,
});

const has = (list, needle) => list.some((m) => m.includes(needle));

test("a clean guide passes", () => {
  const r = validateDraftGuide(guide());
  assert.deepEqual(r.errors, []);
});

test("a guide with no steps is an error", () => {
  assert.ok(has(validateDraftGuide(guide({ steps: [] })).errors, "chưa có bước"));
});

test("no start URL anywhere is an error", () => {
  const g = guide({ startUrl: "", steps: [step({ urlPattern: "" })] });
  assert.ok(has(validateDraftGuide(g).errors, "URL bắt đầu"));
});

test("duplicate step ids are an error", () => {
  const g = guide({ steps: [step(), step()] });
  assert.ok(has(validateDraftGuide(g).errors, "bị trùng"));
});

test("an auto-click with nothing to click is an error, not a warning", () => {
  const g = guide({
    steps: [step({ selectors: [], matchText: "", action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 0 } })],
  });
  assert.ok(has(validateDraftGuide(g).errors, "TỰ click"));
});

test("an unmapped manual step is fine", () => {
  const g = guide({
    steps: [step({ selectors: [], matchText: "", action: { type: "manual", expectedUrl: "", timeoutMs: 0 } })],
  });
  assert.deepEqual(validateDraftGuide(g).errors, []);
});

test("a broad selector with nothing to fall back on is an error", () => {
  const g = guide({ steps: [step({ selectors: ["body"], matchText: "" })] });
  assert.ok(has(validateDraftGuide(g).errors, "quá rộng"));
});

test("a broad selector rescued by a text anchor is only a warning", () => {
  // Four legacy voucher steps are exactly this: `div > div:nth-of-type(9)` plus a real
  // label. resolveTarget re-anchors on the text, so blocking them would be wrong.
  const g = guide({ steps: [step({ selectors: ["div > div:nth-of-type(9)"], matchText: "Ngay bat dau" })] });
  const r = validateDraftGuide(g);
  assert.deepEqual(r.errors, []);
  assert.ok(has(r.warnings, "text anchor"));
});

test("a broad primary selector rescued by a specific candidate is only a warning", () => {
  const g = guide({
    steps: [step({ selectors: ["div > div:nth-of-type(9)", "form#voucher input[name='start']"], matchText: "" })],
  });
  const r = validateDraftGuide(g);
  assert.deepEqual(r.errors, []);
  assert.ok(has(r.warnings, "candidate dự phòng"));
});

test("a wildcard step must be reached by a wait-url navigation", () => {
  const g = guide({ steps: [step(), step({ id: "st_2", urlPattern: "/ban-hang/*" })] });
  assert.ok(has(validateDraftGuide(g).errors, "KHÔNG điều hướng"));
});

test("a wildcard step is accepted when the previous step waits for it", () => {
  const g = guide({
    steps: [
      step({ action: { type: "auto_click_wait_url", expectedUrl: "/ban-hang/*", timeoutMs: 0 } }),
      step({ id: "st_2", urlPattern: "/ban-hang/*" }),
    ],
  });
  assert.deepEqual(validateDraftGuide(g).errors, []);
});

test("a wait target aimed at a different base is an error", () => {
  const g = guide({
    steps: [
      step({ action: { type: "auto_click_wait_url", expectedUrl: "/tra-hang/*", timeoutMs: 0 } }),
      step({ id: "st_2", urlPattern: "/ban-hang/*" }),
    ],
  });
  assert.ok(has(validateDraftGuide(g).errors, "KHÔNG khớp"));
});

test("requireSite turns an unassigned guide into an error", () => {
  const g = guide({ siteCode: null, status: "unassigned" });
  assert.deepEqual(validateDraftGuide(g).errors, [], "not checked by default");
  assert.ok(has(validateDraftGuide(g, { requireSite: true }).errors, "chưa được gán site"));
});

test("an unknown siteOverride is an error", () => {
  const g = guide({ steps: [step({ siteOverride: "nope" })] });
  assert.ok(has(validateDraftGuide(g, { knownSites: ["pos", "admin"] }).errors, "không tồn tại"));
});

test("a missing title is only a warning", () => {
  const r = validateDraftGuide(guide({ steps: [step({ title: "" })] }));
  assert.deepEqual(r.errors, []);
  assert.ok(has(r.warnings, "thiếu tiêu đề"));
});

/* ------------------------------------------------------------------ release */

const release = (over = {}) => ({
  schemaVersion: 5,
  site: "pos",
  revision: 3,
  releasedAt: "2026-09-06T00:00:00.000Z",
  checksum: "sha256:deadbeef",
  sites: { pos: "https://pos.v2.circa.vn", admin: "https://admin.v2.circa.vn" },
  groups: ["Ban hang"],
  guides: [
    {
      id: "gu1",
      legacyId: "gmrn761p80rf1",
      name: "BAN HANG TAI QUAY",
      site: "pos",
      group: "Ban hang",
      sortOrder: 1,
      start: { site: "pos", url: "/trang-chu" },
      steps: [{ ...step(), site: "pos" }],
    },
  ],
  ...over,
});

test("a well formed release passes", () => {
  assert.deepEqual(validateReleasePayload(release(), "pos").errors, []);
});

test("the wrong schema version is rejected", () => {
  assert.ok(has(validateReleasePayload(release({ schemaVersion: 4 })).errors, "schemaVersion"));
});

test("a release for the wrong site is rejected", () => {
  assert.ok(has(validateReleasePayload(release(), "admin").errors, "đang yêu cầu"));
});

test("P0-5 INVARIANT: a released step with no site is rejected", () => {
  const bad = release();
  delete bad.guides[0].steps[0].site;
  assert.ok(has(validateReleasePayload(bad, "pos").errors, "site"));
});

test("a step naming a site that is not in the sites map is rejected", () => {
  const bad = release();
  bad.guides[0].steps[0].site = "staging";
  assert.ok(has(validateReleasePayload(bad, "pos").errors, "staging"));
});

test("a group label that is not listed in the release is rejected", () => {
  const bad = release();
  bad.guides[0].group = "Khong co";
  assert.ok(has(validateReleasePayload(bad, "pos").errors, "Khong co"));
});

test("a non-https origin is rejected", () => {
  const bad = release({ sites: { pos: "http://pos.v2.circa.vn" } });
  assert.ok(has(validateReleasePayload(bad).errors, "Origin"));
});

test("garbage in is reported, not thrown", () => {
  assert.ok(validateReleasePayload(null).errors.length > 0);
  assert.ok(validateReleasePayload("nope").errors.length > 0);
});
