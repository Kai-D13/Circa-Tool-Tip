import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".next", "tests"]);
const EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".json", ".css", ".example"]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e) || e.startsWith(".env.")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.has(extname(p)) || e === ".env.example") out.push(p);
  }
  return out;
}

/** Anything that would mean a privileged credential leaked into the Portal. */
const FORBIDDEN = [
  /sb_secret_[A-Za-z0-9_-]+/,
  /service_role/i,
  /SUPABASE_SECRET_KEY\s*=\s*\S/,
  /SUPABASE_SERVICE_ROLE/i,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // a real JWT
  /sb_publishable_[A-Za-z0-9_-]{10,}/, // even the publishable key belongs in .env.local, not source
];

test("no credential of any kind is committed in apps/admin", () => {
  const hits = [];
  for (const file of walk(APP)) {
    const text = readFileSync(file, "utf8");
    for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${relative(APP, file)} ~ ${re}`);
  }
  assert.deepEqual(hits, []);
});

test(".env.example has only the two public variables and no values", () => {
  const lines = readFileSync(resolve(APP, ".env.example"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(lines, ["NEXT_PUBLIC_SUPABASE_URL=", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="]);
});
