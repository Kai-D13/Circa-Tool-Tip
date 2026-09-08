import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EMPTY_RELEASE_TEXT,
  applyOutcome,
  countByStatus,
  currentRevision,
  headText,
  isDatabaseVerdict,
  isUnreleased,
  newFlight,
  nextRevision,
  publishGate,
  revisionText,
  rollbackGate,
  runPublish,
  runReload,
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

  assert.equal(outcome.status, "committed");
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
  assert.equal(third.status, "committed");
});

test("guard nhả cả khi RPC ném lỗi", async () => {
  const flight = newFlight();
  const deps = fakeDeps({
    publish: async () => {
      throw new Error("mạng chết");
    },
  });
  const outcome = await runPublish(flight, { site: "pos", note: "n", approvedCount: 1 }, deps);
  assert.equal(outcome.status, "unknown", "Error trần không mang SQLSTATE nên không kết luận được");
  assert.equal(flight.busy, false, "finally phải chạy dù đi ra bằng đường nào");
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
  assert.equal(outcome.status, "rejected", "database đã trả lời — không phải trạng thái mập mờ");
  const after = applyOutcome(before, outcome);

  assert.equal(after.needsReload, null, "database từ chối thì không có gì để đối soát, thử lại được ngay");
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

  assert.equal(outcome.status, "unknown", "Error trần không có SQLSTATE — không biết DB đã ghi chưa");
  assert.equal(next.pos.needsReload.message, "POS hỏng");
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
  assert.equal(outcome.status, "committed");
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

/* ================== P0: commit thành công vs màn hình không tải lại được ========= */

test("P0: publish thành công nhưng reload hỏng KHÔNG được báo là thất bại", async () => {
  // Đây là đường sinh ra release trùng: DB đã tạo revision, Portal báo hỏng, Admin bấm
  // lại, và site có hai bản phát hành cho cùng một ý định.
  const before = siteStateFrom("pos", list(), [guide()]);
  const deps = fakeDeps({});
  deps.reload = async () => {
    throw new Error("Failed to fetch");
  };

  const outcome = await runPublish(newFlight(), { site: "pos", note: "n", approvedCount: 13 }, deps);
  assert.equal(outcome.status, "committed-refresh-failed");
  assert.equal(outcome.result.revision, 8, "kết quả server phải được giữ lại");

  const after = applyOutcome(before, outcome);
  assert.equal(after.error, null, "không được hiện như một lần phát hành thất bại");
  assert.equal(after.lastResult.revision, 8, "Admin phải thấy revision đã được tạo");
  assert.equal(after.needsReload.kind, "committed-refresh-failed");
  assert.deepEqual(after.head, before.head, "head cũ giữ nguyên — ta chưa đọc được head mới");
});

test("P0: rollback thành công nhưng reload hỏng cũng vậy", async () => {
  const before = siteStateFrom("pos", list({ releases: [release(), release({ id: "rel-3", revision: 3 })] }), []);
  const deps = fakeDeps({});
  deps.reload = async () => {
    throw new Error("mất mạng");
  };
  const old = before.history.find((r) => r.revision === 3);

  const outcome = await runRollback(newFlight(), { site: "pos", row: old, head: before.head }, deps);
  assert.equal(outcome.status, "committed-refresh-failed");

  const after = applyOutcome(before, outcome);
  assert.equal(after.error, null);
  assert.equal(after.lastResult.revision, 8);
  assert.equal(after.lastResult.rolledBackFrom, 3);
});

test("P0: sau khi commit mà chưa đối soát được, không được ghi tiếp", async () => {
  const before = siteStateFrom("pos", list(), [guide()]);
  const deps = fakeDeps({});
  deps.reload = async () => {
    throw new Error("Failed to fetch");
  };
  const stuck = applyOutcome(before, await runPublish(newFlight(), { site: "pos", note: "n", approvedCount: 13 }, deps));

  const fresh = fakeDeps();
  const again = await runPublish(
    newFlight(),
    { site: "pos", note: "n", approvedCount: 13, needsReload: !!stuck.needsReload },
    fresh,
  );
  assert.equal(again.status, "blocked");
  assert.match(again.reason, /tải lại trạng thái/i);
  assert.equal(fresh.calls.publish.length, 0, "không được gọi publish lần hai");

  const rollbackAgain = await runRollback(
    newFlight(),
    { site: "pos", row: stuck.history[0], head: stuck.head, needsReload: true },
    fresh,
  );
  assert.equal(rollbackAgain.status, "blocked");
  assert.equal(fresh.calls.rollback.length, 0);
});

test("P0: tải lại trạng thái là đường thoát, và nó gỡ khoá", async () => {
  const before = siteStateFrom("pos", list(), [guide()]);
  const failing = fakeDeps({});
  failing.reload = async () => {
    throw new Error("Failed to fetch");
  };
  const stuck = applyOutcome(
    before,
    await runPublish(newFlight(), { site: "pos", note: "n", approvedCount: 13 }, failing),
  );
  assert.ok(stuck.needsReload);

  const after8 = {
    ok: true,
    site: "pos",
    head: head({ release_id: "rel-8", revision: 8 }),
    releases: [release({ id: "rel-8", revision: 8 }), release()],
  };
  const recovered = applyOutcome(stuck, await runReload(newFlight(), "pos", fakeDeps({ reloadResult: after8 })));

  assert.equal(recovered.needsReload, null, "đối soát xong thì mở khoá");
  assert.equal(currentRevision(recovered.head), 8, "và head mới hiện ra");
  assert.equal(recovered.lastResult.revision, 8, "kết quả lần publish vẫn còn để đối chiếu");
});

test("P0: tải lại thất bại thì vẫn kẹt, và vẫn không phải lỗi phát hành", async () => {
  const before = siteStateFrom("pos", list(), [guide()]);
  const failing = fakeDeps({});
  failing.reload = async () => {
    throw new Error("Failed to fetch");
  };
  const stuck = applyOutcome(
    before,
    await runPublish(newFlight(), { site: "pos", note: "n", approvedCount: 13 }, failing),
  );
  const still = applyOutcome(stuck, await runReload(newFlight(), "pos", failing));

  assert.equal(still.needsReload.kind, "committed-refresh-failed", "vẫn nhớ là DB ĐÃ ghi");
  assert.equal(still.error, null);
});

/* -------------------------------- database từ chối vs không biết gì cả */

test("SQLSTATE nghĩa là database đã trả lời, và đã từ chối", () => {
  assert.equal(isDatabaseVerdict(new RpcError("admin_publish_site", "Không có guide nào", "22023")), true);
  assert.equal(isDatabaseVerdict({ code: "42501", message: "Admin permission required" }), true);
  assert.equal(isDatabaseVerdict({ code: "P0002" }), true);
});

test("không có SQLSTATE nghĩa là không biết lệnh đã tới database hay chưa", () => {
  // Đoán "nó hỏng" chính là cái đoán tạo ra release trùng.
  assert.equal(isDatabaseVerdict(new Error("Failed to fetch")), false);
  assert.equal(isDatabaseVerdict({ code: "" }), false);
  assert.equal(isDatabaseVerdict({ code: "   " }), false);
  assert.equal(isDatabaseVerdict(null), false);
  assert.equal(isDatabaseVerdict("mạng chết"), false);
});

test("lỗi transport cho trạng thái unknown và khoá thao tác ghi", async () => {
  const before = siteStateFrom("pos", list(), [guide()]);
  const deps = fakeDeps({
    publish: async () => {
      throw new Error("Failed to fetch");
    },
  });
  const outcome = await runPublish(newFlight(), { site: "pos", note: "n", approvedCount: 13 }, deps);
  assert.equal(outcome.status, "unknown");

  const after = applyOutcome(before, outcome);
  assert.equal(after.error, null, "chưa biết là hỏng thì không được nói là hỏng");
  assert.equal(after.needsReload.kind, "unknown");
  assert.equal(after.lastResult, null, "và không được vờ như đã có kết quả");
  assert.equal(publishGate({ approvedCount: 13, note: "n", busy: false, needsReload: true }).ok, false);
});

test("lỗi SQL rõ ràng thì vẫn thử lại được ngay, không bắt đối soát", async () => {
  const before = siteStateFrom("pos", list(), [guide()]);
  const deps = fakeDeps({
    publish: async () => {
      throw new RpcError("admin_publish_site", "Không publish được site pos — Bước 3 thiếu selector", "22023");
    },
  });
  const after = applyOutcome(
    before,
    await runPublish(newFlight(), { site: "pos", note: "n", approvedCount: 13 }, deps),
  );

  assert.match(after.error, /Bước 3 thiếu selector/);
  assert.equal(after.needsReload, null);
  assert.equal(publishGate({ approvedCount: 13, note: "n", busy: false, needsReload: false }).ok, true);
});

/* ------------------------------------------------------ P2: nói đúng về concurrency */

test("không chỗ nào khẳng định tab thứ hai sẽ nhận 23505", () => {
  // pg_advisory_xact_lock là transaction-scoped: request thứ hai CHỜ request đầu commit,
  // rồi đọc max(revision) mới và mint số kế tiếp. Kết quả là hai release liên tiếp, không
  // có unique violation nào. Comment cũ hứa một contract database không hề có.
  const HERE = dirname(fileURLToPath(import.meta.url));
  for (const f of ["../lib/guides/releases.ts", "../components/release-panel.tsx"]) {
    const src = readFileSync(resolve(HERE, f), "utf8");
    assert.ok(!src.includes("23505"), `${f} vẫn khẳng định sai về unique violation`);
  }
});
