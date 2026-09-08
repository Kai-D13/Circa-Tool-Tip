import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_RELEASE_TEXT,
  applyOutcome,
  countByStatus,
  currentRevision,
  headText,
  isUnreleased,
  newFlight,
  nextRevision,
  publishGate,
  revisionText,
  rollbackGate,
  runPublish,
  runRollback,
  shortChecksum,
  siteStateFrom,
  toHistoryRows,
} from "../lib/guides/releases.ts";
import { RpcError } from "../lib/guides/rpc.ts";

/* -------------------------------------------------------------------- fixtures */

const guide = (over = {}) => ({
  id: "g1",
  legacy_id: null,
  site_code: "pos",
  group_name: "",
  name: "BÁN HÀNG TẠI QUẦY",
  status: "published",
  start_url: "/trang-chu",
  sort_order: 0,
  step_count: 9,
  validation: {},
  site_guess: null,
  site_evidence: {},
  notes: null,
  updated_at: "2026-09-08T00:00:00.000Z",
  ...over,
});

const head = (over = {}) => ({
  site_code: "pos",
  release_id: "rel-7",
  revision: 7,
  checksum: "sha256:" + "a".repeat(64),
  guide_count: 13,
  step_count: 118,
  released_at: "2026-09-08T10:00:00.000Z",
  ...over,
});

const release = (over = {}) => ({
  id: "rel-7",
  revision: 7,
  checksum: "sha256:" + "a".repeat(64),
  guideCount: 13,
  stepCount: 118,
  rolledBackFrom: null,
  note: "phát hành đầu tiên",
  releasedAt: "2026-09-08T10:00:00.000Z",
  releasedByEmail: "admin@circa.vn",
  ...over,
});

const list = (over = {}) => ({ ok: true, site: "pos", head: head(), releases: [release()], ...over });

const EMPTY_LIST = { ok: true, site: "pos", head: null, releases: [] };

/** Counts every call so "the RPC was never reached" is an assertion, not a hope. */
function fakeDeps(over = {}) {
  const calls = { publish: [], rollback: [], reload: [] };
  return {
    calls,
    publish: async (site, note) => {
      calls.publish.push({ site, note });
      return over.publishResult ?? { ok: true, site, releaseId: "rel-new", revision: 8, checksum: "sha256:bbb", guides: 13, steps: 118 };
    },
    rollback: async (site, releaseId) => {
      calls.rollback.push({ site, releaseId });
      return over.rollbackResult ?? { ok: true, site, releaseId: "rel-new", revision: 8, rolledBackFrom: 3 };
    },
    reload: async (site) => {
      calls.reload.push(site);
      return over.reloadResult ?? list();
    },
    ...(over.publish ? { publish: over.publish } : {}),
    ...(over.rollback ? { rollback: over.rollback } : {}),
  };
}

/* ------------------------------------------------- "chưa có bản phát hành" */

test("site chưa từng publish: head null là chưa có bản phát hành", () => {
  assert.equal(isUnreleased(null), true);
  assert.equal(currentRevision(null), 0);
  assert.equal(revisionText(null), "Revision: 0");
  assert.equal(headText(null), EMPTY_RELEASE_TEXT);
  assert.equal(nextRevision(siteStateFrom("pos", EMPTY_LIST, [])), 1);
});

test("revision 0 cũng là chưa có bản phát hành", () => {
  // admin_list_releases trả head null; get_release trả revision 0 cho extension. Hai quy
  // ước cho cùng một sự thật, nên cả hai phải cho cùng một câu trả lời.
  const zero = head({ revision: 0, checksum: "" });
  assert.equal(isUnreleased(zero), true);
  assert.equal(currentRevision(zero), 0);
  assert.equal(headText(zero), EMPTY_RELEASE_TEXT);
});

test("site đã publish thì không còn là chưa phát hành", () => {
  assert.equal(isUnreleased(head()), false);
  assert.equal(currentRevision(head()), 7);
  assert.equal(revisionText(head()), "Revision: 7");
  assert.notEqual(headText(head()), EMPTY_RELEASE_TEXT);
});

/* ------------------------------------------------------------- publish gate */

test("publish bị khoá khi chưa có bộ nào được duyệt — RPC không được gọi", async () => {
  const flight = newFlight();
  const deps = fakeDeps();
  const outcome = await runPublish(flight, { site: "pos", note: "có ghi chú", approvedCount: 0 }, deps);

  assert.equal(outcome.status, "blocked");
  assert.match(outcome.reason, /chưa có bộ nào được duyệt/i);
  assert.equal(deps.calls.publish.length, 0, "gate phải chặn TRƯỚC khi gọi RPC");
  assert.equal(deps.calls.reload.length, 0);
});

test("publish bị khoá khi ghi chú rỗng", async () => {
  const deps = fakeDeps();
  const outcome = await runPublish(newFlight(), { site: "pos", note: "   ", approvedCount: 13 }, deps);

  assert.equal(outcome.status, "blocked");
  assert.match(outcome.reason, /ghi chú/i);
  assert.equal(deps.calls.publish.length, 0);
});

test("không có bộ nào duyệt là lý do được báo trước, kể cả khi ghi chú cũng trống", () => {
  const gate = publishGate({ approvedCount: 0, note: "", busy: false });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /chưa có bộ nào được duyệt/i);
});

test("đủ điều kiện thì publish đi qua và ghi chú được trim", async () => {
  const deps = fakeDeps();
  const outcome = await runPublish(newFlight(), { site: "pos", note: "  sửa selector  ", approvedCount: 13 }, deps);

  assert.equal(outcome.status, "ok");
  assert.deepEqual(deps.calls.publish, [{ site: "pos", note: "  sửa selector  " }]);
  assert.deepEqual(deps.calls.reload, ["pos"], "thành công phải nạp lại head + lịch sử");
});

/* ------------------------------------------------------------ single flight */

test("bấm phát hành hai lần liên tiếp chỉ gọi RPC một lần", async () => {
  // Hai click trong cùng một tick: cả hai đọc state React cũ, nên guard bắt buộc phải là
  // hộp mutable chứ không phải useState.
  const flight = newFlight();
  let resolvePublish;
  const deps = fakeDeps({
    publish: (site, note) =>
      new Promise((r) => {
        resolvePublish = () => r({ ok: true, site, releaseId: "rel-new", revision: 8, checksum: "x", guides: 1, steps: 1 });
      }),
  });
  let publishCalls = 0;
  const counting = { ...deps, publish: (...a) => (publishCalls++, deps.publish(...a)) };

  const first = runPublish(flight, { site: "pos", note: "n", approvedCount: 13 }, counting);
  const second = runPublish(flight, { site: "pos", note: "n", approvedCount: 13 }, counting);

  const secondOutcome = await second;
  assert.equal(secondOutcome.status, "busy", "lần bấm thứ hai phải bị chặn");
  assert.equal(publishCalls, 1, "chỉ được gọi RPC một lần");

  resolvePublish();
  await first;
  assert.equal(flight.busy, false, "guard phải nhả sau khi xong");

  // Và nhả rồi thì lần sau đi được — guard không được kẹt vĩnh viễn.
  resolvePublish = null;
  const third = await runPublish(flight, { site: "pos", note: "n", approvedCount: 13 }, fakeDeps());
  assert.equal(third.status, "ok");
});

test("guard nhả cả khi RPC ném lỗi", async () => {
  const flight = newFlight();
  const deps = fakeDeps({
    publish: async () => {
      throw new Error("mạng chết");
    },
  });
  const outcome = await runPublish(flight, { site: "pos", note: "n", approvedCount: 1 }, deps);
  assert.equal(outcome.status, "error");
  assert.equal(flight.busy, false, "finally phải chạy");
});

/* --------------------------------------------------- thất bại và độc lập site */

test("thất bại giữ nguyên head và lịch sử đang hiển thị", async () => {
  const before = siteStateFrom("pos", list(), [guide()]);
  const deps = fakeDeps({
    publish: async () => {
      throw new RpcError("admin_publish_site", "Không publish được site pos — Bước 3 thiếu selector", "22023");
    },
  });

  const outcome = await runPublish(newFlight(), { site: "pos", note: "n", approvedCount: 13 }, deps);
  const after = applyOutcome(before, outcome);

  assert.deepEqual(after.head, before.head, "head không được biến mất khi publish hỏng");
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.approved, before.approved);
  assert.match(after.error, /Bước 3 thiếu selector/, "lỗi Postgres phải hiện nguyên văn");
});

test("POS lỗi không đụng gì tới state của Admin", async () => {
  const board = {
    pos: siteStateFrom("pos", list(), [guide()]),
    admin: siteStateFrom("admin", list({ site: "admin" }), [guide({ id: "g2", site_code: "admin" })]),
  };
  const posFlight = newFlight();
  const adminFlight = newFlight();
  const deps = fakeDeps({
    publish: async () => {
      throw new Error("POS hỏng");
    },
  });

  const outcome = await runPublish(posFlight, { site: "pos", note: "n", approvedCount: 13 }, deps);
  const next = { ...board, pos: applyOutcome(board.pos, outcome) };

  assert.equal(next.pos.error, "POS hỏng");
  assert.equal(next.admin, board.admin, "state Admin phải là ĐÚNG object cũ, không bị dựng lại");
  assert.equal(adminFlight.busy, false, "flight của Admin không được đụng tới");
  assert.deepEqual(next.pos.head, board.pos.head);
});

test("outcome busy trả về đúng object cũ để chắc chắn không có gì nhúc nhích", () => {
  const state = siteStateFrom("pos", list(), [guide()]);
  assert.equal(applyOutcome(state, { status: "busy" }), state);
});

/* ------------------------------------------------------------------ rollback */

test("rollback về chính bản hiện hành bị khoá — RPC không được gọi", async () => {
  const state = siteStateFrom("pos", list(), [guide()]);
  const headRow = state.history.find((r) => r.isHead);
  assert.ok(headRow, "fixture phải có một dòng là head");
  assert.equal(rollbackGate(headRow, state.head, false).ok, false);

  const deps = fakeDeps();
  const outcome = await runRollback(newFlight(), { site: "pos", row: headRow, head: state.head }, deps);
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.reason, /bản hiện hành/i);
  assert.equal(deps.calls.rollback.length, 0);
});

test("rollback về một bản cũ thì mở", () => {
  const state = siteStateFrom("pos", list({ releases: [release(), release({ id: "rel-3", revision: 3 })] }), []);
  const old = state.history.find((r) => r.revision === 3);
  assert.equal(old.isHead, false);
  assert.equal(rollbackGate(old, state.head, false).ok, true);
});

test("rollback thành công cho ra revision MỚI cao hơn, không bao giờ hạ", async () => {
  const before = siteStateFrom("pos", list({ releases: [release(), release({ id: "rel-3", revision: 3 })] }), []);
  assert.equal(currentRevision(before.head), 7);

  const after8 = {
    ok: true,
    site: "pos",
    head: head({ release_id: "rel-8", revision: 8 }),
    releases: [
      release({ id: "rel-8", revision: 8, rolledBackFrom: "rel-3", note: "Rollback về revision 3" }),
      release(),
      release({ id: "rel-3", revision: 3 }),
    ],
  };
  const deps = fakeDeps({ reloadResult: after8 });
  const old = before.history.find((r) => r.revision === 3);

  const outcome = await runRollback(newFlight(), { site: "pos", row: old, head: before.head }, deps);
  const after = applyOutcome(before, outcome);

  assert.equal(currentRevision(after.head), 8);
  assert.ok(currentRevision(after.head) > currentRevision(before.head), "revision không bao giờ được giảm");
  assert.equal(after.history[0].rolledBackFromRevision, 3, "hiện là SỐ revision, không phải uuid");
  assert.equal(after.history.length, 3, "không dòng lịch sử nào bị mất");
  assert.deepEqual(deps.calls.rollback, [{ site: "pos", releaseId: "rel-3" }]);
});

/* --------------------------------------------------- rolledBackFrom: uuid -> số */

test("rolledBackFrom trong danh sách là UUID và được quy đổi ra số revision", () => {
  const rows = toHistoryRows({
    ok: true,
    site: "pos",
    head: head({ release_id: "rel-8", revision: 8 }),
    releases: [release({ id: "rel-8", revision: 8, rolledBackFrom: "rel-3" }), release({ id: "rel-3", revision: 3 })],
  });
  assert.equal(rows[0].rolledBackFromRevision, 3);
  assert.equal(rows[1].rolledBackFromRevision, null);
  assert.equal(rows[0].isHead, true);
  assert.equal(rows[1].isHead, false);
});

test("uuid không quy đổi được cho null, không phải undefined và không ném", () => {
  const rows = toHistoryRows({
    ok: true,
    site: "pos",
    head: null,
    releases: [release({ id: "rel-9", revision: 9, rolledBackFrom: "rel-khong-co-trong-danh-sach" })],
  });
  assert.equal(rows[0].rolledBackFromRevision, null);
  assert.ok(!("undefined" in rows[0]));
  assert.equal(rows[0].isHead, false, "head null thì không dòng nào là head");
});

/* -------------------------------------------------------------- đếm theo site */

test("đếm draft/đã duyệt lấy từ hàng của site, không đụng counts toàn cục", () => {
  const rows = [
    guide({ id: "a", status: "published", step_count: 9 }),
    guide({ id: "b", status: "draft", step_count: 4 }),
    guide({ id: "c", status: "published", step_count: 7 }),
    guide({ id: "d", status: "archived", step_count: 99 }),
  ];
  // counts toàn cục nói dối; siteStateFrom phải bỏ qua hoàn toàn.
  const state = siteStateFrom("pos", { ...list(), counts: { draft: 999, published: 999 } }, rows);

  assert.equal(state.draftCount, 1);
  assert.equal(state.approved.length, 2);
  assert.equal(state.approvedStepTotal, 16, "chỉ cộng bước của bộ đã duyệt");
  assert.deepEqual(countByStatus(rows), { unassigned: 0, draft: 1, published: 2, archived: 1 });
});

test("bộ có cờ auto-click được đánh dấu trong danh sách sẽ phát hành", () => {
  const state = siteStateFrom("pos", list(), [
    guide({ id: "a", validation: { flags: ["GUIDE_HAS_AUTO_CLICK_UNANCHORED"] } }),
    guide({ id: "b", validation: { warnings: ["Bước 1: thiếu tiêu đề"] } }),
    guide({ id: "c", validation: {} }),
  ]);
  assert.deepEqual(
    state.approved.map((g) => [g.id, g.hasAutoClickFlag, g.hasWarnings]),
    [
      ["a", true, true],
      ["b", false, true],
      ["c", false, false],
    ],
  );
});

/* ------------------------------------------------------------ revision dự kiến */

test("revision dự kiến là max+1 trên toàn lịch sử, không phải head+1", () => {
  // Sau một rollback, head trỏ vào payload cũ trong khi revision cao nhất lớn hơn. SQL
  // lấy max, nên UI cũng phải lấy max — nếu không nó hứa một số mà database không cấp.
  const state = siteStateFrom("pos", {
    ok: true,
    site: "pos",
    head: head({ release_id: "rel-5", revision: 5 }),
    releases: [release({ id: "rel-9", revision: 9 }), release({ id: "rel-5", revision: 5 })],
  }, []);
  assert.equal(currentRevision(state.head), 5);
  assert.equal(nextRevision(state), 10);
});

/* ---------------------------------------------------------------- checksum */

test("checksum chỉ được rút gọn, không bao giờ tự tính", () => {
  assert.equal(shortChecksum(null), "—");
  assert.equal(shortChecksum(""), "—");
  assert.equal(shortChecksum("sha256:" + "a".repeat(64)), "sha256:aaaaaaaaaaaa…");
  assert.equal(shortChecksum("sha256:abc"), "sha256:abc", "ngắn thì để nguyên");
});

/* --------------------------------------- dựng trang không gọi RPC ghi nào */

test("dựng toàn bộ state của trang không gọi bất kỳ RPC ghi nào", () => {
  // deps ném ngay nếu bị chạm tới: dựng view-model phải là thuần đọc.
  const deps = {
    publish: () => {
      throw new Error("publish bị gọi lúc render");
    },
    rollback: () => {
      throw new Error("rollback bị gọi lúc render");
    },
    reload: () => {
      throw new Error("reload bị gọi lúc render");
    },
  };

  const pos = siteStateFrom("pos", list(), [guide()]);
  const admin = siteStateFrom("admin", EMPTY_LIST, []);

  for (const state of [pos, admin]) {
    assert.doesNotThrow(() => toHistoryRows(list()));
    assert.doesNotThrow(() => nextRevision(state));
    assert.doesNotThrow(() => revisionText(state.head));
    assert.doesNotThrow(() => publishGate({ approvedCount: state.approved.length, note: "", busy: false }));
    for (const row of state.history) assert.doesNotThrow(() => rollbackGate(row, state.head, false));
  }
  assert.equal(typeof deps.publish, "function", "deps chưa từng được gọi");
});
