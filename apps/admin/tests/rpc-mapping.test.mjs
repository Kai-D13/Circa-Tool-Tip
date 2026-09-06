import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAssignArgs, buildImportArgs, buildListArgs } from "../lib/guides/rpc.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(resolve(HERE, "../../../supabase/migrations/20260906_0003_guide_rpcs.sql"), "utf8");

/** Extract the parameter names of a plpgsql function from the migration source. */
function sqlParams(fnName) {
  const m = SQL.match(new RegExp(`create or replace function public\\.${fnName}\\s*\\(([\\s\\S]*?)\\)\\s*returns`));
  assert.ok(m, `không tìm thấy ${fnName} trong migration`);
  return m[1]
    .split("\n")
    .map((l) => l.replace(/--.*$/, "").trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[0].replace(/,$/, ""))
    .filter((p) => p.startsWith("p_"));
}

test("admin_import_legacy args match the SQL signature", () => {
  assert.deepEqual(Object.keys(buildImportArgs({}, "f.json", "sha256:x")).sort(), sqlParams("admin_import_legacy").sort());
});

test("admin_list_guides args match the SQL signature", () => {
  assert.deepEqual(Object.keys(buildListArgs()).sort(), sqlParams("admin_list_guides").sort());
});

test("admin_assign_guide_site args match the SQL signature and trim the group", () => {
  const args = buildAssignArgs("id", "pos", "  Bán hàng ");
  assert.deepEqual(Object.keys(args).sort(), sqlParams("admin_assign_guide_site").sort());
  assert.equal(args.p_group_name, "Bán hàng");
});

test("list args default to null so the SQL defaults apply", () => {
  assert.deepEqual(buildListArgs(), { p_site: null, p_group: null, p_status: null });
});
