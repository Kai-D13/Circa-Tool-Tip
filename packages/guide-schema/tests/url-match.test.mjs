import test from "node:test";
import assert from "node:assert/strict";

import {
  inferUrlMatchMode,
  meaningfulParams,
  parseLocation,
  patternBase,
  pathBoundaryMatches,
  resolveExpectedUrl,
  resolveStepUrl,
  stepMatchesLocation,
  wildcardToRegExp,
} from "../src/url-match.ts";

const SITES = {
  pos: "https://pos.v2.circa.vn",
  admin: "https://admin.v2.circa.vn",
};

const at = (href) => parseLocation(href);
const step = (over = {}) => ({
  id: "st_x",
  selectors: [],
  matchText: "",
  tag: "",
  title: "",
  content: "",
  urlPattern: "",
  navigationUrl: "",
  action: { type: "highlight", expectedUrl: "", timeoutMs: 0 },
  ...over,
});

test("inferUrlMatchMode reproduces the v4 rules", () => {
  assert.equal(inferUrlMatchMode(""), "");
  assert.equal(inferUrlMatchMode("/trang-chu"), "path");
  assert.equal(inferUrlMatchMode("/don-hang?page=2"), "path_query");
  assert.equal(inferUrlMatchMode("/ban-hang/*"), "wildcard");
  assert.equal(inferUrlMatchMode("/x", "exact"), "exact", "explicit wins");
});

test("path boundary does not bleed across sibling routes", () => {
  assert.ok(pathBoundaryMatches("/ban-hang", "/ban-hang"));
  assert.ok(pathBoundaryMatches("/ban-hang/123", "/ban-hang"));
  assert.ok(!pathBoundaryMatches("/ban-hang-online", "/ban-hang"));
});

test("REGRESSION: wildcard is anchored at the start of the path", () => {
  // v4 built an unanchored regex, so this matched. Plan v1.1 R4.
  assert.ok(!wildcardToRegExp("/ban-hang/*").test("/xx/ban-hang/123"));
  assert.ok(wildcardToRegExp("/ban-hang/*").test("/ban-hang/123"));
  assert.ok(!wildcardToRegExp("/ban-hang/*").test("/ban-hang-online/1"));
});

test("ACCEPTANCE: a wildcarded id matches only a page that carries that parameter", () => {
  // `/sellback/create*` would also match the broken id-less page and `-copy` siblings.
  // Keeping the parameter name is what makes the pattern mean "some record is open".
  const s = step({ site: "pos", urlPattern: "/sellback/create?id=*" });
  const m = (href) => stepMatchesLocation(s, at(href), { sites: SITES });

  assert.ok(m("https://pos.v2.circa.vn/sellback/create?id=98f7f76b-53e0-450c-8843-d557e8145f5a"));
  assert.ok(m("https://pos.v2.circa.vn/sellback/create?id=bat-ky-gia-tri-nao"));
  assert.ok(!m("https://pos.v2.circa.vn/sellback/create"), "trang thiếu id là trang hỏng");
  assert.ok(!m("https://pos.v2.circa.vn/sellback/create-copy"));
  assert.ok(!m("https://pos.v2.circa.vn/sellback/create-copy?id=abc"));
  assert.ok(!m("https://admin.v2.circa.vn/sellback/create?id=abc"), "sai site thì không khớp");
});

test("ACCEPTANCE: a wildcarded store id behaves the same", () => {
  const s = step({ site: "admin", urlPattern: "/sellback/eligible?pos=*" });
  const m = (href) => stepMatchesLocation(s, at(href), { sites: SITES });
  assert.ok(m("https://admin.v2.circa.vn/sellback/eligible?pos=e71c515b-38a9-481c-a4f1-84eb640db60d"));
  assert.ok(!m("https://admin.v2.circa.vn/sellback/eligible"));
});

test("patternBase of a query wildcard is still the path, so the wait chain lines up", () => {
  assert.equal(patternBase("/sellback/create?id=*"), "/sellback/create");
});

test("origin gates the match, so an admin step never fires on POS", () => {
  const adminStep = step({ site: "admin", urlPattern: "/quan-ly-voucher" });
  assert.ok(stepMatchesLocation(adminStep, at("https://admin.v2.circa.vn/quan-ly-voucher"), { sites: SITES }));
  assert.ok(!stepMatchesLocation(adminStep, at("https://pos.v2.circa.vn/quan-ly-voucher"), { sites: SITES }));
});

test("a draft step inherits the guide site; siteOverride wins", () => {
  const inherited = step({ urlPattern: "/trang-chu" });
  assert.ok(stepMatchesLocation(inherited, at("https://pos.v2.circa.vn/trang-chu"), { sites: SITES, guideSite: "pos" }));
  assert.ok(!stepMatchesLocation(inherited, at("https://admin.v2.circa.vn/trang-chu"), { sites: SITES, guideSite: "pos" }));

  const crossing = step({ urlPattern: "/trang-chu", siteOverride: "admin" });
  assert.ok(stepMatchesLocation(crossing, at("https://admin.v2.circa.vn/trang-chu"), { sites: SITES, guideSite: "pos" }));
});

test("an unknown site can never match", () => {
  const orphan = step({ site: "nope", urlPattern: "/x" });
  assert.ok(!stepMatchesLocation(orphan, at("https://pos.v2.circa.vn/x"), { sites: SITES }));
});

test("empty pattern means anywhere on that site", () => {
  const anywhere = step({ site: "pos" });
  assert.ok(stepMatchesLocation(anywhere, at("https://pos.v2.circa.vn/bat-ky"), { sites: SITES }));
  assert.ok(!stepMatchesLocation(anywhere, at("https://admin.v2.circa.vn/bat-ky"), { sites: SITES }));
});

test("path mode ignores the query entirely", () => {
  const s = step({ site: "pos", urlPattern: "/don-hang" });
  assert.ok(stepMatchesLocation(s, at("https://pos.v2.circa.vn/don-hang?page=7&tab=all"), { sites: SITES }));
});

test("path_query requires its params but tolerates extras", () => {
  const s = step({ site: "pos", urlPattern: "/don-hang?tab=cho-xu-ly" });
  assert.ok(stepMatchesLocation(s, at("https://pos.v2.circa.vn/don-hang?tab=cho-xu-ly&page=2"), { sites: SITES }));
  assert.ok(!stepMatchesLocation(s, at("https://pos.v2.circa.vn/don-hang?tab=da-giao"), { sites: SITES }));
  assert.ok(!stepMatchesLocation(s, at("https://pos.v2.circa.vn/don-hang"), { sites: SITES }));
});

test("exact mode rejects extra params", () => {
  const s = step({ site: "pos", urlPattern: "/don-hang?tab=cho-xu-ly", urlMatchMode: "exact" });
  assert.ok(stepMatchesLocation(s, at("https://pos.v2.circa.vn/don-hang?tab=cho-xu-ly"), { sites: SITES }));
  assert.ok(!stepMatchesLocation(s, at("https://pos.v2.circa.vn/don-hang?tab=cho-xu-ly&page=2"), { sites: SITES }));
});

test("volatile and empty params never gate a match", () => {
  const p = meaningfulParams("?page=2&date_from=2026-05-27&keyword=&_t=99");
  assert.deepEqual(p, { page: "2" });
});

test("patternBase stops at the wildcard", () => {
  assert.equal(patternBase("/ban-hang/*"), "/ban-hang");
  assert.equal(patternBase("/quan-ly-deal/them/*"), "/quan-ly-deal/them");
  assert.equal(patternBase("/trang-chu"), "/trang-chu");
});

test("resolveStepUrl uses the step's own site, not the current origin", () => {
  const s = step({ site: "admin", navigationUrl: "/quan-ly-voucher" });
  assert.equal(resolveStepUrl(s, { sites: SITES }), "https://admin.v2.circa.vn/quan-ly-voucher");
});

test("resolveStepUrl refuses to navigate to a wildcard", () => {
  const s = step({ site: "pos", urlPattern: "/ban-hang/*" });
  assert.equal(resolveStepUrl(s, { sites: SITES }), "");
});

test("resolveExpectedUrl falls back to the next step, which is how v4 really behaved", () => {
  const steps = [
    step({ urlPattern: "/trang-chu", action: { type: "auto_click_wait_url", expectedUrl: "", timeoutMs: 0 } }),
    step({ urlPattern: "/ban-hang" }),
  ];
  assert.equal(resolveExpectedUrl(steps, 0), "/ban-hang");
});

test("an explicit expectedUrl wins over the next step", () => {
  const steps = [
    step({ urlPattern: "/a", action: { type: "click_wait_url", expectedUrl: "/explicit", timeoutMs: 0 } }),
    step({ urlPattern: "/b" }),
  ];
  assert.equal(resolveExpectedUrl(steps, 0), "/explicit");
});

test("parseLocation accepts a bare path", () => {
  const loc = parseLocation("/don-hang?page=2#x", "https://pos.v2.circa.vn");
  assert.equal(loc.pathname, "/don-hang");
  assert.equal(loc.search, "?page=2");
  assert.equal(loc.hash, "#x");
  assert.equal(loc.origin, "https://pos.v2.circa.vn");
});
