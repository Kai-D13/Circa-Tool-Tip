import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
