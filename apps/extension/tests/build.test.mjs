import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readSupabaseConfig, resolveOutDir } from "../build.mjs";

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
  } finally {
    b.cleanup();
  }
});

test("P0: the Supabase host is fetchable but is NOT a site the extension acts on", () => {
  // host_permissions and content_scripts stopped being the same list when the API host
  // was added. background.js derives the origins it will open tabs to, and accept
  // recorded steps from, out of content_scripts — reading them from host_permissions
  // would quietly make the database a page the Portal could ask it to open.
  const hosts = SRC_MANIFEST.host_permissions;
  const pages = SRC_MANIFEST.content_scripts.flatMap((cs) => cs.matches);

  assert.ok(hosts.includes("https://yoqzsvcbsornqjcatdvy.supabase.co/*"), "service worker phải fetch được Supabase");
  assert.ok(!pages.some((m) => m.includes("supabase")), "không content script nào chạy trên Supabase");

  const bg = readFileSync(resolve(HERE, "../src/background.js"), "utf8");
  assert.match(bg, /TARGET_ORIGINS = originsFromMatches\(\(MANIFEST\.content_scripts/);
  assert.ok(
    !/TARGET_ORIGINS[\s\S]{0,80}host_permissions/.test(bg),
    "target origins không được lấy từ host_permissions",
  );
});

test("permissions stay minimal — no tabs, no <all_urls>", () => {
  // `tabs` is only needed to read url/title, which the recorder gets from the content
  // script instead; asking for it would add a Web Store review warning for nothing.
  // `alarms` is what schedules the periodic release sync and has no cheaper substitute:
  // a service worker cannot hold a timer across eviction.
  assert.deepEqual([...SRC_MANIFEST.permissions].sort(), ["alarms", "storage"]);
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

test("every script the manifest loads actually parses", () => {
  // scripts/check-syntax.mjs deliberately skips apps/ (they are Next.js projects with
  // their own gate), and content.js is a classic script no test can import. Without this
  // a typo in the recorder only shows up as a silent content script in Chrome.
  const b = buildTo();
  try {
    const scripts = [
      b.manifest.background.service_worker,
      ...b.manifest.content_scripts.flatMap((cs) => cs.js ?? []),
    ];
    assert.ok(scripts.length >= 4, "manifest phải nạp cả bundle schema, selector và content");
    for (const rel of scripts) {
      assert.doesNotThrow(
        () => execFileSync(process.execPath, ["--check", join(b.out, rel)], { stdio: "pipe" }),
        `${rel} không parse được`,
      );
    }
  } finally {
    b.cleanup();
  }
});

test("the content script never reaches for a second copy of the schema", () => {
  // One definition of normalizeText / the URL matcher. A local re-implementation in the
  // content script is exactly the drift this rebuild exists to remove.
  const content = readFileSync(resolve(HERE, "../src/content.js"), "utf8");
  assert.ok(!/function\s+normalizeText/.test(content), "content.js tự định nghĩa normalizeText");
  assert.ok(content.includes("TG_SELECTOR"), "content.js phải dùng module selector chung");
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

/* --------------------------------------------- 3A: cấu hình Supabase tiêm lúc build */

test("P0: publishable key không bao giờ nằm trong source", () => {
  // Nó là publishable key, không phải secret theo nghĩa rò rỉ — nhưng một key nằm trong
  // repo là một key không ai xoay vòng được nếu không có commit.
  const files = readdirSync(resolve(HERE, "../src")).map((f) => resolve(HERE, "../src", f));
  for (const file of [...files, resolve(HERE, "../manifest.json"), resolve(HERE, "../build.mjs")]) {
    const src = readFileSync(file, "utf8");
    assert.ok(!/sb_publishable_[A-Za-z0-9]/.test(src), `${basename(file)} chứa publishable key`);
  }
  assert.ok(!existsSync(resolve(HERE, "../src/config.js")), "config.js là file sinh ra, không phải source");
});

test("build sinh config.js với URL và key", () => {
  const b = buildTo();
  try {
    const config = readFileSync(join(b.out, "config.js"), "utf8");
    assert.match(config, /export const SUPABASE_URL = /);
    assert.match(config, /export const SUPABASE_PUBLISHABLE_KEY = /);
    // Service worker là module nên import được nó; nó phải parse.
    assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", join(b.out, "config.js")], { stdio: "pipe" }));
  } finally {
    b.cleanup();
  }
});

test("cấu hình lấy từ env trước, rồi mới tới .env.local của Portal", () => {
  // Một chỗ cấu hình duy nhất cho cả Portal lẫn extension; env thắng để CI ghi đè được.
  const nowhere = resolve(HERE, "khong-ton-tai.env");
  const fromEnv = readSupabaseConfig(
    { SUPABASE_URL: "https://tu-env.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_env" },
    nowhere,
  );
  assert.deepEqual(fromEnv, { url: "https://tu-env.supabase.co", key: "sb_publishable_env" });

  const missing = readSupabaseConfig({}, nowhere);
  assert.deepEqual(missing, { url: "", key: "" }, "không có gì thì trả rỗng, không ném");

  // Biến môi trường đặt rỗng nghĩa là "chưa cấu hình" — phải rơi xuống file, không được
  // che mất file. `??` sẽ làm ngược lại vì chuỗi rỗng không nullish.
  const file = resolve(HERE, "tg-env-test.env");
  const lines = ["NEXT_PUBLIC_SUPABASE_URL=https://tu-file.supabase.co", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_file"];
  writeFileSync(file, lines.join("\n"), "utf8");
  try {
    const fallback = readSupabaseConfig({ SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "" }, file);
    assert.deepEqual(fallback, { url: "https://tu-file.supabase.co", key: "sb_publishable_file" });
  } finally {
    rmSync(file, { force: true });
  }
});

test("bản release từ chối build khi thiếu cấu hình Supabase", () => {
  // Một bản release không nối được Supabase là một bản ship cho 25 máy một menu rỗng
  // vĩnh viễn. Hỏng ở đây, đừng hỏng ngoài cửa hàng.
  const out = mkdtempSync(join(tmpdir(), "tg-ext-"));
  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [BUILD, "--out", out, "--release", "https://circa-tool-tip.vercel.app"], {
          stdio: "pipe",
          // Trỏ file env vào chỗ không tồn tại, để test không phụ thuộc việc máy chạy
          // test có apps/admin/.env.local hay không.
          env: {
            ...process.env,
            TG_SUPABASE_ENV_FILE: resolve(HERE, "khong-ton-tai.env"),
            SUPABASE_URL: "",
            SUPABASE_PUBLISHABLE_KEY: "",
            NEXT_PUBLIC_SUPABASE_URL: "",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
          },
        }),
      // Phải hỏng ĐÚNG vì thiếu cấu hình, không phải vì một lý do nào khác tình cờ.
      (err) => {
        assert.match(String(err.stderr), /SUPABASE_URL và SUPABASE_PUBLISHABLE_KEY/);
        return true;
      },
    );
    assert.ok(!existsSync(join(out, "config.js")), "hỏng thì không được để lại config nửa vời");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
