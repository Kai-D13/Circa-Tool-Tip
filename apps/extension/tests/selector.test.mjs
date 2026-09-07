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

/**
 * selector.js is a classic script that defines globalThis.TG_SELECTOR, because content
 * scripts cannot load ES modules. It is loaded here the same way Chrome loads it: the
 * guide-schema bundle first, then selector.js in the same scope.
 *
 * Built fresh into a scratch directory every run. Reusing dist/unpacked when it happens
 * to exist means the suite can pass against a build made before the fix it is testing —
 * which is exactly how a wrong anchored path stayed green.
 */
function loadSelector() {
  const out = mkdtempSync(join(tmpdir(), "tg-ext-"));
  try {
    execFileSync(process.execPath, [resolve(EXT, "build.mjs"), "--out", out], { stdio: "pipe" });
    const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, URL, console });
    vm.runInContext(readFileSync(resolve(out, "vendor/guide-schema.global.js"), "utf8"), ctx);
    vm.runInContext(readFileSync(resolve(out, "selector.js"), "utf8"), ctx);
    return { api: ctx.TG_SELECTOR, source: readFileSync(resolve(out, "selector.js"), "utf8") };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const { api: S, source: SELECTOR_SOURCE } = loadSelector();

/**
 * The smallest element the module actually touches: a tag, attributes, a parent and
 * siblings. Everything that needs the real document goes through the injected `count`,
 * which is why no DOM implementation is required to test this.
 */
function el(tag, { id, attrs = {}, classes = [], text = "", children = [] } = {}) {
  const all = { ...attrs };
  if (id) all.id = id;
  if (classes.length) all.class = classes.join(" ");

  const node = {
    tagName: tag.toUpperCase(),
    parentElement: null,
    children,
    innerText: text,
    getAttribute: (name) => (name in all ? all[name] : null),
  };
  for (const child of children) child.parentElement = node;
  return node;
}

/** `count` stub: anything not listed resolves to nothing. */
const counter = (map) => (sel) => map[sel] ?? 0;

/** Arrays built inside the vm realm have a different prototype; copy before comparing. */
const plain = (v) => [...v];

/* --------------------------------------------------------------------------------
 * A selector engine small enough to read, real enough to matter.
 *
 * A stub `count` map only proves the module agrees with the test author. It cannot
 * catch a selector that is well-formed and matches NOTHING — which is exactly how the
 * anchored-path order bug survived: every candidate looked plausible, and the stub said
 * whatever the test said it should. These tests resolve candidates against the fake tree
 * for real, so a path that points nowhere fails.
 * ------------------------------------------------------------------------------ */

const QUOTE = String.fromCharCode(34);

function walk(node, out = []) {
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

/**
 * Supports exactly what buildCandidates can emit: #id, [attr="v"], tag, .class,
 * :nth-of-type(n). Written with plain string scanning rather than regular expressions —
 * a parser for selectors, spelled in escapes, is its own source of bugs.
 */
function matchesSimple(node, simple) {
  let s = String(simple).trim();
  if (!s) return false;

  let nth = null;
  const NTH = ":nth-of-type(";
  const nthAt = s.indexOf(NTH);
  if (nthAt >= 0) {
    const close = s.indexOf(")", nthAt);
    nth = Number(s.slice(nthAt + NTH.length, close));
    s = s.slice(0, nthAt) + s.slice(close + 1);
  }

  const attrs = [];
  for (let open = s.indexOf("["); open >= 0; open = s.indexOf("[")) {
    const close = s.indexOf("]", open);
    const inner = s.slice(open + 1, close);
    const eq = inner.indexOf("=");
    const value = inner.slice(eq + 1).trim();
    attrs.push([inner.slice(0, eq), value.startsWith(QUOTE) ? value.slice(1, -1) : value]);
    s = s.slice(0, open) + s.slice(close + 1);
  }

  const readToken = (from) => {
    let end = from + 1;
    while (end < s.length && s[end] !== "." && s[end] !== "#") end++;
    return end;
  };

  let id = null;
  const hash = s.indexOf("#");
  if (hash >= 0) {
    const end = readToken(hash);
    id = s.slice(hash + 1, end);
    s = s.slice(0, hash) + s.slice(end);
  }

  const classes = [];
  for (let dot = s.indexOf("."); dot >= 0; dot = s.indexOf(".")) {
    const end = readToken(dot);
    classes.push(s.slice(dot + 1, end));
    s = s.slice(0, dot) + s.slice(end);
  }

  const tag = s.trim().toLowerCase();
  if (tag && tag !== String(node.tagName).toLowerCase()) return false;
  if (id !== null && node.getAttribute("id") !== id) return false;
  for (const [name, value] of attrs) if (node.getAttribute(name) !== value) return false;
  const own = String(node.getAttribute("class") || "").split(" ").filter(Boolean);
  for (const c of classes) if (!own.includes(c)) return false;
  if (nth !== null && S.nthOfType(node) !== nth) return false;
  return true;
}


/** Only `>` combinators, which is all the module produces. */
function queryAll(all, selector) {
  const parts = String(selector).split(">").map((p) => p.trim());
  return all.filter((node) => {
    let cur = node;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!cur || !matchesSimple(cur, parts[i])) return false;
      if (i > 0) cur = cur.parentElement;
    }
    return true;
  });
}

/** Build a live document: returns the count function and the node list. */
function live(root) {
  const all = walk(root);
  return { all, count: (sel) => queryAll(all, sel).length };
}

/* ------------------------------------------------------------------ stability */

test("generated class names never reach a selector", () => {
  // css-jj9uz9 is a real class measured on POS; it is regenerated on every MUI build.
  for (const bad of ["css-jj9uz9", "css-1a2b3c", "sc-bdVaJa", "jsx-3129847", "emotion-cache-x", "Home_main__nSbtS"]) {
    assert.equal(S.isStableClass(bad), false, `${bad} phải bị loại`);
  }
  for (const good of ["ant-btn", "MuiButton-root", "btn", "nav-item", "px-4"]) {
    assert.equal(S.isStableClass(good), true, `${good} phải được giữ`);
  }
});

test("framework-generated ids are not treated as authored ids", () => {
  for (const bad of [":r1:", ":R2ab:", "radix-42", "headlessui-menu-1", "mui-1234", "12345"]) {
    assert.equal(S.isStableId(bad), false, `${bad} phải bị loại`);
  }
  for (const good of ["basic-button", "login_form", "app-root"]) {
    assert.equal(S.isStableId(good), true);
  }
});

test("an id that is not a plain identifier goes through an attribute selector", () => {
  assert.equal(S.idSelector("basic-button"), "#basic-button");
  assert.equal(S.idSelector("a b"), '[id="a b"]');
  assert.equal(S.idSelector('say"hi'), '[id="say\\"hi"]');
});

/* ------------------------------------------------------------------ candidates */

test("POS REGRESSION: a duplicated id is never the primary candidate", () => {
  // Measured on production: #basic-button exists NINE times on one page, and the v4
  // config pinned 14 steps to it. A picker that trusts an id on sight recreates that.
  // Built as a real tree with nine of them, not a count map: the duplication is the
  // whole point, and a stub would just assert what the test author already believed.
  const button = el("button", { id: "basic-button", text: "Cài Đặt" });
  const twins = Array.from({ length: 8 }, (_, i) => el("button", { id: "basic-button", text: `khác ${i}` }));
  const header = el("header", { id: "app-header", children: [button, ...twins] });
  const { all, count } = live(el("body", { children: [header] }));

  assert.equal(count("#basic-button"), 9, "dựng đúng bối cảnh POS: 9 element trùng id");

  const candidates = plain(S.buildCandidates(button, count));
  assert.notEqual(candidates[0], "#basic-button", "selector chính không được là id trùng 9 lần");
  assert.equal(candidates[0], "#app-header > button:nth-of-type(1)");
  assert.deepEqual(queryAll(all, candidates[0]), [button], "và nó phải trỏ đúng nút đã chọn");
  // The id is still carried, because the runtime narrows a multi-match by matchText and
  // "Cài Đặt" matches exactly one button on POS.
  assert.ok(candidates.includes("#basic-button"));
});

test("a unique id is the primary candidate", () => {
  const input = el("input", { id: "username", attrs: { name: "username" } });
  el("form", { children: [input] });
  const candidates = S.buildCandidates(input, counter({ "#username": 1 }));
  assert.equal(candidates[0], "#username");
});

test("a test hook beats a class, and generated classes are never emitted", () => {
  const button = el("button", {
    attrs: { "data-testid": "submit-order" },
    classes: ["css-jj9uz9", "MuiButton-root"],
    text: "Lưu",
  });
  el("div", { children: [button] });

  const candidates = S.buildCandidates(button, counter({ 'button[data-testid="submit-order"]': 1 }));
  assert.equal(candidates[0], 'button[data-testid="submit-order"]');
  assert.ok(!candidates.some((c) => c.includes("css-jj9uz9")), "class sinh động lọt vào selector");
});

test("a unique class selector stands alone; an ambiguous one gets a fallback", () => {
  const a = el("a", { classes: ["nav-item"], text: "Báo Cáo" });
  el("nav", { children: [a] });
  const unique = plain(S.buildCandidates(a, counter({ "a.nav-item": 1 })));
  assert.deepEqual(unique, ["a.nav-item"], "đã unique thì không kèm đường cấu trúc");

  // Ambiguous is still the primary candidate: the runtime narrows a multi-match by
  // matchText, and "Báo Cáo" is a far better anchor than a position in the tree. But a
  // structural path now rides along, because text is the only thing disambiguating.
  const b = el("a", { classes: ["nav-item"], text: "Báo Cáo" });
  el("nav", { children: [b] });
  const many = plain(S.buildCandidates(b, counter({ "a.nav-item": 12 })));
  assert.equal(many[0], "a.nav-item");
  assert.ok(
    many.some((c) => c.includes(":nth-of-type(")),
    "không có selector nào unique thì phải kèm đường cấu trúc dự phòng",
  );
});

test("the structural path is the last resort, not the first", () => {
  const span = el("span", { text: "x" });
  const div = el("div", { children: [span] });
  const body = el("body", { children: [div] });
  assert.ok(body);

  const candidates = plain(S.buildCandidates(span, counter({})));
  assert.deepEqual(candidates, ["body > div:nth-of-type(1) > span:nth-of-type(1)"]);
});

test("nth-of-type counts only siblings sharing the tag", () => {
  const first = el("li", { text: "a" });
  const span = el("span", { text: "-" });
  const second = el("li", { text: "b" });
  el("ul", { children: [first, span, second] });

  assert.equal(S.nthOfType(first), 1);
  assert.equal(S.nthOfType(second), 2, "span ở giữa không được tính vào chỉ số của li");
});

test("candidates are deduplicated and capped", () => {
  const button = el("button", {
    id: "save",
    attrs: { "data-testid": "save", name: "save", "aria-label": "Lưu", placeholder: "Lưu" },
    classes: ["btn"],
    text: "Lưu",
  });
  el("div", { id: "panel", children: [button] });

  const candidates = S.buildCandidates(
    button,
    counter({
      "#save": 1,
      'button[data-testid="save"]': 1,
      'button[name="save"]': 1,
      'button[aria-label="Lưu"]': 1,
      'button[placeholder="Lưu"]': 1,
      "button.btn": 1,
      "#panel": 1,
    }),
  );
  assert.equal(candidates.length, S.MAX_CANDIDATES);
  assert.equal(new Set(candidates).size, candidates.length);
  assert.equal(candidates[0], "#save");
});

/* ------------------------------------------------------------------- element */

test("clicking a label picks the button around it", () => {
  const span = el("span", { text: "Cài Đặt" });
  const button = el("button", { id: "basic-button", children: [span] });
  el("header", { children: [button] });

  assert.equal(S.interactiveTarget(span), button);
  assert.equal(S.interactiveTarget(button), button);
});

test("a role is as good as a tag for deciding what is clickable", () => {
  const inner = el("span", { text: "Mở" });
  const clickable = el("div", { attrs: { role: "button" }, children: [inner] });
  el("div", { children: [clickable] });
  assert.equal(S.interactiveTarget(inner), clickable);
});

test("a plain container is described as itself, not as some distant ancestor", () => {
  const leaf = el("p", { text: "chỉ là chữ" });
  const l1 = el("div", { children: [leaf] });
  const l2 = el("div", { children: [l1] });
  const l3 = el("div", { children: [l2] });
  el("div", { children: [l3] });
  assert.equal(S.interactiveTarget(leaf), leaf);
});

/* ---------------------------------------------------------------------- text */

test("matchText is normalised the same way the matcher compares it", () => {
  const button = el("button", { text: "  Cài​   Đặt \n" });
  assert.equal(S.pickText(button), "Cài Đặt");
});

test("matchText is never truncated — a cut-off anchor matches nothing", () => {
  const long = "x".repeat(S.MAX_TEXT + 1);
  const div = el("div", { text: long, attrs: { "aria-label": "Bảng giá" } });
  assert.equal(S.pickText(div), "Bảng giá", "text quá dài phải nhường cho nhãn, không được cắt");

  const noLabel = el("div", { text: long });
  assert.equal(S.pickText(noLabel), "", "không có anchor thì để rỗng, không cắt chuỗi");
});

test("describe returns exactly the fields a recorded step needs", () => {
  const button = el("button", { id: "save", text: "Lưu" });
  el("div", { children: [button] });
  const described = S.describe(button, counter({ "#save": 1 }));
  assert.deepEqual(Object.keys(described).sort(), ["matchText", "selectors", "tag"]);
  assert.equal(described.tag, "button");
  assert.equal(described.matchText, "Lưu");
  assert.deepEqual(plain(described.selectors), ["#save"]);
});

test("a broken count function cannot break the picker", () => {
  const button = el("button", { id: "save", text: "Lưu" });
  el("div", { children: [button] });
  const candidates = S.buildCandidates(button, () => {
    throw new Error("querySelectorAll nổ");
  });
  assert.ok(candidates.length > 0, "vẫn phải có selector cấu trúc để dùng");
});

test("the module refuses to invent its own text normalisation", () => {
  // If the schema bundle is missing, matchText must fail loudly. A second, drifting
  // definition of normalizeText is exactly what this rebuild exists to remove.
  const bare = vm.createContext({ console });
  vm.runInContext(SELECTOR_SOURCE, bare);
  assert.throws(
    () => bare.TG_SELECTOR.pickText({ tagName: "B", innerText: "x", getAttribute: () => null }),
    /GUIDE_SCHEMA/,
  );
});

/* ------------------------------- P0: anchored path phải trỏ đúng element đã chọn */

test("P0 REGRESSION: an anchor two levels up produces a path that actually matches", () => {
  // #stable-anchor > div > span. The trail holds the nodes BELOW the node being walked,
  // so the walked node has to be prepended: appending it produced
  // "#stable-anchor > span:nth-of-type(1) > div:nth-of-type(1)" — well-formed, and
  // matching nothing at all.
  const target = el("span", { text: "Xem" });
  const mid = el("div", { children: [target] });
  const anchor = el("div", { id: "stable-anchor", children: [mid] });
  const { all, count } = live(el("body", { children: [anchor] }));

  const candidates = plain(S.buildCandidates(target, count));
  assert.equal(candidates[0], "#stable-anchor > div:nth-of-type(1) > span:nth-of-type(1)");
  assert.deepEqual(queryAll(all, candidates[0]), [target], "selector chính phải trỏ đúng element đã chọn");
});

test("P0 REGRESSION: an anchor three levels up still resolves", () => {
  const target = el("button", { text: "Lưu" });
  const l1 = el("div", { children: [target] });
  const l2 = el("section", { children: [l1] });
  const anchor = el("div", { id: "panel", children: [l2] });
  const { all, count } = live(el("body", { children: [anchor] }));

  const candidates = plain(S.buildCandidates(target, count));
  assert.equal(candidates[0], "#panel > section:nth-of-type(1) > div:nth-of-type(1) > button:nth-of-type(1)");
  assert.deepEqual(queryAll(all, candidates[0]), [target]);
});

test("P0 REGRESSION: no candidate is ever a selector that matches nothing", () => {
  // The structural fallback used to hide a broken anchored path: the step still resolved,
  // so nothing failed, and the guide silently depended on tree position instead.
  const shapes = [];

  // deep nesting under a stable anchor
  const deep = el("span", { text: "a" });
  shapes.push([deep, el("body", { children: [el("div", { id: "root-a", children: [el("div", { children: [el("div", { children: [deep] })] })] })] })]);

  // a duplicated id, like POS #basic-button
  const dup = el("button", { id: "basic-button", text: "Cài Đặt" });
  const dup2 = el("button", { id: "basic-button", text: "Báo Cáo" });
  shapes.push([dup, el("body", { children: [el("header", { id: "hdr", children: [dup, dup2] })] })]);

  // nothing stable anywhere
  const bare = el("span", { text: "x" });
  shapes.push([bare, el("body", { children: [el("div", { children: [el("div", { children: [bare] })] })] })]);

  // an anchor that is itself several tags deep with siblings in the way
  const target = el("a", { classes: ["nav-item"], text: "Đơn hàng" });
  shapes.push([
    target,
    el("body", {
      children: [
        el("nav", {
          id: "side-nav",
          children: [el("hr"), el("a", { classes: ["nav-item"], text: "Trang chủ" }), target],
        }),
      ],
    }),
  ]);

  for (const [picked, root] of shapes) {
    const { all, count } = live(root);
    const candidates = plain(S.buildCandidates(picked, count));
    assert.ok(candidates.length > 0, "phải có ít nhất một candidate");
    for (const c of candidates) {
      assert.ok(count(c) >= 1, `selector "${c}" khớp 0 element`);
    }
    // And the first one must actually be the element the operator picked.
    assert.ok(queryAll(all, candidates[0]).includes(picked), `candidate đầu không chứa element đã chọn: ${candidates[0]}`);
  }
});

test("the structural fallback resolves too", () => {
  const target = el("span", { text: "x" });
  const { all, count } = live(el("body", { children: [el("div", { children: [el("div", { children: [target] })] })] }));
  const candidates = plain(S.buildCandidates(target, count));
  assert.deepEqual(queryAll(all, candidates[candidates.length - 1]), [target]);
});
