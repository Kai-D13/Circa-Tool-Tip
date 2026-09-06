import test from "node:test";
import assert from "node:assert/strict";

import { RECORDER_PREFIX, createRecorderStore, recorderKey } from "../src/session.js";

/** Stand-in for chrome.storage.session, including its get(null) -> everything behaviour. */
function fakeStorage(initial = {}) {
  let bag = { ...initial };
  return {
    dump: () => ({ ...bag }),
    async get(keys) {
      if (keys === null || keys === undefined) return { ...bag };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in bag) out[k] = bag[k];
      return out;
    },
    async set(items) {
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

test("start requires the fields the recorder cannot work without", async () => {
  const store = createRecorderStore(fakeStorage());
  await assert.rejects(() => store.start({ guideId: "g", site: "pos" }), /thiếu id/);
  await assert.rejects(() => store.start({ id: "s", site: "pos" }), /thiếu guideId/);
  await assert.rejects(() => store.start({ id: "s", guideId: "g" }), /thiếu site/);
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
