import test from "node:test";
import assert from "node:assert/strict";

import {
  FLAGS,
  computeGuideFlags,
  computeStepFlags,
  isStructuralSelector,
  needsPublishConfirmation,
  usesKnownDuplicateId,
} from "../src/flags.ts";

const ZW = String.fromCharCode(0x200b);

const step = (over = {}) => ({
  id: "st_1",
  selectors: ["button.primary"],
  matchText: "Xac nhan",
  tag: "button",
  title: "t",
  content: "c",
  urlPattern: "/ban-hang",
  navigationUrl: "/ban-hang",
  action: { type: "highlight", expectedUrl: "", timeoutMs: 0 },
  ...over,
});

const ctx = (s, over = {}) => ({ index: 0, steps: [s], ...over });

test("a structural selector has no id, class or attribute hook", () => {
  assert.ok(isStructuralSelector("li:nth-of-type(2) > div"));
  assert.ok(!isStructuralSelector("#basic-button"));
  assert.ok(!isStructuralSelector("button.primary"));
  assert.ok(!isStructuralSelector('button[type="submit"]'));
});

test("known duplicate ids are recognised", () => {
  assert.ok(usesKnownDuplicateId("#basic-button"));
  assert.ok(!usesKnownDuplicateId("#c-select"));
});

test("a well anchored step carries no flags", () => {
  const s = step();
  assert.deepEqual(computeStepFlags(s, ctx(s)), []);
});

test("nth-of-type and structural-only are reported separately", () => {
  const s = step({ selectors: ["li:nth-of-type(2) > div"] });
  const f = computeStepFlags(s, ctx(s));
  assert.ok(f.includes(FLAGS.SEL_NTH_OF_TYPE));
  assert.ok(f.includes(FLAGS.SEL_STRUCTURAL_ONLY));
});

test("THE risk combination: auto-click on a structural selector with no text", () => {
  const s = step({
    selectors: ["div:nth-of-type(7) > div:nth-of-type(1)"],
    matchText: "",
    action: { type: "auto_click_wait_url", expectedUrl: "/x", timeoutMs: 0 },
  });
  const f = computeStepFlags(s, ctx(s, { steps: [s, step({ id: "st_2" })] }));
  assert.ok(f.includes(FLAGS.SEL_STRUCTURAL_AND_NO_TEXT));
  assert.ok(f.includes(FLAGS.AUTO_CLICK_UNANCHORED));
});

test("the same selector without auto-click is not the risk combination", () => {
  const s = step({ selectors: ["div:nth-of-type(7)"], matchText: "" });
  const f = computeStepFlags(s, ctx(s));
  assert.ok(f.includes(FLAGS.SEL_STRUCTURAL_AND_NO_TEXT));
  assert.ok(!f.includes(FLAGS.AUTO_CLICK_UNANCHORED));
});

test("a zero-width-only matchText is flagged as the trap it is", () => {
  const s = step({ matchText: "" });
  const f = computeStepFlags(s, ctx(s, { rawMatchText: ZW + ZW }));
  assert.ok(f.includes(FLAGS.MATCH_TEXT_ZERO_WIDTH_ONLY));
  assert.ok(f.includes(FLAGS.NO_TEXT_ANCHOR));
});

test("a genuinely empty matchText is not reported as zero-width", () => {
  const s = step({ matchText: "" });
  const f = computeStepFlags(s, ctx(s, { rawMatchText: "" }));
  assert.ok(!f.includes(FLAGS.MATCH_TEXT_ZERO_WIDTH_ONLY));
});

test("a wait-url action on the last step is flagged", () => {
  const s = step({ action: { type: "auto_click_wait_url", expectedUrl: "", timeoutMs: 0 } });
  const f = computeStepFlags(s, ctx(s));
  assert.ok(f.includes(FLAGS.WAIT_URL_ON_LAST_STEP));
  assert.ok(f.includes(FLAGS.WAIT_URL_NO_TARGET));
});

test("hardcoded record ids and oversized URLs are flagged", () => {
  const s = step({ urlPattern: "/sellback/eligible?pos=e71c515b-38a9-481c-a4f1-84eb640db60d" });
  assert.ok(computeStepFlags(s, ctx(s)).includes(FLAGS.URL_HARDCODED_UUID));

  const long = step({ urlPattern: "/don-hang?filter=" + "x".repeat(700) });
  assert.ok(computeStepFlags(long, ctx(long)).includes(FLAGS.URL_TOO_LONG));
});

test("scrubber flags are carried through", () => {
  const s = step();
  const f = computeStepFlags(s, ctx(s, { extra: [FLAGS.PII_SCRUBBED, FLAGS.URL_UUID_STRIPPED] }));
  assert.ok(f.includes(FLAGS.PII_SCRUBBED));
  assert.ok(f.includes(FLAGS.URL_UUID_STRIPPED));
});

test("guide flags: start URL mismatch and duplicate step titles", () => {
  const guide = {
    name: "QUAN LY TON KHO",
    siteCode: null,
    status: "unassigned",
    startUrl: "/dashboard",
    steps: [step({ urlPattern: "/tai-khoan", title: "xac nhan" }), step({ id: "st_2", title: "xac nhan" })],
  };
  const f = computeGuideFlags(guide);
  assert.ok(f.includes(FLAGS.START_URL_MISMATCH));
  assert.ok(f.includes(FLAGS.DUP_STEP_TITLE));
});

test("guide flags: duplicate name across the corpus", () => {
  const guide = { name: "DANH MUC BANG GIA", siteCode: null, status: "unassigned", startUrl: "/x", steps: [step()] };
  const dupes = new Set(["danh muc bang gia"]);
  assert.ok(computeGuideFlags(guide, { duplicateNames: dupes }).includes(FLAGS.DUP_GUIDE_NAME));
});

test("a guide inherits the publish warning from its steps", () => {
  const risky = step({ flags: [FLAGS.AUTO_CLICK_UNANCHORED] });
  const guide = { name: "G", siteCode: "pos", status: "draft", startUrl: "/x", steps: [risky] };
  guide.flags = computeGuideFlags(guide);
  assert.ok(guide.flags.includes(FLAGS.GUIDE_HAS_AUTO_CLICK_UNANCHORED));
  assert.ok(needsPublishConfirmation(guide), "portal warns, but does not block");
});
