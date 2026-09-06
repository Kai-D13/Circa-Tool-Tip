#!/usr/bin/env node
/**
 * Build the unpacked extension into apps/extension/dist/unpacked.
 *
 *   node apps/extension/build.mjs            # dev build (localhost portal)
 *   node apps/extension/build.mjs --release https://circa-tool-tip.vercel.app
 *   node apps/extension/build.mjs --out /tmp/x   # build vào thư mục khác
 *
 * Two jobs:
 *
 * 1. Bundle `packages/guide-schema` into one classic script that defines
 *    `globalThis.GUIDE_SCHEMA`. The extension MUST NOT carry a second copy of the
 *    validator or the URL matcher — that is exactly how the v2.4.9 extension ended up
 *    with two matchers that disagreed.
 *
 *    No bundler is involved. `node:module.stripTypeScriptTypes` removes the types, the
 *    import graph is resolved here, and the modules are concatenated in topological
 *    order into a single scope. That works because guide-schema has zero external
 *    dependencies and only relative `./x.ts` imports — build() asserts both.
 *
 * 2. Copy the manifest and sources, rewriting `externally_connectable` for the target.
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const SCHEMA_SRC = resolve(REPO, "packages/guide-schema/src");
const DEFAULT_OUT = resolve(HERE, "dist/unpacked");

const RELATIVE_IMPORT = /^\s*import\s+(?:type\s+)?[\s\S]*?from\s+"(\.[^"]+)";?\s*$/gm;
const ANY_IMPORT = /^\s*import\s/m;
const EXPORTED_DECL = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

/** Module dependencies, from the relative imports in the (still typed) source. */
function depsOf(source) {
  const deps = [];
  for (const m of source.matchAll(RELATIVE_IMPORT)) {
    const name = m[1].replace(/^\.\//, "").replace(/\.ts$/, "");
    if (!deps.includes(name)) deps.push(name);
  }
  return deps;
}

function topoSort(modules) {
  const order = [];
  const state = new Map(); // name -> "visiting" | "done"

  const visit = (name, trail) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      throw new Error(`Import vòng tròn trong guide-schema: ${[...trail, name].join(" -> ")}`);
    }
    state.set(name, "visiting");
    for (const dep of modules.get(name).deps) {
      if (!modules.has(dep)) throw new Error(`${name}.ts import "${dep}" nhưng không có file đó`);
      visit(dep, [...trail, name]);
    }
    state.set(name, "done");
    order.push(name);
  };

  for (const name of modules.keys()) visit(name, []);
  return order;
}

function bundleGuideSchema() {
  const files = readdirSync(SCHEMA_SRC)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => f.replace(/\.ts$/, ""));

  const modules = new Map();
  for (const name of files) {
    const source = readFileSync(resolve(SCHEMA_SRC, `${name}.ts`), "utf8");
    modules.set(name, { source, deps: depsOf(source) });
  }

  const order = topoSort(modules);
  const exported = new Set();
  const chunks = [];

  for (const name of order) {
    // Types first, then drop the (now blank) type imports and the value imports: after
    // concatenation every name already lives in the same scope.
    let code = stripTypeScriptTypes(modules.get(name).source, { mode: "strip" });
    code = code.replace(RELATIVE_IMPORT, "");

    if (ANY_IMPORT.test(code)) {
      throw new Error(`${name}.ts còn import không phải tương đối — bundler này không xử lý dependency ngoài`);
    }

    for (const m of code.matchAll(EXPORTED_DECL)) exported.add(m[1]);
    code = code.replace(/^export\s+/gm, "");
    chunks.push(`  // ---- ${name}.ts ----\n${code}`);
  }

  const names = [...exported].sort();
  return `/* Sinh tự động bởi apps/extension/build.mjs — ĐỪNG sửa tay.
 * Nguồn: packages/guide-schema/src (${order.length} module, ${names.length} export).
 * Sửa schema thì sửa ở package rồi build lại. */
(function (root) {
  "use strict";

${chunks.join("\n")}

  root.GUIDE_SCHEMA = Object.freeze({
${names.map((n) => `    ${n},`).join("\n")}
  });
})(typeof globalThis !== "undefined" ? globalThis : self);
`;
}

function main() {
  const argv = process.argv.slice(2);
  const releaseAt = argv.indexOf("--release");
  const portalOrigin = releaseAt >= 0 ? argv[releaseAt + 1] : null;
  const outAt = argv.indexOf("--out");
  // --out lets a test build into a temp directory instead of clobbering dist/.
  const OUT = outAt >= 0 ? resolve(argv[outAt + 1]) : DEFAULT_OUT;

  if (releaseAt >= 0) {
    if (!portalOrigin || !/^https:\/\/[a-z0-9.-]+$/i.test(portalOrigin)) {
      throw new Error("--release cần một origin https cụ thể, ví dụ https://circa-tool-tip.vercel.app");
    }
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(resolve(OUT, "vendor"), { recursive: true });

  writeFileSync(resolve(OUT, "vendor/guide-schema.global.js"), bundleGuideSchema(), "utf8");

  for (const f of readdirSync(resolve(HERE, "src"))) {
    cpSync(resolve(HERE, "src", f), resolve(OUT, f));
  }
  // default_locale in the manifest makes _locales mandatory — Chrome refuses to load
  // the extension without it.
  cpSync(resolve(HERE, "_locales"), resolve(OUT, "_locales"), { recursive: true });

  const manifest = JSON.parse(readFileSync(resolve(HERE, "manifest.json"), "utf8"));
  if (portalOrigin) {
    manifest.name = "Circa Tool-tip";
    manifest.externally_connectable = { matches: [`${portalOrigin}/*`] };
  }

  const localhostLeft = manifest.externally_connectable.matches.some((m) => m.includes("localhost"));
  if (portalOrigin && localhostLeft) throw new Error("Bản release không được còn localhost trong externally_connectable");
  if (!portalOrigin && !localhostLeft) throw new Error("Bản dev phải có localhost trong externally_connectable");

  writeFileSync(resolve(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(`Đã build: ${OUT}`);
  console.log(`  chế độ    : ${portalOrigin ? "release -> " + portalOrigin : "dev -> localhost"}`);
  console.log(`  portal    : ${manifest.externally_connectable.matches.join(", ")}`);
  console.log(`  content   : ${manifest.content_scripts[0].matches.join(", ")}`);
  console.log("\nChrome -> chrome://extensions -> Developer mode -> Load unpacked -> chọn thư mục trên.");
}

main();
