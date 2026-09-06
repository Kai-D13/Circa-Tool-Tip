#!/usr/bin/env node
/**
 * Cheap, dependency-free gate: every runtime file must parse.
 *
 * Adapted from circa-consult-salesup/package.json's `check` script, which runs
 * `node --check` over every runtime file. Without a bundler or a type checker in the
 * toolchain, this is what catches a typo before it reaches a reviewer.
 *
 *   - .mjs / .js : `node --check`
 *   - .ts        : imported for real, so type-stripping and every import path is
 *                  exercised. Modules in packages/ are side-effect free by design.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// apps/* are Next.js projects: their .ts/.tsx import framework modules that plain Node
// cannot load, and they have their own gate (`tsc --noEmit` + `next build`).
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "out", "data", "apps"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT).filter((f) => [".mjs", ".js", ".ts"].includes(extname(f)));
const failures = [];
let checked = 0;

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/");
  try {
    if (extname(file) === ".ts") {
      await import(pathToFileURL(file).href);
    } else {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    }
    checked++;
  } catch (err) {
    failures.push({ rel, message: String(err?.stderr || err?.message || err).trim() });
  }
}

for (const f of failures) {
  console.error(`FAIL ${f.rel}\n  ${f.message.split("\n").slice(0, 4).join("\n  ")}\n`);
}
console.log(`${checked}/${files.length} file parse OK`);
if (failures.length) process.exit(1);
