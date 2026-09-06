import test from "node:test";
import assert from "node:assert/strict";

import { retryTargets, runBulkAssign, suggestedSite } from "../lib/guides/bulk-assign.ts";
import { applyAssignment } from "../lib/guides/triage.ts";

let seq = 0;
const guide = (over = {}) => ({
  id: "g" + ++seq,
  legacy_id: null,
  site_code: null,
  group_name: "",
  name: "BỘ " + seq,
  status: "unassigned",
  start_url: "/x",
  sort_order: seq,
  step_count: 1,
  validation: {},
  site_guess: "pos",
  site_evidence: { confidence: "high" },
  notes: null,
  updated_at: "",
  ...over,
});

test("suggestedSite only accepts pos/admin", () => {
  assert.equal(suggestedSite(guide({ site_guess: "pos" })), "pos");
  assert.equal(suggestedSite(guide({ site_guess: "admin" })), "admin");
  assert.equal(suggestedSite(guide({ site_guess: null })), null);
  assert.equal(suggestedSite(guide({ site_guess: "staging" })), null);
});

test("full success: every target assigned once, progress reported, nothing remaining", async () => {
  const targets = [guide(), guide(), guide()];
  const calls = [];
  const progress = [];
  const r = await runBulkAssign(targets, async (g, site) => { calls.push([g.id, site]); }, (d, t) => progress.push(`${d}/${t}`));
  assert.deepEqual(r.succeeded, targets.map((g) => g.id));
  assert.equal(r.failed, null);
  assert.deepEqual(r.remaining, []);
  assert.equal(calls.length, 3);
  assert.deepEqual(progress, ["1/3", "2/3", "3/3"]);
});

test("failure in the middle stops the run and reports exactly what happened", async () => {
  const targets = [guide(), guide(), guide(), guide(), guide()];
  const bad = targets[2];
  const r = await runBulkAssign(targets, async (g) => {
    if (g.id === bad.id) throw new Error("admin_assign_guide_site: Site pos không tồn tại hoặc đang tắt");
  });
  assert.deepEqual(r.succeeded, [targets[0].id, targets[1].id], "chỉ hai bộ trước điểm lỗi được ghi");
  assert.equal(r.failed?.id, bad.id);
  assert.equal(r.failed?.name, bad.name);
  assert.match(r.failed?.message ?? "", /không tồn tại/);
  assert.deepEqual(r.remaining.map((g) => g.id), targets.slice(2).map((g) => g.id), "còn lại bắt đầu từ bộ lỗi");
});

test("a target without a suggestion fails cleanly instead of calling the RPC", async () => {
  const targets = [guide({ site_guess: null })];
  let called = 0;
  const r = await runBulkAssign(targets, async () => { called++; });
  assert.equal(called, 0);
  assert.equal(r.failed?.id, targets[0].id);
});

test("retry runs only guides still unassigned and never re-sends a success", async () => {
  const snapshot = [guide(), guide(), guide(), guide()];
  const bad = snapshot[1];
  let attempt = 0;
  const sent = [];
  const assign = async (g) => {
    sent.push(g.id);
    if (attempt === 0 && g.id === bad.id) throw new Error("mạng chập chờn");
  };

  // Run 1: fails at index 1.
  let state = snapshot;
  const r1 = await runBulkAssign(snapshot, async (g, site) => {
    await assign(g, site);
    state = applyAssignment(state, g.id, site, "");
  });
  assert.deepEqual(r1.succeeded, [snapshot[0].id]);
  assert.equal(r1.remaining.length, 3);

  // Retry: only the three still-unassigned guides are targeted.
  attempt = 1;
  const again = retryTargets(snapshot, state);
  assert.deepEqual(again.map((g) => g.id), snapshot.slice(1).map((g) => g.id));

  const r2 = await runBulkAssign(again, async (g, site) => {
    await assign(g, site);
    state = applyAssignment(state, g.id, site, "");
  });
  assert.equal(r2.failed, null);
  assert.deepEqual(r2.succeeded, snapshot.slice(1).map((g) => g.id));

  // The guide that succeeded in run 1 was sent exactly once across both runs.
  assert.equal(sent.filter((id) => id === snapshot[0].id).length, 1);
  assert.equal(state.filter((g) => g.status === "unassigned").length, 0);
});

test("a guide triaged by hand after the snapshot was taken is never sent to the RPC", async () => {
  const snapshot = [guide(), guide(), guide()];
  // The operator opened the preview, then assigned the middle guide manually to a site
  // that differs from its suggestion. Bulk must not overwrite that decision.
  const current = applyAssignment(snapshot, snapshot[1].id, "admin", "Quản trị");

  const targets = retryTargets(snapshot, current);
  assert.deepEqual(targets.map((g) => g.id), [snapshot[0].id, snapshot[2].id]);

  const sent = [];
  const r = await runBulkAssign(targets, async (g) => { sent.push(g.id); });
  assert.ok(!sent.includes(snapshot[1].id), "bộ đã phân loại tay không được gọi RPC");
  assert.deepEqual(sent, [snapshot[0].id, snapshot[2].id]);
  assert.equal(r.failed, null);
  assert.equal(current.find((g) => g.id === snapshot[1].id).site_code, "admin", "quyết định tay được giữ nguyên");
});

test("retryTargets on a fully completed snapshot is empty", () => {
  const snapshot = [guide(), guide()];
  const done = snapshot.map((g) => ({ ...g, status: "draft", site_code: "pos" }));
  assert.deepEqual(retryTargets(snapshot, done), []);
});
