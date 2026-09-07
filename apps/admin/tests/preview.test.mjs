import test from "node:test";
import assert from "node:assert/strict";

import {
  newToolSessionId,
  originsOf,
  previewReadiness,
  previewRequest,
  probeReadiness,
  probeRequest,
  stepPageUrl,
  summarizeProbe,
} from "../lib/guides/preview.ts";

const SITES = [
  { code: "pos", label: "POS", origin: "https://pos.v2.circa.vn" },
  { code: "admin", label: "Admin", origin: "https://admin.v2.circa.vn" },
];
const ORIGINS = originsOf(SITES);
const EXT_ID = "hgkjieodgaieajjijlbdecfkejaclndf";

const step = (over = {}) => {
  const s = {
    id: "st_1",
    selectors: ["#basic-button"],
    matchText: "Cài Đặt",
    tag: "button",
    title: "Mở Cài Đặt",
    content: "",
    urlPattern: "/trang-chu",
    action: { type: "click_next", expectedUrl: "", timeoutMs: 0 },
    ...over,
  };
  return { ...s, navigationUrl: over.navigationUrl ?? s.urlPattern };
};

const probeResult = (over = {}) => ({
  ok: true,
  candidates: [{ selector: "#basic-button", count: 1, textMatches: 1, invalid: false }],
  matchText: "Cài Đặt",
  resolved: { selector: "#basic-button", selectorIndex: 0, via: "selector", count: 1 },
  reason: "",
  ...over,
});

/* --------------------------------------------------------------------- basics */

test("a tool session id says which tool it belongs to", () => {
  assert.match(newToolSessionId("prb"), /^prb_[0-9a-f]{12}$/);
  assert.match(newToolSessionId("pvw"), /^pvw_[0-9a-f]{12}$/);
  assert.notEqual(newToolSessionId("prb"), newToolSessionId("prb"));
});

test("origins lose their trailing slash so paths never double up", () => {
  const origins = originsOf([{ code: "pos", label: "POS", origin: "https://pos.v2.circa.vn/" }]);
  assert.equal(stepPageUrl(step(), "pos", "/", origins), "https://pos.v2.circa.vn/trang-chu");
});

/* ------------------------------------------------------- which page to open */

test("a step is opened on the page it lives on", () => {
  assert.equal(stepPageUrl(step(), "pos", "/khac", ORIGINS), "https://pos.v2.circa.vn/trang-chu");
});

test("a step that crosses to another site is opened on THAT site", () => {
  // Probing an Admin step on the POS origin would report "không tìm thấy" for a step that
  // is perfectly fine.
  const crossing = step({ siteOverride: "admin", urlPattern: "/quan-tri" });
  assert.equal(stepPageUrl(crossing, "pos", "/trang-chu", ORIGINS), "https://admin.v2.circa.vn/quan-tri");
});

test("a wildcard step falls back to the guide's start page", () => {
  // A wildcard describes a family of pages; there is no single URL to open.
  const wild = step({ urlPattern: "/don-hang/*", navigationUrl: "" });
  assert.equal(stepPageUrl(wild, "pos", "/trang-chu", ORIGINS), "https://pos.v2.circa.vn/trang-chu");
});

test("a guide with no site has no page to open", () => {
  assert.equal(stepPageUrl(step(), null, "/trang-chu", ORIGINS), "");
  assert.equal(stepPageUrl(step(), "khac", "/trang-chu", ORIGINS), "");
});

/* ------------------------------------------------------------------ gating */

test("a probe is blocked with a reason the editor can act on", () => {
  const base = { extensionId: EXT_ID, siteCode: "pos", step: step(), url: "https://pos.v2.circa.vn/trang-chu" };
  assert.equal(probeReadiness(base).ok, true);
  assert.match(probeReadiness({ ...base, extensionId: null }).reason, /extension/i);
  assert.match(probeReadiness({ ...base, siteCode: null }).reason, /site/i);
  assert.match(probeReadiness({ ...base, url: "" }).reason, /URL/i);
  assert.match(probeReadiness({ ...base, step: step({ selectors: ["", "  "] }) }).reason, /selector/i);
});

test("a preview needs a site, a start page and at least one step", () => {
  const base = { extensionId: EXT_ID, siteCode: "pos", steps: [step()], url: "https://pos.v2.circa.vn/trang-chu" };
  assert.equal(previewReadiness(base).ok, true);
  assert.match(previewReadiness({ ...base, steps: [] }).reason, /chưa có bước/i);
  assert.match(previewReadiness({ ...base, siteCode: null }).reason, /site/i);
  assert.match(previewReadiness({ ...base, url: "" }).reason, /trang bắt đầu/i);
});

/* --------------------------------------------------------------- the requests */

test("a probe is keyed by the step it is about", () => {
  // The extension drops a late answer whose probeId is not the current one; using the
  // step id means the Portal files each answer next to the right step.
  const request = probeRequest({
    sessionId: "prb_1",
    guideId: "g1",
    siteCode: "pos",
    step: step(),
    url: "https://pos.v2.circa.vn/trang-chu",
  });
  assert.equal(request.type, "PROBE_SELECTOR");
  assert.equal(request.payload.probeId, "st_1");
  assert.deepEqual(request.payload.step.selectors, ["#basic-button"]);
});

test("preview carries the draft in the message and asks for nothing to be read back", () => {
  // This is what separates "chạy thử" from "publish": the guide on screen travels whole,
  // no database round trip, and there is no release in the payload at all.
  const steps = [step(), step({ id: "st_2", urlPattern: "/don-hang" })];
  const request = previewRequest({
    sessionId: "pvw_1",
    guideId: "g1",
    name: "BÁN HÀNG",
    siteCode: "pos",
    steps,
    url: "https://pos.v2.circa.vn/trang-chu",
    origins: ORIGINS,
  });

  assert.equal(request.type, "PREVIEW_GUIDE");
  assert.deepEqual(request.payload.guide.steps, steps, "bản nháp đi kèm nguyên vẹn");
  assert.equal(request.payload.guide.site, "pos");
  assert.deepEqual(request.payload.sites, ORIGINS, "extension cần origin để so khớp URL của bước");

  const keys = JSON.stringify(request);
  for (const forbidden of ["revision", "release", "publish", "checksum", "supabase"]) {
    assert.ok(!keys.toLowerCase().includes(forbidden), `payload không được nhắc tới ${forbidden}`);
  }
});

/* -------------------------------------------------------------- the verdicts */

test("a step nobody has checked says so rather than looking healthy", () => {
  assert.equal(summarizeProbe(null).tone, "idle");
  assert.equal(summarizeProbe(undefined).tone, "idle");
});

test("resolving through a unique selector is the only unqualified pass", () => {
  assert.equal(summarizeProbe(probeResult()).tone, "ok");
  assert.match(summarizeProbe(probeResult()).label, /đúng 1 element/);
});

test("text narrowing a multi-match is a pass — that is how POS resolves Cài Đặt", () => {
  const verdict = summarizeProbe(
    probeResult({ resolved: { selector: "#basic-button", selectorIndex: 0, via: "text", count: 9 } }),
  );
  assert.equal(verdict.tone, "ok");
  assert.match(verdict.label, /Khớp 9/);
});

test("resolving only by text, or only by taking the first match, is a warning", () => {
  // Both keep working right up until the day they do not, so neither may read as a pass.
  const byText = summarizeProbe(
    probeResult({ resolved: { selector: "button", selectorIndex: -1, via: "text-fallback", count: 1 } }),
  );
  assert.equal(byText.tone, "warn");
  assert.match(byText.detail, /chọn lại phần tử/i);

  const first = summarizeProbe(
    probeResult({ resolved: { selector: "tr.row", selectorIndex: 0, via: "first_item", count: 12 } }),
  );
  assert.equal(first.tone, "warn");
});

test("a failure shows the page's own reason, not a generic one", () => {
  const verdict = summarizeProbe(
    probeResult({ ok: false, resolved: null, reason: "Selector khớp nhiều element và không có element nào đúng text." }),
  );
  assert.equal(verdict.tone, "bad");
  assert.match(verdict.detail, /nhiều element/);
});

test("the candidate counts are shown even when the step resolves fine", () => {
  const verdict = summarizeProbe(
    probeResult({
      candidates: [
        { selector: "#a", count: 0, textMatches: 0, invalid: false },
        { selector: "#b", count: 9, textMatches: 1, invalid: false },
      ],
      resolved: { selector: "#b", selectorIndex: 1, via: "text", count: 9 },
    }),
  );
  assert.match(verdict.detail, /0 \/ 9/);
});

test("an invalid selector is named in the detail line", () => {
  const verdict = summarizeProbe(
    probeResult({ candidates: [{ selector: "button:has(", count: 0, textMatches: 0, invalid: true }] }),
  );
  assert.match(verdict.detail, /lỗi cú pháp/);
});
