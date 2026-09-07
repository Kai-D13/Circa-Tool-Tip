import test from "node:test";
import assert from "node:assert/strict";

import { createHub } from "../src/hub.js";
import { SESSION_ERRORS, createRecorderStore } from "../src/session.js";

/**
 * The worker's behaviour, driven with fakes.
 *
 * The real session store is used rather than a stub: the interesting failures are in how
 * the hub and the store combine (a step written to the wrong tab, a session left holding
 * a tab that no longer exists), and a stubbed store would agree with whatever the hub
 * did. Only Chrome itself is faked.
 */

const TARGETS = ["https://pos.v2.circa.vn", "https://admin.v2.circa.vn"];

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

/** Records everything Chrome was asked to do. */
function fakeTabs({ failCreate = false } = {}) {
  let nextId = 100;
  const created = [];
  const sent = [];
  const removed = [];
  return {
    created,
    sent,
    removed,
    /** Messages pushed to a given tab, in order. */
    to: (tabId) => sent.filter((s) => s.tabId === tabId).map((s) => s.message),
    async create(options) {
      if (failCreate) throw new Error("chrome.tabs.create nổ");
      const tab = { id: nextId++ };
      created.push({ ...options, id: tab.id });
      return tab;
    },
    async sendMessage(tabId, message) {
      sent.push({ tabId, message });
    },
    async remove(tabId) {
      removed.push(tabId);
    },
  };
}

function fakePort(name = "portal") {
  return { name, posted: [], postMessage(message) { this.posted.push(message); }, last() { return this.posted.at(-1); } };
}

function makeHub(opts = {}) {
  const storage = fakeStorage();
  const store = createRecorderStore(storage);
  const tabs = fakeTabs(opts);
  const hub = createHub({
    store,
    tabs,
    targetOrigins: TARGETS,
    info: { extVersion: "0.1.0", schemaVersion: 5 },
  });
  return { hub, store, tabs, storage };
}

const START = (over = {}) => ({
  type: "START",
  payload: {
    session: {
      id: "rec_1",
      guideId: "g1",
      site: "pos",
      startUrl: "https://pos.v2.circa.vn/trang-chu",
      mode: "append",
      ...over,
    },
  },
});

const step = (id) => ({ selectors: ["#" + id], matchText: id, tag: "button", urlPattern: "/trang-chu", origin: TARGETS[0] });

/** Start a recording and capture a few steps, the way a real session gets there. */
async function recording(hub, tabs, count = 3) {
  const port = fakePort();
  await hub.handlePort(START(), port);
  const tabId = tabs.created.at(-1).id;
  for (let i = 0; i < count; i++) await hub.handleContent("tg:step", { sessionId: "rec_1", step: step("s" + i) }, tabId);
  return { port, tabId };
}

/* ---------------------------------------------------------------------- one-shot */

test("HELLO reports the versions the Portal checks compatibility against", async () => {
  const { hub } = makeHub();
  const reply = await hub.handleOneShot({ type: "HELLO", payload: {} });
  assert.equal(reply.ok, true);
  assert.equal(reply.data.extVersion, "0.1.0");
  assert.equal(reply.data.schemaVersion, 5);
});

test("GET_RECORDING is how the Portal survives a dead port", async () => {
  const { hub, tabs } = makeHub();
  await recording(hub, tabs, 2);
  const reply = await hub.handleOneShot({ type: "GET_RECORDING", payload: { sessionId: "rec_1" } });
  assert.equal(reply.data.session.steps.length, 2);

  const missing = await hub.handleOneShot({ type: "GET_RECORDING", payload: { sessionId: "nope" } });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "NO_SESSION");
});

/* -------------------------------------------------------------------------- START */

test("START opens the tab and binds the session to it", async () => {
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(START(), port);

  assert.equal(tabs.created.length, 1);
  assert.equal(tabs.created[0].url, "https://pos.v2.circa.vn/trang-chu");
  assert.equal(port.last().type, "READY");
  assert.equal(port.last().data.session.tabId, tabs.created[0].id);
  assert.equal((await store.findByTab(tabs.created[0].id)).id, "rec_1");
});

test("START refuses a URL the extension has no business opening, and opens nothing", async () => {
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(START({ startUrl: "https://evil.example/" }), port);

  assert.equal(port.last().ok, false);
  assert.equal(port.last().error.code, "BAD_URL");
  assert.equal(tabs.created.length, 0, "không được mở tab nào");
  assert.equal(await store.get("rec_1"), null, "không được tạo phiên ghi nào");
});

test("a tab that fails to open leaves no orphan session", async () => {
  const { hub, store } = makeHub({ failCreate: true });
  const port = fakePort();
  await assert.rejects(() => hub.handlePort(START(), port));
  assert.equal(await store.get("rec_1"), null, "phiên ghi phải bị dọn");
});

/* --------------------------------------------------------------------------- UNDO */

test("P1 REGRESSION: Undo updates the Portal AND the page being recorded", async () => {
  // Undo happens entirely between the Portal and the worker. The content script renders
  // its counter from its own copy of the session, so without a push it keeps showing the
  // step that was just removed.
  const { hub, tabs } = makeHub();
  const { port, tabId } = await recording(hub, tabs, 3);
  const before = tabs.to(tabId).length;

  await hub.handlePort({ type: "UNDO", payload: { sessionId: "rec_1" } }, port);

  assert.equal(port.last().type, "UNDO");
  assert.equal(port.last().data.session.steps.length, 2, "Portal phải thấy 2 bước");

  const pushed = tabs.to(tabId).slice(before);
  assert.equal(pushed.length, 1, "phải đẩy đúng một lệnh xuống tab đang ghi");
  assert.equal(pushed[0].type, "tg:session");
  assert.equal(pushed[0].session.steps.length, 2, "trang đang ghi cũng phải thấy 2 bước");
  assert.equal(pushed[0].session.id, "rec_1");
});

test("Undo on a session that is gone tells the Portal and pushes nothing", async () => {
  const { hub, tabs } = makeHub();
  const port = fakePort();
  await hub.handlePort({ type: "UNDO", payload: { sessionId: "khong-co" } }, port);
  assert.equal(port.last().ok, false);
  assert.equal(port.last().error.code, "NO_SESSION");
  assert.equal(tabs.sent.length, 0);
});

/* --------------------------------------------------------------------------- STOP */

test("STOP disarms the page before it answers the Portal", async () => {
  const { hub, tabs } = makeHub();
  const { port, tabId } = await recording(hub, tabs, 2);
  await hub.handlePort({ type: "STOP", payload: { sessionId: "rec_1" } }, port);

  assert.deepEqual(tabs.to(tabId).at(-1), { type: "tg:disarm" });
  assert.equal(port.last().type, "DONE");
  assert.equal(port.last().data.session.status, "done");
  assert.equal(port.last().data.session.steps.length, 2, "dừng ghi không được vứt bước đã ghi");
});

/* ---------------------------------------------------------------- content script */

test("a step from the recorded tab reaches storage and the Portal", async () => {
  const { hub, tabs } = makeHub();
  const { port, tabId } = await recording(hub, tabs, 0);

  const reply = await hub.handleContent("tg:step", { sessionId: "rec_1", step: step("a") }, tabId);
  assert.equal(reply.ok, true);
  assert.equal(reply.data.session.steps.length, 1);
  assert.equal(port.last().type, "STEP");
  assert.equal(port.last().data.session.steps.length, 1);
});

test("a step from another tab is refused", async () => {
  const { hub, tabs, store } = makeHub();
  const { tabId } = await recording(hub, tabs, 1);

  await assert.rejects(
    () => hub.handleContent("tg:step", { sessionId: "rec_1", step: step("x") }, tabId + 1),
    (err) => {
      assert.equal(err.code, SESSION_ERRORS.TAB_MISMATCH);
      return true;
    },
  );
  assert.equal((await store.get("rec_1")).steps.length, 1, "không được ghi thêm bước nào");
});

test("the handshake tells a page which tab it is and what job it is running", async () => {
  const { hub, tabs } = makeHub();
  const { tabId } = await recording(hub, tabs, 1);

  const inside = await hub.handleContent("tg:hello", {}, tabId);
  assert.equal(inside.data.tabId, tabId);
  assert.equal(inside.data.job.id, "rec_1");
  assert.equal(inside.data.job.kind, "record", "trang phải biết nó đang ghi chứ không phải chạy thử");

  const outside = await hub.handleContent("tg:hello", {}, tabId + 5);
  assert.equal(outside.data.job, null, "tab không có việc gì thì không được trả phiên nào");
});

test("a navigation from an unrecorded tab is ignored, not broadcast", async () => {
  const { hub, tabs } = makeHub();
  const { port, tabId } = await recording(hub, tabs, 0);
  const before = port.posted.length;

  await hub.handleContent("tg:navigated", { url: "/khac" }, tabId + 9);
  assert.equal(port.posted.length, before, "không được đẩy NAVIGATED của tab lạ");

  await hub.handleContent("tg:navigated", { url: "/don-hang" }, tabId);
  assert.equal(port.last().type, "NAVIGATED");
  assert.equal(port.last().data.url, "/don-hang");
});

/* ------------------------------------------------------------------ tab lifecycle */

test("closing the recorded tab ends the recording and keeps the steps", async () => {
  const { hub, tabs, store } = makeHub();
  const { port, tabId } = await recording(hub, tabs, 2);

  await hub.onTabRemoved(tabId);

  assert.equal(port.last().type, "DONE");
  assert.equal(port.last().data.reason, "tab-closed");
  const session = await store.get("rec_1");
  assert.equal(session.status, "done");
  assert.equal(session.steps.length, 2);
});

test("closing an unrelated tab does nothing", async () => {
  const { hub, tabs, store } = makeHub();
  const { tabId } = await recording(hub, tabs, 1);
  await hub.onTabRemoved(tabId + 3);
  assert.equal((await store.get("rec_1")).status, "recording");
});

test("a disconnected port stops receiving pushes", async () => {
  const { hub, tabs } = makeHub();
  const { port, tabId } = await recording(hub, tabs, 0);
  hub.releasePort(port);
  const before = port.posted.length;

  await hub.handleContent("tg:step", { sessionId: "rec_1", step: step("a") }, tabId);
  assert.equal(port.posted.length, before, "port đã ngắt thì không được gửi thêm");
  assert.equal(hub.ports.size, 0);
});

test("a port that throws on send is dropped rather than retried forever", async () => {
  const { hub, tabs } = makeHub();
  const port = fakePort();
  await hub.handlePort(START(), port);
  const tabId = tabs.created.at(-1).id;

  port.postMessage = () => {
    throw new Error("port đã đóng");
  };
  await hub.handleContent("tg:step", { sessionId: "rec_1", step: step("a") }, tabId);
  assert.equal(hub.ports.size, 0);
});

/* ================================================ 2B.2C: probe và chạy thử */

const STEP = {
  id: "st_1",
  selectors: ["#basic-button"],
  matchText: "Cài Đặt",
  tag: "button",
  title: "Mở Cài Đặt",
  content: "",
  urlPattern: "/trang-chu",
  navigationUrl: "/trang-chu",
  action: { type: "click_next", expectedUrl: "", timeoutMs: 0 },
};

const PROBE = (over = {}) => ({
  type: "PROBE_SELECTOR",
  payload: {
    sessionId: "prb_1",
    probeId: "st_1",
    guideId: "g1",
    site: "pos",
    url: "https://pos.v2.circa.vn/trang-chu",
    step: STEP,
    ...over,
  },
});

const PREVIEW = (over = {}) => ({
  type: "PREVIEW_GUIDE",
  payload: {
    sessionId: "pvw_1",
    guideId: "g1",
    site: "pos",
    url: "https://pos.v2.circa.vn/trang-chu",
    guide: { name: "BÁN HÀNG", site: "pos", steps: [STEP, { ...STEP, id: "st_2", urlPattern: "/don-hang" }] },
    sites: { pos: "https://pos.v2.circa.vn", admin: "https://admin.v2.circa.vn" },
    ...over,
  },
});

/* -------------------------------------------------------------- PROBE_SELECTOR */

test("a probe opens the step's page and waits for the page to answer", async () => {
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(PROBE(), port);

  assert.equal(tabs.created.length, 1);
  assert.equal(tabs.created[0].url, "https://pos.v2.circa.vn/trang-chu");
  assert.equal(port.posted.length, 0, "chưa có kết quả nào trước khi trang trả lời");

  const session = await store.get("prb_1");
  assert.equal(session.kind, "probe");
  assert.equal(session.job.probeId, "st_1");
});

test("the page's answer reaches the Portal", async () => {
  const { hub, tabs } = makeHub();
  const port = fakePort();
  await hub.handlePort(PROBE(), port);
  const tabId = tabs.created.at(-1).id;

  const result = { ok: true, candidates: [{ selector: "#basic-button", count: 9 }], resolved: { via: "text" } };
  const reply = await hub.handleContent(
    "tg:probe-result",
    { probeId: "st_1", url: "/trang-chu", result },
    tabId,
  );

  assert.equal(reply.data.ignored, false);
  assert.equal(port.last().type, "PROBE_RESULT");
  assert.equal(port.last().data.probeId, "st_1");
  assert.equal(port.last().data.result.candidates[0].count, 9);
});

test("probing a second step reuses the session and closes the previous tab", async () => {
  // One tab, not one tab per click.
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(PROBE(), port);
  const firstTab = tabs.created.at(-1).id;

  await hub.handlePort(PROBE({ probeId: "st_2", url: "https://pos.v2.circa.vn/don-hang" }), port);
  const secondTab = tabs.created.at(-1).id;

  assert.notEqual(secondTab, firstTab);
  assert.deepEqual(tabs.removed, [firstTab], "tab cũ phải được đóng");
  const session = await store.get("prb_1");
  assert.equal(session.tabId, secondTab);
  assert.equal(session.job.probeId, "st_2");
});

test("a late answer to an old probe never overwrites the current one", async () => {
  const { hub, tabs } = makeHub();
  const port = fakePort();
  await hub.handlePort(PROBE(), port);
  await hub.handlePort(PROBE({ probeId: "st_2" }), port);
  const tabId = tabs.created.at(-1).id;

  const stale = await hub.handleContent("tg:probe-result", { probeId: "st_1", result: { ok: true } }, tabId);
  assert.equal(stale.data.ignored, true);
  assert.equal(port.posted.length, 0, "kết quả cũ không được đẩy lên Portal");
});

test("a probe refuses a URL outside the sites the extension runs on", async () => {
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(PROBE({ url: "https://evil.example/" }), port);

  assert.equal(port.last().error.code, "BAD_URL");
  assert.equal(tabs.created.length, 0);
  assert.equal(await store.get("prb_1"), null);
});

test("a probe without a usable step is refused before anything opens", async () => {
  const { hub, tabs } = makeHub();
  const port = fakePort();
  for (const bad of [undefined, null, {}, { selectors: "#a" }, "step"]) {
    await hub.handlePort(PROBE({ step: bad }), port);
    assert.equal(port.last().error.code, "BAD_STEP", `step ${JSON.stringify(bad)} phải bị từ chối`);
  }
  assert.equal(tabs.created.length, 0);
});

test("a probe result from a tab running something else is refused", async () => {
  const { hub, tabs } = makeHub();
  const { tabId } = await recording(hub, tabs, 1);
  const reply = await hub.handleContent("tg:probe-result", { probeId: "st_1", result: {} }, tabId);
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, "NO_SESSION");
});

/* --------------------------------------------------------------- PREVIEW_GUIDE */

test("preview carries the draft in the message and touches no database", async () => {
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(PREVIEW(), port);

  assert.equal(port.last().type, "PREVIEW_READY");
  assert.equal(tabs.created[0].url, "https://pos.v2.circa.vn/trang-chu");

  const session = await store.get("pvw_1");
  assert.equal(session.kind, "preview");
  assert.equal(session.index, 0);
  assert.equal(session.job.guide.steps.length, 2, "bản nháp đi kèm message, không đọc lại từ đâu cả");
  assert.equal(session.job.sites.admin, "https://admin.v2.circa.vn");
});

test("preview refuses a guide with no steps, and a URL it may not open", async () => {
  const { hub, tabs } = makeHub();
  const port = fakePort();

  await hub.handlePort(PREVIEW({ guide: { name: "trống", steps: [] } }), port);
  assert.equal(port.last().error.code, "BAD_STEP");

  await hub.handlePort(PREVIEW({ url: "https://evil.example/" }), port);
  assert.equal(port.last().error.code, "BAD_URL");
  assert.equal(tabs.created.length, 0);
});

test("moving through a preview is persisted, so a navigation cannot lose the place", async () => {
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(PREVIEW(), port);
  const tabId = tabs.created.at(-1).id;

  await hub.handleContent("tg:preview-step", { index: 1 }, tabId);

  assert.equal((await store.get("pvw_1")).index, 1);
  assert.equal(port.last().type, "PREVIEW_STEP");
  assert.deepEqual({ ...port.last().data }, { index: 1, total: 2 });
});

test("a preview step from the wrong tab is refused", async () => {
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(PREVIEW(), port);
  const tabId = tabs.created.at(-1).id;

  const reply = await hub.handleContent("tg:preview-step", { index: 1 }, tabId + 4);
  assert.equal(reply.ok, false);
  assert.equal((await store.get("pvw_1")).index, 0, "vị trí không được đổi");
});

test("a nonsense index is refused rather than stored", async () => {
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(PREVIEW(), port);
  const tabId = tabs.created.at(-1).id;

  for (const bad of [-1, 1.5, "hai", null]) {
    await assert.rejects(() => hub.handleContent("tg:preview-step", { index: bad }, tabId));
  }
  assert.equal((await store.get("pvw_1")).index, 0);
});

test("exiting from the page ends the preview and tells the Portal", async () => {
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(PREVIEW(), port);
  const tabId = tabs.created.at(-1).id;

  await hub.handleContent("tg:preview-step", { exit: true }, tabId);

  assert.equal((await store.get("pvw_1")).status, "done");
  assert.equal(port.last().type, "PREVIEW_DONE");
  assert.equal(port.last().data.reason, "exited");
});

test("stopping from the Portal disarms the page", async () => {
  const { hub, tabs } = makeHub();
  const port = fakePort();
  await hub.handlePort(PREVIEW(), port);
  const tabId = tabs.created.at(-1).id;

  await hub.handlePort({ type: "PREVIEW_STOP", payload: { sessionId: "pvw_1" } }, port);

  assert.deepEqual(tabs.to(tabId).at(-1), { type: "tg:disarm" });
  assert.equal(port.last().type, "PREVIEW_DONE");
});

test("closing the preview tab ends the preview", async () => {
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(PREVIEW(), port);
  const tabId = tabs.created.at(-1).id;

  await hub.onTabRemoved(tabId);
  assert.equal((await store.get("pvw_1")).status, "done");
  assert.equal(port.last().type, "DONE");
});

test("a recording, a probe and a preview can coexist on different tabs", async () => {
  const { hub, tabs, store } = makeHub();
  const recPort = fakePort();
  await hub.handlePort(START(), recPort);
  const recTab = tabs.created.at(-1).id;

  const toolPort = fakePort();
  await hub.handlePort(PREVIEW(), toolPort);
  const previewTab = tabs.created.at(-1).id;
  await hub.handlePort(PROBE(), toolPort);
  const probeTab = tabs.created.at(-1).id;

  assert.equal(new Set([recTab, previewTab, probeTab]).size, 3);
  assert.equal((await store.findByTab(recTab)).kind, "record");
  assert.equal((await store.findByTab(previewTab)).kind, "preview");
  assert.equal((await store.findByTab(probeTab)).kind, "probe");

  // And a step captured on the recording tab still lands in the recording.
  await hub.handleContent("tg:step", { sessionId: "rec_1", step: step("z") }, recTab);
  assert.equal((await store.get("rec_1")).steps.length, 1);
  assert.equal((await store.get("pvw_1")).index, 0);
});
