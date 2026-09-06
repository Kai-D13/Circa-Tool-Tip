import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFLICT_SQLSTATE,
  RpcError,
  buildAssignArgs,
  buildDeleteGuideArgs,
  buildGetGuideArgs,
  buildImportArgs,
  buildListArgs,
  buildSaveStepsArgs,
  buildSetStatusArgs,
  buildUpsertGuideArgs,
  isConflictError,
} from "../lib/guides/rpc.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(resolve(HERE, "../../../supabase/migrations/20260906_0003_guide_rpcs.sql"), "utf8");

/**
 * Extract the parameter names of a plpgsql function from the migration source.
 * Splits on commas, not newlines: some signatures are declared on a single line
 * (`admin_set_guide_status(p_guide_id uuid, p_status text)`) and a line-based split
 * silently sees only the first parameter.
 */
function sqlParams(fnName) {
  const m = SQL.match(new RegExp(`create or replace function public\\.${fnName}\\s*\\(([\\s\\S]*?)\\)\\s*returns`));
  assert.ok(m, `không tìm thấy ${fnName} trong migration`);
  return m[1]
    .replace(/--.*$/gm, "")
    .split(",")
    .map((s) => s.trim().split(/\s+/)[0])
    .filter((p) => /^p_\w+$/.test(p));
}

test("the signature parser itself finds every parameter", () => {
  // Guards the guard: a parser that misses a parameter would make every mapping test
  // pass vacuously.
  assert.deepEqual(sqlParams("admin_set_guide_status"), ["p_guide_id", "p_status"]);
  assert.equal(sqlParams("admin_upsert_guide").length, 7);
  assert.equal(sqlParams("admin_save_guide_steps").length, 4);
  assert.equal(sqlParams("admin_delete_guide").length, 1);
});

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

/* ------------------------------------------------------------- editor RPCs */

test("admin_get_guide args match the SQL signature", () => {
  assert.deepEqual(Object.keys(buildGetGuideArgs("id")).sort(), sqlParams("admin_get_guide").sort());
});

test("admin_upsert_guide args match the SQL signature", () => {
  const args = buildUpsertGuideArgs({
    guideId: "id", name: " G ", site: "pos", groupName: " Bán hàng ", startUrl: " /x ", sortOrder: 3, notes: null,
  });
  assert.deepEqual(Object.keys(args).sort(), sqlParams("admin_upsert_guide").sort());
  assert.equal(args.p_name, "G");
  assert.equal(args.p_group_name, "Bán hàng");
  assert.equal(args.p_start_url, "/x");
});

test("admin_upsert_guide always sends every field, never a partial patch", () => {
  // p_group_name defaults to null meaning "keep", so a missing key would silently retain
  // a stale group while the operator believes they cleared it.
  const args = buildUpsertGuideArgs({
    guideId: null, name: "G", site: null, groupName: "", startUrl: "", sortOrder: 0, notes: null,
  });
  for (const p of sqlParams("admin_upsert_guide")) {
    assert.ok(p in args, `thiếu ${p}`);
  }
  assert.equal(args.p_group_name, "", "chuỗi rỗng = xoá nhóm, khác với null = giữ nguyên");
});

test("admin_save_guide_steps args match the SQL signature", () => {
  const args = buildSaveStepsArgs("id", [], {}, "2026-09-06T00:00:00Z");
  assert.deepEqual(Object.keys(args).sort(), sqlParams("admin_save_guide_steps").sort());
  assert.equal(args.p_expected_updated_at, "2026-09-06T00:00:00Z");
});

test("admin_set_guide_status and admin_delete_guide args match their signatures", () => {
  assert.deepEqual(Object.keys(buildSetStatusArgs("id", "draft")).sort(), sqlParams("admin_set_guide_status").sort());
  assert.deepEqual(Object.keys(buildDeleteGuideArgs("id")).sort(), sqlParams("admin_delete_guide").sort());
});

/* ------------------------------------------------------------- conflict code */

test("the optimistic-concurrency SQLSTATE is recognised", () => {
  assert.equal(CONFLICT_SQLSTATE, "40001");
  assert.ok(isConflictError(new RpcError("admin_save_guide_steps", "Bộ đã được người khác sửa lúc…", "40001")));
});

test("other failures are not mistaken for a conflict", () => {
  assert.ok(!isConflictError(new RpcError("admin_save_guide_steps", "Không tìm thấy guide", "P0002")));
  assert.ok(!isConflictError(new RpcError("x", "boom")));
  assert.ok(!isConflictError(new Error("40001")));
});

test("the SQL really raises 40001 for a stale write", () => {
  // Keeps the client constant honest against the migration it depends on.
  assert.match(SQL, /Hãy tải lại trước khi lưu[\s\S]*?errcode = '40001'/);
});
