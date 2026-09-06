import test from "node:test";
import assert from "node:assert/strict";

import { RECORDER_PREFIX, SESSION_ERRORS, createRecorderStore, recorderKey } from "../src/session.js";

/**
 * Stand-in for chrome.storage.session, including its get(null) -> everything behaviour.
 *
 * `slow` inserts a real await between the read and the write of every operation. That is
 * what a race needs in order to show up: without it two operations can happen to run to
 * completion one after the other and a broken lock still looks fine.
 */
function fakeStorage(initial = {}, { slow = false } = {}) {
  let bag = { ...initial };
  const tick = () => (slow ? new Promise((r) => setTimeout(r, 1)) : Promise.resolve());
  return {
    dump: () => ({ ...bag }),
    async get(keys) {
      await tick();
      if (keys === null || keys === undefined) return { ...bag };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in bag) out[k] = bag[k];
      return out;
    },
    async set(items) {
      await tick();
      bag = { ...bag, ...items };
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete bag[k];
    },
  };
}

const started = { id: "s1", guideId: "g1", site: "pos", startUrl: "/trang-chu", tabId: 7 };
const step = (id) => ({ id, selectors: ["button.a"], matchText: "A" });

test("a session is written under a namespaced key so it is findable after a restart", async () => {
  const storage = fakeStorage();
  const store = createRecorderStore(storage);
  await store.start(started);
  assert.ok(recorderKey("s1").startsWith(RECORDER_PREFIX));
  assert.ok(recorderKey("s1") in storage.dump(), "phải nằm trong storage, không phải biến trong worker");
});

test("P1: a malformed payload is INVALID_SESSION, not SESSION_EXISTS", async () => {
  // The Portal uses the code to decide whether retrying could ever help. "Thiếu guideId"
  // reported as SESSION_EXISTS would send it looking for a session that never existed.
  const store = createRecorderStore(fakeStorage());
  for (const bad of [{ guideId: "g", site: "pos" }, { id: "s", site: "pos" }, { id: "s", guideId: "g" }]) {
    await assert.rejects(() => store.start(bad), (err) => {
      assert.equal(err.code, SESSION_ERRORS.INVALID_SESSION);
      return true;
    });
  }
});

test("steps accumulate in order", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start(started);
  await store.appendStep("s1", step("a"));
  const s = await store.appendStep("s1", step("b"));
  assert.deepEqual(s.steps.map((x) => x.id), ["a", "b"]);
});

test("SIMULATED WORKER RESTART: a new store instance still sees the session", async () => {
  // The whole reason state lives in storage.session rather than in the worker.
  const storage = fakeStorage();
  await createRecorderStore(storage).start(started);
  await createRecorderStore(storage).appendStep("s1", step("a"));

  const afterRestart = createRecorderStore(storage);
  const s = await afterRestart.get("s1");
  assert.equal(s.status, "recording");
  assert.deepEqual(s.steps.map((x) => x.id), ["a"]);
});

test("undo removes only the last step and is safe on an empty session", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start(started);
  await store.appendStep("s1", step("a"));
  await store.appendStep("s1", step("b"));
  assert.deepEqual((await store.undo("s1")).steps.map((x) => x.id), ["a"]);
  assert.deepEqual((await store.undo("s1")).steps, []);
  assert.deepEqual((await store.undo("s1")).steps, [], "undo trên phiên rỗng không được lỗi");
});

test("stop freezes the session but keeps the steps readable", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start(started);
  await store.appendStep("s1", step("a"));
  const stopped = await store.stop("s1");
  assert.equal(stopped.status, "done");
  assert.ok(stopped.stoppedAt);
  assert.deepEqual((await store.get("s1")).steps.map((x) => x.id), ["a"], "Portal vẫn lấy được bước đã ghi");
});

test("writes to a stopped session are refused instead of silently resurrecting it", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start(started);
  await store.stop("s1");
  assert.equal(await store.appendStep("s1", step("x")), null);
  assert.equal(await store.undo("s1"), null);
});

test("an unknown session reads as null, not as a crash", async () => {
  const store = createRecorderStore(fakeStorage());
  assert.equal(await store.get("nope"), null);
  assert.equal(await store.appendStep("nope", step("x")), null);
  assert.equal(await store.stop("nope"), null);
});

test("findByTab returns the recording session bound to that tab only", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start(started);
  await store.start({ ...started, id: "s2", tabId: 99 });
  assert.equal((await store.findByTab(7)).id, "s1");
  assert.equal((await store.findByTab(99)).id, "s2");
  assert.equal(await store.findByTab(1234), null);

  await store.stop("s1");
  assert.equal(await store.findByTab(7), null, "phiên đã dừng không còn được coi là đang ghi");
});

test("discard removes the session entirely", async () => {
  const storage = fakeStorage();
  const store = createRecorderStore(storage);
  await store.start(started);
  await store.discard("s1");
  assert.equal(await store.get("s1"), null);
  assert.deepEqual(Object.keys(storage.dump()), []);
});

test("attachTab binds a session to the tab the recorder opened", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start({ ...started, tabId: null });
  assert.equal((await store.attachTab("s1", 42)).tabId, 42);
  assert.equal((await store.findByTab(42)).id, "s1");
});

/* ------------------------------------------------------------------ invariants */

test("P1: an active session id cannot be started over the top of itself", async () => {
  // A double-click on START would otherwise wipe every step already captured.
  const store = createRecorderStore(fakeStorage());
  await store.start(started);
  await store.appendStep("s1", step("a"));

  await assert.rejects(() => store.start(started), (err) => {
    assert.equal(err.code, SESSION_ERRORS.SESSION_EXISTS);
    return true;
  });
  assert.deepEqual((await store.get("s1")).steps.map((x) => x.id), ["a"], "bước đã ghi không được mất");
});

test("a finished session id may be reused", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start(started);
  await store.stop("s1");
  const again = await store.start(started);
  assert.equal(again.status, "recording");
  assert.deepEqual(again.steps, []);
});

test("P1: a tab can host only one recording session", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start(started);                       // tab 7
  await assert.rejects(
    () => store.start({ ...started, id: "s2" }),    // cũng tab 7
    (err) => {
      assert.equal(err.code, SESSION_ERRORS.TAB_BUSY);
      assert.match(err.message, /s1/, "phải nói rõ phiên nào đang giữ tab");
      return true;
    },
  );
  assert.equal(await store.get("s2"), null, "phiên thứ hai không được tạo ra");
});

test("a tab frees up once its session stops", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start(started);
  await store.stop("s1");
  const s2 = await store.start({ ...started, id: "s2" });
  assert.equal(s2.tabId, 7);
});

test("P1: attachTab refuses a tab another session is recording on", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start(started);                                  // s1 giữ tab 7
  await store.start({ ...started, id: "s2", tabId: null });
  await assert.rejects(() => store.attachTab("s2", 7), (err) => {
    assert.equal(err.code, SESSION_ERRORS.TAB_BUSY);
    return true;
  });
  assert.equal((await store.get("s2")).tabId, null);
});

test("attaching a session to the tab it already holds is allowed", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start(started);
  assert.equal((await store.attachTab("s1", 7)).tabId, 7);
});

test("P1: findByTab refuses to guess when the invariant is broken", async () => {
  // Reach into storage directly to fabricate the corrupt state start() prevents.
  const storage = fakeStorage();
  const store = createRecorderStore(storage);
  await store.start(started);
  await storage.set({
    [recorderKey("rogue")]: { v: 1, id: "rogue", status: "recording", tabId: 7, steps: [] },
  });
  await assert.rejects(() => store.findByTab(7), (err) => {
    assert.equal(err.code, SESSION_ERRORS.DUPLICATE_TAB);
    return true;
  });
});

test("P1: concurrent appends do not lose steps", async () => {
  // appendStep is read-modify-write against storage; without serialisation the later
  // write clobbers the earlier one and a captured click disappears.
  const store = createRecorderStore(fakeStorage());
  await store.start(started);
  await Promise.all([
    store.appendStep("s1", step("a")),
    store.appendStep("s1", step("b")),
    store.appendStep("s1", step("c")),
  ]);
  const ids = (await store.get("s1")).steps.map((x) => x.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("concurrent append and undo settle to a consistent session", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start(started);
  await store.appendStep("s1", step("a"));
  await Promise.all([store.appendStep("s1", step("b")), store.undo("s1")]);
  const steps = (await store.get("s1")).steps;
  assert.equal(steps.length, 1, "một thêm + một xoá phải còn đúng một bước");
});

/* --------------------------------------- P0: race giữa các session KHÁC id */

test("P0: two concurrent starts on the same tab — exactly one wins", async () => {
  // A per-session lock does not help here: the ids differ, so both would read "tab 7 is
  // free" and both would write themselves onto it.
  const store = createRecorderStore(fakeStorage({}, { slow: true }));
  const results = await Promise.allSettled([
    store.start({ ...started, id: "s1" }),
    store.start({ ...started, id: "s2" }),
  ]);

  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "đúng một phiên được tạo");
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.code, SESSION_ERRORS.TAB_BUSY);

  // And the invariant actually holds in storage, not just in the return values.
  assert.doesNotReject(() => store.findByTab(7));
  assert.equal((await store.findByTab(7)).id, won[0].value.id);
});

test("P0: many concurrent starts on the same tab still leave one recorder", async () => {
  const store = createRecorderStore(fakeStorage({}, { slow: true }));
  const results = await Promise.allSettled(
    ["a", "b", "c", "d", "e"].map((id) => store.start({ ...started, id })),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results.filter((x) => x.status === "rejected")) {
    assert.equal(r.reason.code, SESSION_ERRORS.TAB_BUSY);
  }
  const session = await store.findByTab(7);   // ném DUPLICATE_TAB nếu invariant hỏng
  assert.ok(session);
});

test("P0: two concurrent attachTab calls on the same tab — exactly one wins", async () => {
  const store = createRecorderStore(fakeStorage({}, { slow: true }));
  await store.start({ ...started, id: "s1", tabId: null });
  await store.start({ ...started, id: "s2", tabId: null });

  const results = await Promise.allSettled([store.attachTab("s1", 7), store.attachTab("s2", 7)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, SESSION_ERRORS.TAB_BUSY);
  assert.ok(await store.findByTab(7));
});

test("P0: concurrent start and attachTab cannot both claim a tab", async () => {
  const store = createRecorderStore(fakeStorage({}, { slow: true }));
  await store.start({ ...started, id: "s1", tabId: null });
  const results = await Promise.allSettled([
    store.attachTab("s1", 7),
    store.start({ ...started, id: "s2", tabId: 7 }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(await store.findByTab(7));
});

test("P0: a rejected operation does not stall the queue", async () => {
  const store = createRecorderStore(fakeStorage({}, { slow: true }));
  await store.start(started);

  await assert.rejects(() => store.start({ ...started, id: "s2" }));   // TAB_BUSY
  // The queue must keep serving after that rejection.
  const after = await store.appendStep("s1", step("a"));
  assert.deepEqual(after.steps.map((x) => x.id), ["a"]);
  assert.equal((await store.stop("s1")).status, "done");
});

test("P0: no interleaving of mutations ever produces DUPLICATE_TAB", async () => {
  const store = createRecorderStore(fakeStorage({}, { slow: true }));
  await Promise.allSettled([
    store.start({ ...started, id: "s1" }),
    store.start({ ...started, id: "s2" }),
    store.start({ ...started, id: "s3", tabId: 8 }),
    store.appendStep("s1", step("x")),
    store.attachTab("s2", 7),
  ]);
  for (const tab of [7, 8, 9]) {
    await assert.doesNotReject(() => store.findByTab(tab), `tab ${tab} bị trùng recorder`);
  }
});

/* ------------------------------------- 2B.2B: bước chỉ đến từ đúng tab đang ghi */

test("a step is refused when it comes from a tab the session is not recording", async () => {
  // Every page on pos/admin runs the content script, and any of them can send a message.
  // Without this check a second POS tab could push its own clicks into somebody else's
  // recording, and the operator would only find out when the guide replays wrong.
  const store = createRecorderStore(fakeStorage());
  await store.start({ ...started, tabId: 7 });

  await assert.rejects(() => store.appendStep("s1", step("a"), 9), (err) => {
    assert.equal(err.code, SESSION_ERRORS.TAB_MISMATCH);
    return true;
  });

  const session = await store.get("s1");
  assert.deepEqual(session.steps, [], "bước từ tab lạ không được ghi vào");
});

test("a step from the recorded tab is appended", async () => {
  const store = createRecorderStore(fakeStorage());
  await store.start({ ...started, tabId: 7 });
  const after = await store.appendStep("s1", step("a"), 7);
  assert.deepEqual(after.steps.map((x) => x.id), ["a"]);
});

test("omitting the tab keeps the Portal-side callers working", async () => {
  // undo/stop come from the Portal over the port, where there is no tab to check.
  const store = createRecorderStore(fakeStorage());
  await store.start({ ...started, tabId: 7 });
  const after = await store.appendStep("s1", step("a"));
  assert.deepEqual(after.steps.map((x) => x.id), ["a"]);
});
