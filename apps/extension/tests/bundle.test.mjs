import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import * as SRC from "../../../packages/guide-schema/src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, "..");

/**
 * The extension gets guide-schema through a generated single-file bundle. That bundle is
 * hand-rolled (no bundler), so these tests exist to prove it is not a second, drifting
 * copy of the schema: same export list, same behaviour, for the functions the runtime
 * actually depends on.
 */
function loadBundle() {
  // Built fresh, never reused from dist/unpacked: a bundle left over from an earlier
  // build would let this suite certify code that is no longer what the build produces.
  const out = mkdtempSync(join(tmpdir(), "tg-ext-"));
  try {
    execFileSync(process.execPath, [resolve(EXT, "build.mjs"), "--out", out], { stdio: "pipe" });
    const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, URL, console });
    const source = readFileSync(resolve(out, "vendor/guide-schema.global.js"), "utf8");
    vm.runInContext(source, ctx);
    return { api: ctx.GUIDE_SCHEMA, source };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const { api: G, source: BUNDLE_SOURCE } = loadBundle();

/**
 * Values built inside the vm realm have different prototypes, and deepStrictEqual
 * compares prototypes — so cross-realm results are normalised through JSON before
 * being compared. The comparison stays structural; only the realm is neutralised.
 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Runtime values only — TypeScript types are erased and never reach the bundle. */
const sourceRuntimeNames = Object.keys(SRC)
  .filter((k) => typeof SRC[k] === "function" || typeof SRC[k] === "object" || typeof SRC[k] === "string" || typeof SRC[k] === "number")
  .sort();

test("the bundle exports exactly what the package exports at runtime", () => {
  assert.deepEqual(Object.keys(G).sort(), sourceRuntimeNames);
});

test("the bundle is frozen, so nothing can monkey-patch the schema at runtime", () => {
  assert.ok(Object.isFrozen(G));
});

test("URL matching behaves identically to the source", () => {
  const sites = { pos: "https://pos.v2.circa.vn", admin: "https://admin.v2.circa.vn" };
  const step = {
    id: "st_1", site: "pos", selectors: [], matchText: "", tag: "", title: "", content: "",
    urlPattern: "/sellback/create?id=*", navigationUrl: "",
    action: { type: "highlight", expectedUrl: "", timeoutMs: 0 },
  };
  const cases = [
    "https://pos.v2.circa.vn/sellback/create?id=abc",
    "https://pos.v2.circa.vn/sellback/create",
    "https://pos.v2.circa.vn/sellback/create-copy?id=abc",
    "https://admin.v2.circa.vn/sellback/create?id=abc",
  ];
  for (const href of cases) {
    const loc = SRC.parseLocation(href);
    assert.equal(
      G.stepMatchesLocation(step, G.parseLocation(href), { sites }),
      SRC.stepMatchesLocation(step, loc, { sites }),
      `khác kết quả ở ${href}`,
    );
  }
  // And the anchoring rule really is in the bundle, not just in the source.
  assert.equal(G.stepMatchesLocation(step, G.parseLocation(cases[1]), { sites }), false);
});

test("normalisation behaves identically to the source", () => {
  const raw = {
    selector: "button.a",
    selectorCandidates: ["button.a", "form > button:nth-of-type(1)"],
    matchText: "  Xác nhận  ",
    tag: "button",
    intent: "exact",
    position: "auto",
    title: "t",
    content: "c",
    urlPattern: "/ban-hang",
    navigationUrl: "/ban-hang",
    urlMatchMode: "path",
    action: { type: "auto_click_wait_url", expectedUrl: "", timeoutMs: 0 },
  };
  assert.deepEqual(
    plain(G.normalizeDraftStep(raw, { id: "st_1" })),
    plain(SRC.normalizeDraftStep(raw, { id: "st_1" })),
  );
});

test("validation behaves identically to the source", () => {
  const guide = {
    name: "G", siteCode: "pos", status: "draft", startUrl: "/trang-chu",
    steps: [
      {
        id: "st_1", selectors: [], matchText: "", tag: "", title: "", content: "",
        urlPattern: "/trang-chu", navigationUrl: "",
        action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 0 },
      },
    ],
  };
  const opts = { knownSites: ["pos", "admin"], requireSite: true };
  assert.deepEqual(plain(G.validateDraftGuide(guide, opts)), plain(SRC.validateDraftGuide(guide, opts)));
});

test("text normalisation behaves identically, including zero-width handling", () => {
  const zw = String.fromCharCode(0x200b);
  for (const input of ["  Cài  Đặt ", zw + " " + zw, "Hỗ Trợ", "POS Tools"]) {
    assert.equal(G.normalizeText(input), SRC.normalizeText(input));
    assert.equal(G.normalizeSearchText(input), SRC.normalizeSearchText(input));
    assert.equal(G.isBlankAnchor(input), SRC.isBlankAnchor(input));
  }
});

test("the async checksum works inside the bundle's sandbox too", async () => {
  const json = G.canonicalJson({ b: 1, a: 2 });
  assert.equal(json, SRC.canonicalJson({ b: 1, a: 2 }));
  assert.equal(await G.sha256Tagged(json), await SRC.sha256Tagged(json));
});

test("constants match, so the extension cannot disagree about schema version", () => {
  assert.equal(G.SCHEMA_VERSION, SRC.SCHEMA_VERSION);
  assert.deepEqual(plain(G.ACTION_TYPES), plain(SRC.ACTION_TYPES));
  assert.deepEqual(plain(G.FLAGS), plain(SRC.FLAGS));
});

test("the bundle carries no import/export statements left over from the modules", () => {
  const src = BUNDLE_SOURCE;
  assert.ok(!/^\s*import\s/m.test(src), "còn sót import");
  assert.ok(!/^\s*export\s/m.test(src), "còn sót export");
});
