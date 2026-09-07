import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, "..");

/** Built fresh, never reused from dist/unpacked — a stale build certifies nothing. */
function loadResolve() {
  const out = mkdtempSync(join(tmpdir(), "tg-ext-"));
  try {
    execFileSync(process.execPath, [resolve(EXT, "build.mjs"), "--out", out], { stdio: "pipe" });
    const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, URL, console });
    vm.runInContext(readFileSync(resolve(out, "vendor/guide-schema.global.js"), "utf8"), ctx);
    const source = readFileSync(resolve(out, "resolve.js"), "utf8");
    vm.runInContext(source, ctx);
    return { api: ctx.TG_RESOLVE, source };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const { api: R, source: RESOLVE_SOURCE } = loadResolve();

/**
 * An element is only ever asked three things by the resolver, so that is all it is here.
 * Everything that needs the document arrives through the injected api, which is the
 * point: probe and the tour runtime share this code and neither owns a DOM.
 */
const el = (text, opts = {}) => ({ text, hidden: !!opts.hidden, tag: opts.tag ?? "button" });

function api(matches, { invalid = [] } = {}) {
  return {
    queryAll(selector) {
      if (invalid.includes(selector)) throw new SyntaxError("selector không hợp lệ");
      return matches[selector] ?? [];
    },
    textOf: (e) => e.text ?? "",
    isVisible: (e) => !e.hidden,
  };
}

const step = (over = {}) => ({
  selectors: ["#basic-button"],
  matchText: "Cài Đặt",
  tag: "button",
  ...over,
});

/* ------------------------------------------------------------------- resolving */

test("a selector that finds exactly one element, with agreeing text, resolves", () => {
  const target = el("Cài Đặt");
  const found = R.resolveTarget(step(), api({ "#basic-button": [target] }));
  assert.equal(found.element, target);
  assert.equal(found.via, "selector");
  assert.equal(found.count, 1);
});

test("a step with no text anchor trusts a unique selector", () => {
  const target = el("bất kỳ");
  const found = R.resolveTarget(step({ matchText: "" }), api({ "#basic-button": [target] }));
  assert.equal(found.element, target);
  assert.equal(found.via, "selector");
});

test("POS: text picks one element out of nine that share an id", () => {
  // Measured on production: #basic-button matches nine elements, and "Cài Đặt" matches
  // exactly one of them. A resolver that treats "nhiều element" as failure cannot run
  // this guide at all.
  const wanted = el("Cài Đặt");
  const nine = [el("Báo Cáo"), wanted, el("Hỗ Trợ"), el("A"), el("B"), el("C"), el("D"), el("E"), el("F")];
  const found = R.resolveTarget(step(), api({ "#basic-button": nine }));
  assert.equal(found.element, wanted);
  assert.equal(found.via, "text");
  assert.equal(found.count, 9, "count là số element selector thật sự khớp");
});

test("hidden duplicates lose to the visible one", () => {
  const visible = el("Cài Đặt");
  const pool = [el("Cài Đặt", { hidden: true }), visible, el("Cài Đặt", { hidden: true })];
  const found = R.resolveTarget(step(), api({ "#basic-button": pool }));
  assert.equal(found.element, visible);
});

test("a later candidate is used when the first finds nothing", () => {
  const target = el("Cài Đặt");
  const found = R.resolveTarget(
    step({ selectors: ["#khong-co", "header > button:nth-of-type(1)"] }),
    api({ "header > button:nth-of-type(1)": [target] }),
  );
  assert.equal(found.element, target);
  assert.equal(found.selectorIndex, 1);
});

test("an ambiguous candidate is skipped rather than guessed at", () => {
  // Guessing here is how a business auto-click lands on the wrong row.
  const good = el("Cài Đặt");
  const found = R.resolveTarget(
    step({ selectors: ["button.item", "#dung"] }),
    api({ "button.item": [el("A"), el("B")], "#dung": [good] }),
  );
  assert.equal(found.element, good);
  assert.equal(found.via, "selector");
});

test("intent first_item takes the first of many on purpose", () => {
  const first = el("Dòng 1");
  const found = R.resolveTarget(
    step({ matchText: "", intent: "first_item", selectors: ["tr.row"] }),
    api({ "tr.row": [first, el("Dòng 2")] }),
  );
  assert.equal(found.element, first);
  assert.equal(found.via, "first_item");
});

test("a unique selector whose text disagrees is reported, not silently accepted", () => {
  // The page changed under the guide. Pointing the operator at the wrong control is
  // worse than telling them the anchor no longer matches.
  const moved = el("Thiết Lập");
  const found = R.resolveTarget(step(), api({ "#basic-button": [moved] }));
  assert.equal(found.element, moved);
  assert.equal(found.via, "selector-text-mismatch");

  const report = R.probeStep(step(), api({ "#basic-button": [moved] }));
  assert.equal(report.ok, false, "text lệch thì không được báo là đạt");
  assert.match(report.reason, /text/i);
});

test("the text anchor alone finds an element after a redesign moved it", () => {
  const target = el("Cài Đặt");
  const found = R.resolveTarget(step({ selectors: ["#da-doi"] }), api({ button: [el("Khác"), target] }));
  assert.equal(found.element, target);
  assert.equal(found.via, "text-fallback");
});

test("the text fallback refuses when the label is not unique either", () => {
  const found = R.resolveTarget(step({ selectors: ["#da-doi"] }), api({ button: [el("Cài Đặt"), el("Cài Đặt")] }));
  assert.equal(found, null);
});

test("text is compared the way the matcher compares it", () => {
  const target = el("  Cài​   Đặt \n");
  const found = R.resolveTarget(step(), api({ "#basic-button": [target] }));
  assert.equal(found.via, "selector");
});

test("an invalid selector does not stop the next candidate from working", () => {
  const target = el("Cài Đặt");
  const found = R.resolveTarget(
    step({ selectors: ["button:has(", "#dung"] }),
    api({ "#dung": [target] }, { invalid: ["button:has("] }),
  );
  assert.equal(found.element, target);
});

/* ---------------------------------------------------------------------- probe */

test("the probe reports the raw match count a person can reproduce in the Console", () => {
  // Filtering by visibility first would make the report disagree with
  // document.querySelectorAll, which is what the operator will type to check.
  const report = R.probeStep(step(), api({ "#basic-button": [el("Cài Đặt"), el("X", { hidden: true })] }));
  assert.equal(report.candidates[0].count, 2, "count là số element thô, không lọc theo hiển thị");
  assert.equal(report.candidates[0].textMatches, 1);
  assert.equal(report.ok, true);
  // Only one of the two is visible, so the resolver never needed the text to choose.
  assert.equal(report.resolved.via, "selector");
});

test("the probe lists every candidate, in order, even the ones that find nothing", () => {
  const report = R.probeStep(
    step({ selectors: ["#a", "#b", "#c"] }),
    api({ "#b": [el("Cài Đặt")] }),
  );
  assert.deepEqual(
    Array.from(report.candidates, (c) => [c.selector, c.count]),
    [
      ["#a", 0],
      ["#b", 1],
      ["#c", 0],
    ],
  );
  assert.equal(report.resolved.selectorIndex, 1);
});

test("an invalid selector is named as such, not counted as zero matches", () => {
  const report = R.probeStep(step({ selectors: ["button:has("] }), api({}, { invalid: ["button:has("] }));
  assert.equal(report.candidates[0].invalid, true);
  assert.equal(report.ok, false);
  assert.match(report.reason, /cú pháp/i);
});

test("a step with no selectors says so instead of failing vaguely", () => {
  const report = R.probeStep(step({ selectors: [], matchText: "" }), api({}));
  assert.equal(report.ok, false);
  assert.match(report.reason, /chưa có selector/i);
});

test("nothing found anywhere is a different message from ambiguous", () => {
  const nothing = R.probeStep(step({ matchText: "" }), api({}));
  assert.match(nothing.reason, /không selector nào tìm thấy/i);

  const ambiguous = R.probeStep(step({ matchText: "" }), api({ "#basic-button": [el("A"), el("B")] }));
  assert.match(ambiguous.reason, /nhiều element/i);
});

test("duplicate and blank selectors are ignored rather than probed twice", () => {
  const report = R.probeStep(step({ selectors: ["#a", " #a ", "", "  "] }), api({ "#a": [el("Cài Đặt")] }));
  assert.equal(report.candidates.length, 1);
});

test("probe and the runtime never disagree about which candidate wins", () => {
  // A probe that used its own resolution rules would be a lie: it would report a step as
  // fine that the tour then fails to resolve.
  const cases = [
    { matches: { "#a": [el("Cài Đặt")] }, selectors: ["#a"] },
    { matches: { "#a": [el("X"), el("Cài Đặt")] }, selectors: ["#a"] },
    { matches: { "#a": [], "#b": [el("Cài Đặt")] }, selectors: ["#a", "#b"] },
    { matches: { button: [el("Cài Đặt")] }, selectors: ["#khong-co"] },
  ];
  for (const c of cases) {
    const s = step({ selectors: c.selectors });
    const direct = R.resolveTarget(s, api(c.matches));
    const report = R.probeStep(s, api(c.matches));
    assert.equal(report.resolved?.selector, direct?.selector);
    assert.equal(report.resolved?.via, direct?.via);
  }
});

test("the module refuses to invent its own text normalisation", () => {
  const bare = vm.createContext({ console });
  vm.runInContext(RESOLVE_SOURCE, bare);
  assert.throws(
    () => bare.TG_RESOLVE.resolveTarget({ selectors: ["#a"], matchText: "x" }, { queryAll: () => [], textOf: () => "", isVisible: () => true }),
    /GUIDE_SCHEMA/,
  );
});
