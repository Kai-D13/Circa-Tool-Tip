import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveOutDir } from "../build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = resolve(HERE, "../build.mjs");
const SRC_MANIFEST = JSON.parse(readFileSync(resolve(HERE, "../manifest.json"), "utf8"));

/** Build into a throwaway directory so tests never clobber dist/ or race each other. */
function buildTo(args = []) {
  const out = mkdtempSync(join(tmpdir(), "tg-ext-"));
  execFileSync(process.execPath, [BUILD, "--out", out, ...args], { stdio: "pipe" });
  return {
    out,
    manifest: JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")),
    cleanup: () => rmSync(out, { recursive: true, force: true }),
  };
}

test("a dev build points the portal at localhost and nothing else", () => {
  const b = buildTo();
  try {
    assert.deepEqual(b.manifest.externally_connectable.matches, ["http://localhost/*"]);
  } finally {
    b.cleanup();
  }
});

test("a release build replaces localhost with exactly one production origin", () => {
  const b = buildTo(["--release", "https://circa-tool-tip.vercel.app"]);
  try {
    assert.deepEqual(b.manifest.externally_connectable.matches, ["https://circa-tool-tip.vercel.app/*"]);
    assert.ok(!JSON.stringify(b.manifest).includes("localhost"), "bản release không được còn localhost");
    assert.equal(b.manifest.name, "Circa Tool-tip", "bỏ hậu tố (dev)");
  } finally {
    b.cleanup();
  }
});

test("a release build refuses a wildcard or non-https portal origin", () => {
  // externally_connectable cannot match a public-suffix wildcard, and http would ship a
  // production build that trusts a plaintext origin.
  for (const bad of ["https://*.vercel.app", "http://circa-tool-tip.vercel.app", "vercel.app", ""]) {
    assert.throws(() => buildTo(["--release", bad]), /release cần một origin https/);
  }
  assert.throws(() => buildTo(["--release"]), /release cần một origin https/);
});

test("the built manifest keeps the two production content-script origins", () => {
  const b = buildTo();
  try {
    assert.deepEqual(b.manifest.content_scripts[0].matches, [
      "https://pos.v2.circa.vn/*",
      "https://admin.v2.circa.vn/*",
    ]);
    assert.deepEqual(b.manifest.host_permissions, [
      "https://pos.v2.circa.vn/*",
      "https://admin.v2.circa.vn/*",
    ]);
  } finally {
    b.cleanup();
  }
});

test("permissions stay minimal — no tabs, no <all_urls>", () => {
  // `tabs` is only needed to read url/title, which the recorder gets from the content
  // script instead; asking for it would add a Web Store review warning for nothing.
  assert.deepEqual(SRC_MANIFEST.permissions, ["storage"]);
  assert.ok(!JSON.stringify(SRC_MANIFEST).includes("<all_urls>"));
  assert.ok(!SRC_MANIFEST.permissions.includes("tabs"));
});

test("every file the manifest references is actually built", () => {
  const b = buildTo();
  try {
    const referenced = [
      b.manifest.background.service_worker,
      ...b.manifest.content_scripts.flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
      `_locales/${b.manifest.default_locale}/messages.json`,
    ];
    for (const rel of referenced) {
      assert.doesNotThrow(() => readFileSync(join(b.out, rel)), `thiếu file ${rel}`);
    }
  } finally {
    b.cleanup();
  }
});

test("the service worker is a module, so it can import the shared schema", () => {
  assert.equal(SRC_MANIFEST.background.type, "module");
});

/* ------------------------------------------------- P0: --out không được xoá nhầm */

test("P0: --out refuses paths whose deletion would take the repo with it", () => {
  // main() bắt đầu bằng rmSync(OUT, { recursive: true, force: true }), nên một --out
  // được tin tưởng mù quáng là một lệnh xoá repo.
  for (const bad of [".", "..", "../..", resolve(HERE, "../../.."), resolve(HERE, ".."), resolve(HERE, "../../../..")]) {
    assert.throws(() => resolveOutDir(["--out", bad]), /từ chối/, `${bad} phải bị từ chối`);
  }
});

test("P0: --out refuses anything outside the OS temp directory", () => {
  assert.throws(() => resolveOutDir(["--out", resolve(HERE, "cho-nay")]), /thư mục tạm/);
  assert.throws(() => resolveOutDir(["--out", join(tmpdir(), "khong-dung-prefix")]), /tg-ext-/);
});

test("P0: --out requires a value", () => {
  assert.throws(() => resolveOutDir(["--out"]), /cần một đường dẫn/);
  assert.throws(() => resolveOutDir(["--out", "--release"]), /cần một đường dẫn/);
});

test("--out accepts the default output dir and a tg-ext- scratch dir", () => {
  assert.doesNotThrow(() => resolveOutDir([]));
  const scratch = mkdtempSync(join(tmpdir(), "tg-ext-"));
  try {
    assert.equal(resolveOutDir(["--out", scratch]), resolve(scratch));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("P0 REGRESSION: a refused --out deletes nothing", () => {
  // Sentinel: chạy build thật với --out trỏ vào một thư mục có dữ liệu, rồi khẳng định
  // dữ liệu còn nguyên.
  const victim = mkdtempSync(join(tmpdir(), "tg-victim-"));
  const sentinel = join(victim, "dung-xoa-toi.txt");
  writeFileSync(sentinel, "dữ liệu quan trọng", "utf8");
  try {
    assert.throws(
      () => execFileSync(process.execPath, [BUILD, "--out", victim], { stdio: "pipe" }),
      /./,
      "build phải thất bại",
    );
    assert.ok(existsSync(sentinel), "file sentinel bị xoá — --out vẫn nguy hiểm");
    assert.equal(readFileSync(sentinel, "utf8"), "dữ liệu quan trọng");
  } finally {
    rmSync(victim, { recursive: true, force: true });
  }
});

test("P0 REGRESSION: --out . leaves the repository intact", () => {
  const repoRoot = resolve(HERE, "../../..");
  assert.throws(() => execFileSync(process.execPath, [BUILD, "--out", "."], { cwd: repoRoot, stdio: "pipe" }));
  for (const survivor of ["package.json", "README.md", "packages/guide-schema/src/index.ts"]) {
    assert.ok(existsSync(join(repoRoot, survivor)), `${survivor} biến mất — --out . đã xoá repo`);
  }
});
