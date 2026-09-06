import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFLICT_SQLSTATE,
  NOT_FOUND_SQLSTATE,
  RpcError,
  buildAssignArgs,
  buildDeleteGuideArgs,
  buildGetGuideArgs,
  buildImportArgs,
  buildListArgs,
  buildSaveGuideArgs,
  buildSaveStepsArgs,
  buildSetStatusArgs,
  buildUpsertGuideArgs,
  isConflictError,
  isNotFoundError,
} from "../lib/guides/rpc.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// Signatures live across several migrations; read them all so a test can reference any.
const SQL = ["20260906_0003_guide_rpcs.sql", "20260906_0005_atomic_guide_save.sql"]
  .map((f) => readFileSync(resolve(HERE, "../../../supabase/migrations/", f), "utf8"))
  .join("\n");
const EDITOR_SRC = readFileSync(resolve(HERE, "../components/guide-editor.tsx"), "utf8");

/**
 * Extract the parameter names of a plpgsql function from the migration source.
 * Splits on commas, not newlines: some signatures are declared on a single line
 * (`admin_set_guide_status(p_guide_id uuid, p_status text)`) and a line-based split
 * silently sees only the first parameter.
 */
function sqlSignature(fnName) {
  const m = SQL.match(new RegExp(`create or replace function public\\.${fnName}\\s*\\(([\\s\\S]*?)\\)\\s*returns`));
  assert.ok(m, `không tìm thấy ${fnName} trong migration`);
  return m[1].replace(/--.*$/gm, "");
}

function sqlParams(fnName) {
  return sqlSignature(fnName)
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

/* ------------------------------------------------- atomic save (migration 0005) */

test("admin_save_guide args match the SQL signature", () => {
  const args = buildSaveGuideArgs({
    guideId: "id", name: " G ", site: "pos", groupName: " Kho ", startUrl: " /x ",
    sortOrder: 2, notes: null, steps: [], validation: {}, expectedUpdatedAt: "2026-09-06T00:00:00Z",
  });
  assert.deepEqual(Object.keys(args).sort(), sqlParams("admin_save_guide").sort());
  assert.equal(sqlParams("admin_save_guide").length, 10);
  assert.equal(args.p_name, "G");
  assert.equal(args.p_group_name, "Kho");
  assert.equal(args.p_expected_updated_at, "2026-09-06T00:00:00Z");
});

test("P0: the editor saves through the atomic RPC only, never the old two-call chain", () => {
  assert.ok(EDITOR_SRC.includes("rpcSaveGuide("), "editor phải gọi RPC atomic");
  assert.ok(!/rpcSaveGuideSteps/.test(EDITOR_SRC), "không được gọi admin_save_guide_steps riêng lẻ");
  assert.ok(!/rpcUpsertGuide/.test(EDITOR_SRC), "không được gọi admin_upsert_guide riêng lẻ");
});

/**
 * Body of admin_save_guide.
 *
 * Both boundaries must be searched RELATIVE to the function start: admin_save_guide_steps
 * is declared earlier in migration 0003, so an absolute indexOf for the closing `revoke`
 * lands before the opening `create` and silently yields an empty string — every assertion
 * against it would then pass or fail for the wrong reason.
 */
function atomicSaveBody() {
  const start = SQL.indexOf("create or replace function public.admin_save_guide(");
  assert.ok(start >= 0, "không tìm thấy admin_save_guide trong migration");
  const fn = SQL.slice(start);
  const end = fn.indexOf("revoke all on function public.admin_save_guide(");
  assert.ok(end > 0, "không tìm thấy phần revoke của admin_save_guide");
  const body = fn.slice(0, end);
  assert.ok(body.length > 500, "thân hàm rỗng bất thường — kiểm tra lại cách cắt chuỗi");
  return body;
}

test("the atomic RPC writes everything in one UPDATE, guarded in the WHERE", () => {
  const body = atomicSaveBody();
  assert.equal((body.match(/^\s*update public\.guides set/gm) || []).length, 1, "đúng một câu UPDATE");
  assert.match(body, /draft_steps\s*=\s*p_steps/);
  assert.match(body, /name\s*=\s*trim\(p_name\)/);
});

test("P0: the optimistic guard cannot be bypassed by omitting the baseline", () => {
  const sig = sqlSignature("admin_save_guide");
  assert.ok(
    !/p_expected_updated_at\s+timestamptz\s+default/i.test(sig),
    "p_expected_updated_at không được có DEFAULT — bỏ trống là mở đường ghi đè",
  );
  assert.ok(!/p_validation\s+jsonb\s+default/i.test(sig), "p_validation không được có DEFAULT");

  const body = atomicSaveBody();
  assert.match(body, /if p_expected_updated_at is null then[\s\S]*?errcode = '22023'/, "null phải bị từ chối");
  assert.match(body, /and updated_at = p_expected_updated_at/, "guard nằm thẳng trong WHERE");
  assert.ok(
    !/p_expected_updated_at is null or updated_at = p_expected_updated_at/.test(body),
    "không còn nhánh cho phép bỏ qua guard",
  );
});

test("the client type makes the baseline required, matching the SQL", () => {
  const RPC_SRC = readFileSync(resolve(HERE, "../lib/guides/rpc.ts"), "utf8");
  const iface = RPC_SRC.slice(RPC_SRC.indexOf("interface SaveGuideInput"));
  const field = iface.slice(0, iface.indexOf("}")).match(/expectedUpdatedAt:\s*([^;]+);/);
  assert.ok(field, "không tìm thấy expectedUpdatedAt");
  assert.equal(field[1].trim(), "string", "phải là string, không phải string | null");
});

test("not-found is recognised and kept distinct from a conflict", () => {
  assert.equal(NOT_FOUND_SQLSTATE, "P0002");
  const notFound = new RpcError("admin_get_guide", "Không tìm thấy guide", "P0002");
  assert.ok(isNotFoundError(notFound));
  assert.ok(!isConflictError(notFound));
  assert.ok(!isNotFoundError(new RpcError("x", "mạng hỏng", "")));
  assert.ok(!isNotFoundError(new Error("P0002")));
});
