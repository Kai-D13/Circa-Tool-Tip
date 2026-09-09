import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import * as SCHEMA from "../../../packages/guide-schema/src/index.ts";
import { createHub } from "../src/hub.js";
import { SESSION_ERRORS, createRecorderStore } from "../src/session.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * tour.js is a classic script the worker imports for its side effect. Loaded the same way
 * here so the hub is driven by the REAL decision table — a stub would let the resume
 * logic agree with whatever the test wanted.
 */
function loadTour() {
  const ctx = vm.createContext({ console });
  for (const f of ["../src/resolve.js", "../src/tour.js"]) {
    vm.runInContext(readFileSync(resolve(HERE, f), "utf8"), ctx);
  }
  return ctx.TG_TOUR;
}

const TOUR = loadTour();

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

/** Counts calls so "one pipeline" is an assertion rather than a hope. */
function fakeSync() {
  const calls = { syncAll: 0, status: 0 };
  return {
    calls,
    async syncAll() {
      calls.syncAll++;
      return { ok: true, sites: [{ site: "pos", action: "updated", revision: 3 }] };
    },
    async status() {
      calls.status++;
      return { pos: { state: "ok", revision: 3 }, admin: { state: "no-release", revision: 0 } };
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
  const sync = opts.sync === null ? null : (opts.sync ?? fakeSync());
  const hub = createHub({
    store,
    tabs,
    targetOrigins: TARGETS,
    info: { extVersion: "0.1.0", schemaVersion: 5 },
    sync,
  });
  return { hub, store, tabs, storage, sync };
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
  // The Portal gates features on this list; a capability missing here is a feature it
  // will refuse to use even though the build supports it.
  assert.deepEqual([...reply.data.capabilities].sort(), ["preview", "probe", "record", "sync"]);
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

test("P0 REGRESSION: closing the preview tab reports PREVIEW_DONE, not DONE", async () => {
  // The Portal's preview state only listens for PREVIEW_DONE. Reporting a closed preview
  // tab as DONE leaves the panel stuck on "Đang chạy thử" with no way back.
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(PREVIEW(), port);
  const tabId = tabs.created.at(-1).id;

  await hub.onTabRemoved(tabId);

  assert.equal((await store.get("pvw_1")).status, "done");
  assert.equal(port.last().type, "PREVIEW_DONE");
  assert.equal(port.last().data.reason, "tab-closed");
});

test("P0 REGRESSION: closing the probe tab releases the Portal's busy state", async () => {
  // The page never answered and never will; silence leaves the button on
  // "Đang kiểm tra…" forever.
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(PROBE(), port);
  const tabId = tabs.created.at(-1).id;

  await hub.onTabRemoved(tabId);

  assert.equal(port.last().ok, false);
  assert.equal(port.last().type, "PROBE_RESULT");
  assert.equal(port.last().error.code, "TAB_CLOSED");
  assert.equal((await store.get("prb_1")).status, "done");
});

test("closing a recording tab still reports DONE", async () => {
  const { hub, tabs } = makeHub();
  const { port, tabId } = await recording(hub, tabs, 2);
  await hub.onTabRemoved(tabId);
  assert.equal(port.last().type, "DONE");
  assert.equal(port.last().data.reason, "tab-closed");
});

test("a closed probe tab does not block the next probe", async () => {
  const { hub, tabs, store } = makeHub();
  const port = fakePort();
  await hub.handlePort(PROBE(), port);
  await hub.onTabRemoved(tabs.created.at(-1).id);

  await hub.handlePort(PROBE({ probeId: "st_2" }), port);
  const session = await store.get("prb_1");
  assert.equal(session.status, "recording");
  assert.equal(session.job.probeId, "st_2");
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

/* ================================================= 3A: đồng bộ release */

test("SYNC_NOW chạy pipeline và trả kết quả từng site", async () => {
  const { hub, sync } = makeHub();
  const reply = await hub.handleOneShot({ type: "SYNC_NOW", payload: {} });

  assert.equal(reply.ok, true);
  assert.equal(sync.calls.syncAll, 1);
  assert.equal(reply.data.sites[0].action, "updated");
});

test("GET_SYNC_STATUS nói máy này đang giữ bản nào", async () => {
  const { hub } = makeHub();
  const reply = await hub.handleOneShot({ type: "GET_SYNC_STATUS", payload: {} });

  assert.equal(reply.data.sites.pos.revision, 3);
  assert.equal(reply.data.sites.admin.state, "no-release");
});

test("build không có cấu hình Supabase thì nói thẳng, không giả vờ đồng bộ", async () => {
  const { hub } = makeHub({ sync: null });

  for (const type of ["SYNC_NOW", "GET_SYNC_STATUS"]) {
    const reply = await hub.handleOneShot({ type, payload: {} });
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, "NOT_CONFIGURED");
    assert.match(reply.error.message, /build lại/i);
  }

  // Và HELLO không được quảng cáo một khả năng sẽ hỏng ngay lần dùng đầu tiên.
  const hello = await hub.handleOneShot({ type: "HELLO", payload: {} });
  assert.ok(!hello.data.capabilities.includes("sync"));
});

test("recorder vẫn chạy bình thường trên build không có cấu hình đồng bộ", async () => {
  // Thiếu key Supabase không được kéo theo cả tính năng ghi hướng dẫn.
  const { hub, tabs } = makeHub({ sync: null });
  const port = fakePort();
  await hub.handlePort(START(), port);
  assert.equal(port.last().type, "READY");
  assert.equal(tabs.created.length, 1);
});

/* ======================= 3B: chạy guide thật từ cache =========================== */

const SITE_ORIGINS = { pos: "https://pos.v2.circa.vn", admin: "https://admin.v2.circa.vn" };

const liveStep = (over = {}) => ({
  id: "st_1",
  site: "pos",
  selectors: ["#basic-button"],
  matchText: "Cài Đặt",
  tag: "button",
  title: "Mở Cài Đặt",
  content: "",
  urlPattern: "/trang-chu",
  navigationUrl: "/trang-chu",
  action: { type: "click_next", expectedUrl: "", timeoutMs: 0 },
  ...over,
});

const releaseGuide = (over = {}) => ({
  id: "g1",
  legacyId: null,
  name: "BÁN HÀNG TẠI QUẦY",
  site: "pos",
  group: "Bán hàng",
  sortOrder: 0,
  start: { site: "pos", url: "/trang-chu" },
  steps: [liveStep(), liveStep({ id: "st_2", urlPattern: "/don-hang", navigationUrl: "/don-hang" })],
  ...over,
});

const releasePayload = (over = {}) => ({
  schemaVersion: 5,
  site: "pos",
  revision: 3,
  releasedAt: "2026-09-08T10:00:00.000Z",
  checksum: "sha256:aaa",
  sites: SITE_ORIGINS,
  groups: ["Bán hàng"],
  guides: [releaseGuide()],
  ...over,
});

/** A sync stand-in whose cache the test can swap mid-tour. */
function fakeReleaseCache(initial = { pos: releasePayload() }) {
  const cache = { ...initial };
  return {
    cache,
    async readCache(site) {
      return cache[site] ?? null;
    },
    async status() {
      const out = {};
      for (const [site, payload] of Object.entries(cache)) {
        out[site] = { site, state: "ok", revision: payload.revision, checksum: payload.checksum };
      }
      return out;
    },
    async syncAll() {
      return { ok: true, sites: [] };
    },
  };
}

function liveHub(opts = {}) {
  const storage = fakeStorage();
  const store = createRecorderStore(storage);
  const tabs = fakeTabs();
  const sync = opts.sync ?? fakeReleaseCache();
  let n = 0;
  const hub = createHub({
    store,
    tabs,
    sync,
    schema: SCHEMA,
    tour: TOUR,
    targetOrigins: TARGETS,
    info: { extVersion: "0.1.0", schemaVersion: 5 },
    newId: () => `live_${++n}`,
  });
  return { hub, store, tabs, sync };
}

const loc = (pathname, origin = SITE_ORIGINS.pos) => ({ origin, pathname, search: "", hash: "" });
const START_TOUR = (over = {}) => ({ type: "tg:start-tour", releaseSite: "pos", guideId: "g1", ...over });

/* ------------------------------------------------------------------ khởi chạy */

test("3B: tour bắt đầu từ cache và ghim luôn release nó chạy", async () => {
  const { hub, store } = liveHub();
  const reply = await hub.handleContent("tg:start-tour", START_TOUR(), 7);

  assert.equal(reply.ok, true);
  const session = await store.findByTab(7);
  assert.equal(session.kind, "live");
  assert.equal(session.index, 0);
  assert.equal(session.job.releaseRevision, 3);
  assert.equal(session.job.releaseChecksum, "sha256:aaa");
  assert.equal(session.job.guide.id, "g1");
  assert.equal(session.job.guide.steps.length, 2, "snapshot guide đi cùng phiên");
  assert.deepEqual({ ...session.job.sites }, SITE_ORIGINS);
});

test("3B: tabId lấy từ sender, không nhận theo lời khai của trang", async () => {
  // Một trang tự khai tab của mình sẽ mở được tour trên tab của người khác.
  const { hub, store } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR({ tabId: 99 }), 7);

  assert.ok(await store.findByTab(7), "phải gắn vào tab của sender");
  assert.equal(await store.findByTab(99), null, "không được gắn vào tab tự khai");
});

test("3B: bản phát hành mới giữa tour không đụng tới tour đang chạy", async () => {
  const { hub, store, sync } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);

  // Đồng bộ đổi cache sang revision 9 với nội dung khác hẳn.
  sync.cache.pos = releasePayload({
    revision: 9,
    checksum: "sha256:moi",
    guides: [releaseGuide({ name: "BẢN MỚI", steps: [liveStep({ id: "khac" })] })],
  });

  const session = await store.findByTab(7);
  assert.equal(session.job.releaseRevision, 3, "revision vẫn được ghim");
  assert.equal(session.job.guide.name, "BÁN HÀNG TẠI QUẦY");
  assert.equal(session.job.guide.steps.length, 2, "nội dung không bị đổi dưới chân người đang xem");
});

test("3B: hai tab chạy hai guide độc lập", async () => {
  const { hub, store, sync } = liveHub({
    sync: fakeReleaseCache({
      pos: releasePayload({ guides: [releaseGuide(), releaseGuide({ id: "g2", name: "TRẢ HÀNG" })] }),
    }),
  });
  assert.ok(sync);

  await hub.handleContent("tg:start-tour", START_TOUR({ guideId: "g1" }), 7);
  await hub.handleContent("tg:start-tour", START_TOUR({ guideId: "g2" }), 8);

  const a = await store.findByTab(7);
  const b = await store.findByTab(8);
  assert.equal(a.job.guide.id, "g1");
  assert.equal(b.job.guide.id, "g2");
  assert.notEqual(a.id, b.id);

  // Đi tiếp ở tab 7 không đụng tab 8.
  await hub.handleContent("tg:tour-state", { index: 1, tour: { phase: "showing" } }, 7);
  assert.equal((await store.findByTab(7)).index, 1);
  assert.equal((await store.findByTab(8)).index, 0);
});

test("3B: một tab đang ghi/probe/chạy thử thì không mở được tour", async () => {
  const { hub, tabs, store } = liveHub();
  await hub.handlePort(START(), fakePort());
  const recTab = tabs.created.at(-1).id;

  await assert.rejects(
    () => hub.handleContent("tg:start-tour", START_TOUR(), recTab),
    (err) => {
      assert.equal(err.code, SESSION_ERRORS.TAB_BUSY);
      return true;
    },
  );
  assert.equal((await store.findByTab(recTab)).kind, "record", "phiên ghi không bị chiếm mất");
});

test("3B: tour đang chạy thì tab đó không nhận thêm việc khác", async () => {
  const { hub, store } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  await assert.rejects(() => store.start({ id: "rec_x", guideId: "g", site: "pos", tabId: 7 }));
});

/* -------------------------------------------------------------- từ chối đúng chỗ */

test("3B: chưa có cache thì không tạo phiên nào", async () => {
  const { hub, store } = liveHub({ sync: fakeReleaseCache({}) });
  const reply = await hub.handleContent("tg:start-tour", START_TOUR(), 7);

  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, "NO_RELEASE");
  assert.equal(await store.findByTab(7), null);
});

test("3B: release hỏng thì từ chối chạy, và cache KHÔNG bị xoá", async () => {
  const broken = releasePayload({ guides: [releaseGuide({ steps: [{ id: "x" }] })] });
  const sync = fakeReleaseCache({ pos: broken });
  const { hub, store } = liveHub({ sync });

  const reply = await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, "INVALID_RELEASE");
  assert.equal(await store.findByTab(7), null);
  assert.equal(sync.cache.pos, broken, "runtime lỗi không được đụng vào cache");
});

test("3B: guide không có trong bản phát hành thì báo rõ", async () => {
  const { hub } = liveHub();
  const reply = await hub.handleContent("tg:start-tour", START_TOUR({ guideId: "khong-co" }), 7);
  assert.equal(reply.error.code, "GUIDE_NOT_FOUND");
});

test("3B: site lạ bị từ chối trước cả khi đọc cache", async () => {
  const { hub } = liveHub();
  const reply = await hub.handleContent("tg:start-tour", START_TOUR({ releaseSite: "khac" }), 7);
  assert.equal(reply.error.code, "BAD_SITE");
});

test("3B: cache lệch với trạng thái đồng bộ thì không chạy", async () => {
  const sync = fakeReleaseCache();
  sync.status = async () => ({ pos: { site: "pos", state: "ok", revision: 9, checksum: "sha256:khac" } });
  const { hub } = liveHub({ sync });

  const reply = await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  assert.equal(reply.error.code, "INVALID_RELEASE");
});

/* ------------------------------------------------------- điều hướng và khôi phục */

test("3B: tới đúng trang thì tour tự sang bước kế, và pending được xoá", async () => {
  const { hub, store } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  await hub.handleContent(
    "tg:tour-state",
    { tour: { phase: "waiting_url", pending: { fromIndex: 0, nextIndex: 1, expectedSite: "pos", expectedUrl: "/don-hang" } } },
    7,
  );

  const reply = await hub.handleContent("tg:hello", { loc: loc("/don-hang") }, 7);

  assert.equal(reply.data.job.index, 1, "đã tới nơi thì sang bước kế");
  assert.equal(reply.data.job.tour.pending, null);
  assert.equal(reply.data.job.tour.navGuard, null);
  assert.equal((await store.findByTab(7)).index, 1, "và được ghi lại, không chỉ trả về");
});

test("3B: chưa tới nơi thì tour đứng yên chờ", async () => {
  const { hub } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  await hub.handleContent(
    "tg:tour-state",
    { tour: { phase: "waiting_url", pending: { fromIndex: 0, nextIndex: 1, expectedSite: "pos", expectedUrl: "/don-hang" } } },
    7,
  );

  const reply = await hub.handleContent("tg:hello", { loc: loc("/dang-nhap") }, 7);
  assert.equal(reply.data.job.index, 0);
  assert.ok(reply.data.job.tour.pending, "pending còn nguyên để chờ tiếp");
});

test("3B: POS sang Admin trong cùng tab vẫn là một tour", async () => {
  const crossing = releasePayload({
    guides: [
      releaseGuide({
        steps: [
          liveStep({ action: { type: "click_wait_url", expectedUrl: "", timeoutMs: 0, expectedSiteOverride: "admin" } }),
          liveStep({ id: "st_2", site: "admin", urlPattern: "/quan-tri", navigationUrl: "/quan-tri" }),
        ],
      }),
    ],
  });
  const { hub, store } = liveHub({ sync: fakeReleaseCache({ pos: crossing }) });
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  await hub.handleContent(
    "tg:tour-state",
    { tour: { phase: "waiting_url", pending: { fromIndex: 0, nextIndex: 1, expectedSite: "admin", expectedUrl: "/quan-tri" } } },
    7,
  );

  // Cùng tabId, origin khác.
  const reply = await hub.handleContent("tg:hello", { loc: loc("/quan-tri", SITE_ORIGINS.admin) }, 7);

  assert.equal(reply.data.job.index, 1, "đổi origin không làm mất tour");
  assert.equal(reply.data.job.id, (await store.findByTab(7)).id, "vẫn đúng phiên đó");
});

test("3B: reload trang không mất tiến độ", async () => {
  const { hub } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  await hub.handleContent("tg:tour-state", { index: 1, tour: { phase: "showing" } }, 7);

  // Trang tải lại: content script mới bắt tay lại từ đầu.
  const reply = await hub.handleContent("tg:hello", { loc: loc("/don-hang") }, 7);
  assert.equal(reply.data.job.index, 1);
  assert.equal(reply.data.job.job.guide.id, "g1");
});

/* --------------------------------------------------------------- giữ chặt ghim */

test("3B: tour không được sửa release đã ghim", async () => {
  // Một tour mất ghim giữa chừng sẽ bắt đầu đi theo bản phát hành mà người dùng không chọn.
  const { hub, store } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  const session = await store.findByTab(7);

  await assert.rejects(
    () => store.setTour(session.id, { job: { guide: { steps: [] } } }, 7),
    (err) => {
      assert.equal(err.code, SESSION_ERRORS.INVALID_SESSION);
      return true;
    },
  );
  assert.equal((await store.findByTab(7)).job.releaseRevision, 3);
});

test("3B: bước của tour chỉ nhận từ đúng tab của nó", async () => {
  const { hub, store } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  const session = await store.findByTab(7);

  await assert.rejects(
    () => store.setTour(session.id, { index: 1 }, 9),
    (err) => {
      assert.equal(err.code, SESSION_ERRORS.TAB_MISMATCH);
      return true;
    },
  );
  assert.equal((await store.findByTab(7)).index, 0);
});

/* ------------------------------------------------------------------- kết thúc */

test("3B: thoát tour dọn sạch phiên, tab dùng lại được ngay", async () => {
  const { hub, store } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);

  const reply = await hub.handleContent("tg:tour-exit", {}, 7);
  assert.equal(reply.data.stopped, true);
  assert.equal(await store.findByTab(7), null, "không để lại phiên done chiếm tab");

  // Và tab mở được tour mới ngay.
  const again = await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  assert.equal(again.ok, true);
});

test("3B: đóng tab đang chạy tour thì dọn phiên", async () => {
  const { hub, store } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  await hub.onTabRemoved(7);
  assert.equal(await store.findByTab(7), null);
});

test("3B: thoát khi không có tour nào là vô hại", async () => {
  const { hub } = liveHub();
  const reply = await hub.handleContent("tg:tour-exit", {}, 7);
  assert.equal(reply.data.stopped, false);
});

test("3B: HELLO khai thêm capability live khi build có đủ cấu hình", async () => {
  const { hub } = liveHub();
  const reply = await hub.handleOneShot({ type: "HELLO", payload: {} });
  assert.ok([...reply.data.capabilities].includes("live"));
});

test("3B: service worker khởi động lại vẫn tìm thấy tour đang chạy", async () => {
  // Phiên nằm ở chrome.storage.session, không phải trong bộ nhớ worker — đó là lý do một
  // lần worker bị thu hồi không làm mất tiến độ của người đang theo hướng dẫn.
  const storage = fakeStorage();
  const store = createRecorderStore(storage);
  const common = {
    tabs: fakeTabs(),
    sync: fakeReleaseCache(),
    schema: SCHEMA,
    tour: TOUR,
    targetOrigins: TARGETS,
    info: { extVersion: "0.1.0", schemaVersion: 5 },
    newId: () => "live_1",
  };

  const before = createHub({ store, ...common });
  await before.handleContent("tg:start-tour", START_TOUR(), 7);
  await before.handleContent("tg:tour-state", { index: 1, tour: { phase: "showing" } }, 7);

  // Worker bị thu hồi: hub mới, store mới, cùng một storage.
  const after = createHub({ store: createRecorderStore(storage), ...common });
  const reply = await after.handleContent("tg:hello", { loc: loc("/don-hang") }, 7);

  assert.equal(reply.data.job.kind, "live");
  assert.equal(reply.data.job.index, 1, "vẫn đúng bước đang dở");
  assert.equal(reply.data.job.job.releaseRevision, 3, "và vẫn giữ nguyên ghim");
});

/* ================== 3B.1: checksum, claim, và kết thúc khi tới nơi ============= */

test("P0: cùng revision nhưng khác checksum thì không cho chạy", async () => {
  // Đây đúng là hợp đồng vừa sửa ở 3A.1: revision xác định BẢN NÀO, checksum xác định
  // trong bản đó có gì. Chạy guide từ một cache không ai bảo chứng được là bỏ luôn nó.
  const sync = fakeReleaseCache();
  sync.status = async () => ({ pos: { site: "pos", state: "ok", revision: 3, checksum: "sha256:KHAC" } });
  const { hub, store } = liveHub({ sync });

  const reply = await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  assert.equal(reply.error.code, "INVALID_RELEASE");
  assert.match(reply.error.message, /checksum/i);
  assert.equal(await store.findByTab(7), null);
  assert.ok(sync.cache.pos, "cache không bị đụng tới");
});

test("P0: cùng checksum nhưng khác revision cũng không cho chạy", async () => {
  const sync = fakeReleaseCache();
  sync.status = async () => ({ pos: { site: "pos", state: "ok", revision: 9, checksum: "sha256:aaa" } });
  const { hub } = liveHub({ sync });
  const reply = await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  assert.equal(reply.error.code, "INVALID_RELEASE");
});

test("P0: có cache nhưng chưa từng đồng bộ thì yêu cầu đồng bộ trước", async () => {
  const sync = fakeReleaseCache();
  sync.status = async () => ({});
  const { hub, store } = liveHub({ sync });

  const reply = await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  assert.equal(reply.error.code, "INVALID_RELEASE");
  assert.match(reply.error.message, /Đồng bộ/);
  assert.equal(await store.findByTab(7), null);
});

test("P0: mất mạng (state error) vẫn chạy được bản cache nếu khớp cả hai", async () => {
  // Một máy offline cả buổi sáng vẫn phải dùng được bộ hướng dẫn nó đang giữ.
  const sync = fakeReleaseCache();
  sync.status = async () => ({
    pos: { site: "pos", state: "error", message: "Failed to fetch", revision: 3, checksum: "sha256:aaa" },
  });
  const { hub, store } = liveHub({ sync });

  const reply = await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  assert.equal(reply.ok, true);
  assert.equal((await store.findByTab(7)).job.releaseRevision, 3);
});

test("P0: hai claim đồng thời trên cùng một bước, đúng một cái thắng", async () => {
  // Store có hàng đợi nhưng hàng đợi không làm hai lần ghi giống hệt nhau nhận ra nhau.
  // Compare-and-set mới làm được.
  const { hub, store } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  const session = await store.findByTab(7);

  const results = await Promise.all([
    store.claimStep(session.id, { index: 0, stepId: "st_1", tour: { phase: "showing" } }, 7),
    store.claimStep(session.id, { index: 0, stepId: "st_1", tour: { phase: "showing" } }, 7),
  ]);

  assert.equal(results.filter((r) => r.claimed).length, 1, "đúng một caller được phép bấm");
  assert.equal(results.find((r) => !r.claimed).reason, "claimed");
});

test("P0: claim bị từ chối khi tour đã sang bước khác", async () => {
  const { hub, store } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  const session = await store.findByTab(7);
  await store.setTour(session.id, { index: 1, tour: { phase: "showing" } }, 7);

  const result = await store.claimStep(session.id, { index: 0, stepId: "st_1", tour: {} }, 7);
  assert.equal(result.claimed, false);
  assert.equal(result.reason, "moved");
});

test("P0: trả claim chỉ khi nó vẫn là của mình", async () => {
  const { hub, store } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  const session = await store.findByTab(7);
  await store.claimStep(session.id, { index: 0, stepId: "st_1", tour: { phase: "showing" } }, 7);

  // Tour đã đi tiếp: trả claim lúc này sẽ xoá claim của người khác.
  await store.setTour(session.id, { index: 1, tour: { phase: "showing", executedStepId: "st_2" } }, 7);
  await store.releaseStep(session.id, { index: 0, stepId: "st_1" }, 7);

  assert.equal((await store.findByTab(7)).tour.executedStepId, "st_2", "không được đụng vào claim đang có");
});

test("P0: trả claim xong thì bấm lại được", async () => {
  const { hub, store } = liveHub();
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  const session = await store.findByTab(7);

  await store.claimStep(session.id, { index: 0, stepId: "st_1", tour: {} }, 7);
  await store.releaseStep(session.id, { index: 0, stepId: "st_1" }, 7);
  const again = await store.claimStep(session.id, { index: 0, stepId: "st_1", tour: {} }, 7);

  assert.equal(again.claimed, true, "bấm hỏng rồi thì phải thử lại được");
});

test("P1: wait-url ở bước cuối tới nơi thì tour kết thúc, không quay lại bước cuối", async () => {
  // Kẹp index về bước cuối rồi vẽ lại là auto-click bước đó lần thứ hai.
  const single = releasePayload({
    guides: [
      releaseGuide({
        steps: [liveStep({ action: { type: "auto_click_wait_url", expectedUrl: "/xong", timeoutMs: 0 } })],
      }),
    ],
  });
  const { hub, store } = liveHub({ sync: fakeReleaseCache({ pos: single }) });
  await hub.handleContent("tg:start-tour", START_TOUR(), 7);
  await hub.handleContent(
    "tg:tour-state",
    { tour: { phase: "waiting_url", pending: { fromIndex: 0, nextIndex: 1, expectedSite: "pos", expectedUrl: "/xong" } } },
    7,
  );

  const reply = await hub.handleContent("tg:hello", { loc: loc("/xong") }, 7);

  assert.equal(reply.data.job, null, "tour đã xong — trang phải tự dọn");
  assert.equal(await store.findByTab(7), null, "và phiên được dọn khỏi tab");
});
