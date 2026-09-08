import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, "..");

/**
 * The content script, running for real.
 *
 * Grepping content.js for a string proves nothing about behaviour — the Undo defect was
 * precisely a message that was never sent to a listener that did not exist. So this loads
 * the five scripts the way Chrome loads them, into a DOM small enough to read, and
 * asserts what the operator would actually see: the number on the bar, the text on the
 * card, and what happens when they press a button on it.
 */
function loadContent({ job, matches = {}, url = "https://pos.v2.circa.vn/trang-chu", log = [] }) {
  const out = mkdtempSync(join(tmpdir(), "tg-ext-"));
  try {
    execFileSync(process.execPath, [resolve(EXT, "build.mjs"), "--out", out], { stdio: "pipe" });

    const sent = [];
    let onMessage = null;
    const timers = [];
    const observers = [];
    let parsed = new URL(url);
    // Mutated by tg:tour-state exactly as the worker would, so the page reads back what it
    // just wrote instead of a fixture the test controls independently.
    let current = job;

    const document = fakeDocument(matches);
    const navigations = [];
    const ctx = {
      console,
      URL,
      TextEncoder,
      crypto: globalThis.crypto,
      Element: FakeElement,
      innerHeight: 800,
      MutationObserver: class {
        constructor(callback) {
          this.callback = callback;
          this.live = true;
          observers.push(this);
        }
        observe() {}
        disconnect() {
          this.live = false;
        }
      },
      document,
      location: {
        href: url,
        origin: parsed.origin,
        pathname: parsed.pathname,
        search: parsed.search,
        hash: parsed.hash,
      },
      setTimeout,
      clearTimeout,
      addEventListener() {},
      removeEventListener() {},
      // The URL watcher is not under test and a live interval would keep the runner
      // alive; record the registration instead of scheduling it.
      setInterval: (fn) => timers.push(fn),
      clearInterval: () => {},
      chrome: {
        runtime: {
          async sendMessage(message) {
            sent.push(message);
            log.push({ kind: "send", type: message.type, message });
            if (message.type === "tg:hello") {
              return { v: 1, ok: true, type: "tg:hello", data: { tabId: 7, job: current } };
            }
            if (message.type === "tg:tour-state") {
              current = {
                ...current,
                index: message.index === undefined ? current.index : message.index,
                tour: message.tour === undefined ? current.tour : message.tour,
              };
              return { v: 1, ok: true, type: message.type, data: { job: current } };
            }
            return { v: 1, ok: true, type: message.type, data: {} };
          },
          onMessage: { addListener: (fn) => (onMessage = fn) },
        },
      },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);

    // `location.href = ...` is how a tour navigates; record it instead of pretending a
    // page load happened.
    let href = url;
    Object.defineProperty(ctx.location, "href", {
      get: () => href,
      set: (v) => navigations.push(v),
      configurable: true,
    });

    /** A client-side route change: the URL moves with no page load, as on POS and Admin. */
    function spaNavigate(next) {
      href = next;
      parsed = new URL(next);
      Object.assign(ctx.location, {
        origin: parsed.origin,
        pathname: parsed.pathname,
        search: parsed.search,
        hash: parsed.hash,
      });
      for (const fn of timers) fn();
    }

    // Taken from the built manifest, not from a list here: Chrome loads exactly these, in
    // exactly this order, and a hardcoded copy would silently stop matching the moment a
    // script is added.
    const manifest = JSON.parse(readFileSync(resolve(out, "manifest.json"), "utf8"));
    for (const file of manifest.content_scripts[0].js) {
      vm.runInContext(readFileSync(resolve(out, file), "utf8"), ctx);
    }
    return {
      ctx,
      document,
      sent,
      navigations,
      log,
      observers,
      spaNavigate,
      setJob: (next) => (current = next),
      deliver: (message) => onMessage(message),
      timers,
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Just enough DOM for the overlay: a tree, attributes, a shadow root, and clicks. */
class FakeElement {}

function fakeEl(tag) {
  const attrs = {};
  const stubs = new Map();
  const listeners = {};
  let html = "";

  const el = Object.assign(Object.create(FakeElement.prototype), {
    tagName: String(tag).toUpperCase(),
    style: {},
    className: "",
    id: "",
    textContent: "",
    innerText: "",
    children: [],
    parentNode: null,
    shadow: null,
    setAttribute: (k, v) => (attrs[k] = String(v)),
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    addEventListener: (type, fn) => ((listeners[type] ??= []).push(fn)),
    /** Fire the handlers the overlay registered, the way a real click would. */
    click: () => {
      for (const fn of listeners.click ?? []) fn({ preventDefault() {}, stopPropagation() {} });
    },
    append(...kids) {
      for (const kid of kids) {
        kid.parentNode = el;
        el.children.push(kid);
      }
    },
    appendChild(kid) {
      el.append(kid);
      return kid;
    },
    removeChild(kid) {
      el.children = el.children.filter((c) => c !== kid);
      kid.parentNode = null;
      return kid;
    },
    contains: (node) => node === el || el.children.some((c) => c.contains(node)),
    attachShadow() {
      el.shadow = fakeEl("shadow");
      return el.shadow;
    },
    // Set once with a template, then queried by class; a stable stub per selector is all
    // the overlay needs. Assigning "" also clears children, which is how the card resets
    // its buttons between renders.
    querySelector(selector) {
      if (!stubs.has(selector)) stubs.set(selector, fakeEl("span"));
      return stubs.get(selector);
    },
    getBoundingClientRect: () => ({ top: 100, left: 10, width: 120, height: 32 }),
    scrollIntoView() {},
  });

  Object.defineProperty(el, "innerHTML", {
    get: () => html,
    set: (v) => {
      html = String(v);
      el.children = [];
    },
  });
  return el;
}

function fakeDocument(matches) {
  const body = fakeEl("body");
  const find = (selector) => matches[selector] ?? [];
  return {
    body,
    documentElement: fakeEl("html"),
    createElement: (tag) => fakeEl(tag),
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: find,
    querySelector: (selector) => find(selector)[0] ?? null,
  };
}

/** A page element the resolver can find, with text on it. */
function pageEl(text, tag = "button", { log = null, id = "el", throws = false, hidden = false, disabled = false } = {}) {
  const el = fakeEl(tag);
  el.innerText = text;
  el.textContent = text;
  el.clicks = 0;
  if (disabled) el.disabled = true;
  if (hidden) el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0 });
  el.click = () => {
    el.clicks += 1;
    if (log) log.push({ kind: "click", id });
    if (throws) throw new Error("phần tử từ chối click");
  };
  return el;
}

/* ---------------------------------------------------------------- reading the UI */

function overlay(document) {
  return document.body.children.find((c) => c.id === "circa-tooltip-overlay") ?? null;
}

function partOf(document, blockClass, part) {
  const host = overlay(document);
  if (!host) return null;
  const block = host.shadow.children.find((c) => String(c.className).startsWith(blockClass));
  return block.querySelector(part).textContent;
}

const barText = (document, part) => partOf(document, "bar", part);
const cardText = (document, part) => partOf(document, "card", part);

function cardButtons(document) {
  const host = overlay(document);
  const card = host.shadow.children.find((c) => String(c.className).startsWith("card"));
  return card.querySelector(".actions").children;
}

function pressCard(document, label) {
  const button = cardButtons(document).find((b) => b.textContent === label);
  assert.ok(button, `không có nút "${label}"`);
  button.click();
}

const boxEl = (document) => {
  const host = overlay(document);
  return host.shadow.children.find((c) => String(c.className).startsWith("box"));
};

const boxVisible = (document) => boxEl(document).style.display === "block";
/** "box ok" is the green, this-step-works highlight; plain "box" is the red one. */
const boxIsGreen = (document) => String(boxEl(document).className).split(" ").includes("ok");

/* ------------------------------------------------------------------- fixtures */

const session = (over = {}) => ({
  v: 1,
  id: "rec_1",
  guideId: "g1",
  site: "pos",
  startUrl: "/trang-chu",
  tabId: 7,
  mode: "append",
  kind: "record",
  job: null,
  status: "recording",
  steps: [],
  index: 0,
  startedAt: "2026-09-07T00:00:00.000Z",
  ...over,
});

const steps = (n) => Array.from({ length: n }, (_, i) => ({ selectors: ["#s" + i], matchText: "s" + i, tag: "button" }));

/**
 * navigationUrl follows urlPattern unless the test sets it explicitly, because that is
 * what the recorder writes — and `resolveStepUrl` prefers navigationUrl, so a fixture
 * that let the two drift would be testing a shape nothing produces.
 */
const guideStep = (over = {}) => {
  const step = {
    id: "st_1",
    selectors: ["#basic-button"],
    matchText: "Cài Đặt",
    tag: "button",
    title: "Mở Cài Đặt",
    content: "Bấm vào nút Cài Đặt trên header.",
    urlPattern: "/trang-chu",
    action: { type: "click_next", expectedUrl: "", timeoutMs: 0 },
    ...over,
  };
  return { ...step, navigationUrl: over.navigationUrl ?? step.urlPattern };
};

const SITES = { pos: "https://pos.v2.circa.vn", admin: "https://admin.v2.circa.vn" };

const previewJob = (guideSteps, over = {}) =>
  session({
    id: "pvw_1",
    kind: "preview",
    job: { kind: "preview", guide: { name: "BÁN HÀNG", site: "pos", steps: guideSteps }, sites: SITES },
    ...over,
  });

const probeJob = (step) =>
  session({ id: "prb_1", kind: "probe", job: { kind: "probe", probeId: "st_1", step } });

/** The handshake is a promise chain; let it settle. */
const tick = () => new Promise((r) => setTimeout(r, 10));

/* ------------------------------------------------------------------- recording */

test("a page inside a recording arms itself and shows the step count", async () => {
  const { document, sent } = loadContent({ job: session({ steps: steps(3) }) });
  await tick();

  assert.equal(sent[0].type, "tg:hello");
  assert.equal(barText(document, ".count"), "3 bước");
  assert.ok(
    sent.some((m) => m.type === "tg:navigated" && m.sessionId === "rec_1"),
    "phải báo vị trí hiện tại khi bắt đầu ghi",
  );
});

test("a page with no job stays inert", async () => {
  const { document } = loadContent({ job: null });
  await tick();
  assert.equal(document.body.children.length, 0, "không được chèn UI vào trang không có việc gì");
});

test("P1 REGRESSION: a pushed session updates the counter on the page", async () => {
  // Undo happens between the Portal and the worker; this tab does nothing. Before the fix
  // nothing told it, so the bar kept showing the step that had just been removed.
  const { document, deliver } = loadContent({ job: session({ steps: steps(3) }) });
  await tick();
  assert.equal(barText(document, ".count"), "3 bước");

  deliver({ type: "tg:session", session: session({ steps: steps(2) }) });
  assert.equal(barText(document, ".count"), "2 bước", "counter phải giảm ngay, không đợi click kế tiếp");
});

test("a session belonging to another job is ignored", async () => {
  const { document, deliver } = loadContent({ job: session({ steps: steps(3) }) });
  await tick();

  deliver({ type: "tg:session", session: session({ id: "rec_KHAC", steps: steps(99) }) });
  assert.equal(barText(document, ".count"), "3 bước", "phiên khác không được vẽ đè lên tab này");
});

test("a malformed push does not blank the bar", async () => {
  const { document, deliver } = loadContent({ job: session({ steps: steps(3) }) });
  await tick();

  deliver({ type: "tg:session" });
  deliver({ type: "tg:session", session: null });
  assert.equal(barText(document, ".count"), "3 bước");
});

test("disarm removes the overlay so the page stops being a recorder", async () => {
  const { document, deliver } = loadContent({ job: session({ steps: steps(2) }) });
  await tick();
  assert.equal(document.body.children.length, 1);

  deliver({ type: "tg:disarm" });
  assert.equal(document.body.children.length, 0, "thanh ghi phải biến mất khỏi trang");
});

test("a second disarm is harmless", async () => {
  const { document, deliver } = loadContent({ job: session({ steps: steps(1) }) });
  await tick();
  deliver({ type: "tg:disarm" });
  deliver({ type: "tg:disarm" });
  assert.equal(document.body.children.length, 0);
});

/* ----------------------------------------------------------------------- probe */

test("a probe answers the Portal with what it found on the page", async () => {
  const wanted = pageEl("Cài Đặt");
  const { document, sent } = loadContent({
    job: probeJob(guideStep()),
    matches: { "#basic-button": [pageEl("Báo Cáo"), wanted] },
  });
  await tick();

  const reply = sent.find((m) => m.type === "tg:probe-result");
  assert.ok(reply, "phải gửi kết quả về background");
  assert.equal(reply.probeId, "st_1");
  assert.equal(reply.result.ok, true);
  assert.equal(reply.result.candidates[0].count, 2, "báo đúng số element selector khớp");
  assert.equal(reply.result.resolved.via, "text");
  assert.ok(boxVisible(document), "phải tô sáng element tìm được");
});

test("a probe that finds nothing says so instead of highlighting something else", async () => {
  const { document, sent } = loadContent({ job: probeJob(guideStep()), matches: {} });
  await tick();

  const reply = sent.find((m) => m.type === "tg:probe-result");
  assert.equal(reply.result.ok, false);
  assert.match(reply.result.reason, /không selector nào tìm thấy/i);
  assert.equal(boxVisible(document), false);
  assert.match(cardText(document, ".note"), /không selector nào tìm thấy/i);
});

test("a probe lists every candidate and its count on the page itself", async () => {
  const { document } = loadContent({
    job: probeJob(guideStep({ selectors: ["#a", "#b"] })),
    matches: { "#b": [pageEl("Cài Đặt")] },
  });
  await tick();
  const body = cardText(document, ".body");
  assert.ok(body.includes("0 element  ·  #a"), body);
  assert.ok(body.includes("1 element  ·  #b"), body);
});

test("a probe never intercepts clicks — it is a read-only look at the page", async () => {
  const { document } = loadContent({ job: probeJob(guideStep()), matches: { "#basic-button": [pageEl("Cài Đặt")] } });
  await tick();
  // The recorder installs a capture-phase click listener; a probe must not.
  assert.equal(document.body.children.length, 1, "chỉ có overlay");
});

/* --------------------------------------------------------------------- preview */

test("preview shows the step it is on, highlights the target, and never clicks it", async () => {
  const target = pageEl("Cài Đặt");
  const { document } = loadContent({
    job: previewJob([guideStep(), guideStep({ id: "st_2", urlPattern: "/don-hang" })]),
    matches: { "#basic-button": [target] },
  });
  await tick();

  assert.equal(cardText(document, ".title"), "Mở Cài Đặt");
  assert.match(cardText(document, ".meta"), /^Bước 1\/2 · BÁN HÀNG/);
  assert.equal(cardText(document, ".body"), "Bấm vào nút Cài Đặt trên header.");
  assert.ok(boxVisible(document));
});

test("RISK R1: preview refuses to perform an auto-click, and says so", async () => {
  // Firing a real business action at an element that may have resolved wrong is the whole
  // of R1, and a rehearsal is exactly where nobody expects an order to be placed.
  const target = pageEl("Cài Đặt");
  let clicked = 0;
  target.addEventListener("click", () => clicked++);

  const { document } = loadContent({
    job: previewJob([guideStep({ action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 0 } })]),
    matches: { "#basic-button": [target] },
  });
  await tick();

  assert.equal(clicked, 0, "chạy thử không được bấm hộ");
  assert.match(cardText(document, ".note"), /TỰ bấm/);
});

test("preview moves forward, and the position is persisted before anything else", async () => {
  const { document, sent } = loadContent({
    job: previewJob([guideStep(), guideStep({ id: "st_2" })]),
    matches: { "#basic-button": [pageEl("Cài Đặt")] },
  });
  await tick();

  pressCard(document, "Tiếp");
  await tick();

  const moved = sent.find((m) => m.type === "tg:preview-step");
  assert.ok(moved, "phải lưu vị trí qua background");
  assert.equal(moved.index, 1);
  assert.match(cardText(document, ".meta"), /^Bước 2\/2/);
});

test("Trước is disabled on the first step", async () => {
  const { document } = loadContent({
    job: previewJob([guideStep(), guideStep({ id: "st_2" })]),
    matches: { "#basic-button": [pageEl("Cài Đặt")] },
  });
  await tick();
  const back = cardButtons(document).find((b) => b.textContent === "Trước");
  assert.equal(back.getAttribute("disabled"), "disabled");
});

test("a step on another page is not highlighted here — preview offers to go there", async () => {
  const { document } = loadContent({
    job: previewJob([guideStep({ urlPattern: "/don-hang" })]),
    matches: { "#basic-button": [pageEl("Cài Đặt")] },
  });
  await tick();

  assert.equal(boxVisible(document), false, "không được tô sáng element trên trang sai");
  assert.match(cardText(document, ".note"), /Bước này ở trang https:\/\/pos\.v2\.circa\.vn\/don-hang/);
});

test("going to a step's page navigates to that step's own site", async () => {
  const { document, navigations } = loadContent({
    job: previewJob([guideStep({ urlPattern: "/quan-tri", siteOverride: "admin" })]),
  });
  await tick();

  pressCard(document, "Đi tới trang của bước");
  assert.deepEqual(navigations, ["https://admin.v2.circa.vn/quan-tri"], "bước Admin phải mở trên origin Admin");
});

test("moving to a step on another page persists first, then navigates", async () => {
  // Same reason a recorded step is stored before the click is replayed: the page is about
  // to be thrown away.
  const { document, sent, navigations } = loadContent({
    job: previewJob([guideStep(), guideStep({ id: "st_2", urlPattern: "/don-hang" })]),
    matches: { "#basic-button": [pageEl("Cài Đặt")] },
  });
  await tick();

  pressCard(document, "Tiếp");
  await tick();

  const savedAt = sent.findIndex((m) => m.type === "tg:preview-step");
  assert.ok(savedAt >= 0, "phải lưu vị trí");
  assert.deepEqual(navigations, ["https://pos.v2.circa.vn/don-hang"]);
});

test("the last step ends the preview instead of walking off the end", async () => {
  const { document, sent } = loadContent({
    job: previewJob([guideStep()]),
    matches: { "#basic-button": [pageEl("Cài Đặt")] },
  });
  await tick();

  pressCard(document, "Kết thúc");
  await tick();

  assert.ok(sent.some((m) => m.type === "tg:preview-step" && m.exit === true), "phải báo kết thúc");
  assert.equal(document.body.children.length, 0, "overlay phải biến mất");
});

test("Thoát ends the preview and leaves the page alone", async () => {
  const { document, sent } = loadContent({
    job: previewJob([guideStep(), guideStep({ id: "st_2" })]),
    matches: { "#basic-button": [pageEl("Cài Đặt")] },
  });
  await tick();

  pressCard(document, "Thoát");
  await tick();

  assert.ok(sent.some((m) => m.type === "tg:preview-step" && m.exit === true));
  assert.equal(document.body.children.length, 0);
});

test("a step whose element is gone is reported, not silently skipped", async () => {
  const { document } = loadContent({ job: previewJob([guideStep()]), matches: {} });
  await tick();
  assert.equal(boxVisible(document), false);
  assert.match(cardText(document, ".note"), /Không tìm thấy phần tử/);
});

test("preview resumes at the stored step after a navigation", async () => {
  // The tab reloaded; the only thing that knows where the preview was is storage.
  const { document } = loadContent({
    job: previewJob([guideStep(), guideStep({ id: "st_2", title: "Bước hai" })], { index: 1 }),
    matches: { "#basic-button": [pageEl("Cài Đặt")] },
  });
  await tick();
  assert.equal(cardText(document, ".title"), "Bước hai");
  assert.match(cardText(document, ".meta"), /^Bước 2\/2/);
});

/* ------------------------------- P0: text lệch thì probe và chạy thử phải cùng trượt */

test("P0 REGRESSION: probe and preview agree that a text-mismatched step fails", async () => {
  // Selector khớp đúng 1 element, nhưng chữ trên trang đã khác. Trước đây probe báo đỏ
  // còn chạy thử tô xanh chính element đó — hai công cụ nói ngược nhau về cùng một bước.
  const moved = pageEl("Thiết Lập");
  const matches = { "#basic-button": [moved] };

  const probe = loadContent({ job: probeJob(guideStep()), matches });
  await tick();
  const answer = probe.sent.find((m) => m.type === "tg:probe-result");
  assert.equal(answer.result.ok, false, "probe phải trượt");
  assert.equal(boxIsGreen(probe.document), false);

  const preview = loadContent({ job: previewJob([guideStep()]), matches });
  await tick();
  assert.ok(boxVisible(preview.document), "vẫn tô sáng để chẩn đoán");
  assert.equal(boxIsGreen(preview.document), false, "nhưng KHÔNG được tô xanh");
  assert.match(cardText(preview.document, ".note"), /TEXT trên trang đã khác/);
});

test("a step that really does resolve is still shown as green", async () => {
  const { document } = loadContent({
    job: previewJob([guideStep()]),
    matches: { "#basic-button": [pageEl("Cài Đặt")] },
  });
  await tick();
  assert.equal(boxIsGreen(document), true);
});

test("a text-mismatched step does not jam the preview", async () => {
  const { document, sent } = loadContent({
    job: previewJob([guideStep(), guideStep({ id: "st_2" })]),
    matches: { "#basic-button": [pageEl("Thiết Lập")] },
  });
  await tick();

  pressCard(document, "Tiếp");
  await tick();
  assert.ok(sent.some((m) => m.type === "tg:preview-step" && m.index === 1), "bước hỏng không được chặn cả bộ");
});

/* ============================ 3B: chạy guide thật ============================== */

const liveStep = (over = {}) => {
  const step = {
    id: "st_1",
    site: "pos",
    selectors: ["#basic-button"],
    matchText: "Cài Đặt",
    tag: "button",
    title: "Mở Cài Đặt",
    content: "Bấm nút Cài Đặt.",
    urlPattern: "/trang-chu",
    action: { type: "highlight", expectedUrl: "", timeoutMs: 20 },
    ...over,
  };
  return { ...step, navigationUrl: over.navigationUrl ?? step.urlPattern };
};

const liveJob = (steps, over = {}) =>
  session({
    id: "live_1",
    kind: "live",
    job: {
      kind: "live",
      guide: { id: "g1", name: "BÁN HÀNG", site: "pos", steps },
      sites: SITES,
      releaseSite: "pos",
      releaseRevision: 3,
      releaseChecksum: "sha256:aaa",
    },
    index: 0,
    tour: { phase: "showing", pending: null, navGuard: null, executedStepId: null },
    ...over,
  });

const sentOfType = (sent, type) => sent.filter((m) => m.type === type);

/* --------------------------------------------------------------- năm action */

test("3B: highlight chỉ tô sáng, không bấm gì, Tiếp thì sang bước kế", async () => {
  const log = [];
  const el = pageEl("Cài Đặt", "button", { log });
  const { document, sent } = loadContent({
    job: liveJob([liveStep(), liveStep({ id: "st_2" })]),
    matches: { "#basic-button": [el] },
    log,
  });
  await tick();

  assert.equal(cardText(document, ".title"), "Mở Cài Đặt");
  assert.match(cardText(document, ".meta"), /^Bước 1\/2 · BÁN HÀNG/);
  assert.ok(boxIsGreen(document));
  assert.equal(el.clicks, 0, "highlight không được bấm hộ");

  pressCard(document, "Tiếp");
  await tick();
  assert.equal(el.clicks, 0);
  assert.equal(sentOfType(sent, "tg:tour-state").at(-1).index, 1);
});

test("3B: click_next bấm đúng một lần rồi sang bước kế", async () => {
  const log = [];
  const el = pageEl("Cài Đặt", "button", { log });
  const { document, sent } = loadContent({
    job: liveJob([
      liveStep({ action: { type: "click_next", expectedUrl: "", timeoutMs: 20 } }),
      liveStep({ id: "st_2" }),
    ]),
    matches: { "#basic-button": [el] },
    log,
  });
  await tick();

  pressCard(document, "Tiếp");
  await tick();

  assert.equal(el.clicks, 1);
  assert.equal(sentOfType(sent, "tg:tour-state").at(-1).index, 1);
});

test("3B: click_wait_url ghi pending TRƯỚC khi bấm, và không tự sang bước", async () => {
  // Cú bấm có thể vứt cả trang đi. Pending ghi sau cú bấm là pending chưa từng tồn tại.
  const log = [];
  const el = pageEl("Cài Đặt", "button", { log });
  const { document, sent } = loadContent({
    job: liveJob([
      liveStep({ action: { type: "click_wait_url", expectedUrl: "", timeoutMs: 20 } }),
      liveStep({ id: "st_2", urlPattern: "/don-hang" }),
    ]),
    matches: { "#basic-button": [el] },
    log,
  });
  await tick();

  pressCard(document, "Tiếp");
  await tick();

  const savedAt = log.findIndex((e) => e.kind === "send" && e.type === "tg:tour-state" && e.message.tour?.pending);
  const clickedAt = log.findIndex((e) => e.kind === "click");
  assert.ok(savedAt >= 0, "phải ghi pending");
  assert.ok(clickedAt >= 0, "phải bấm");
  assert.ok(savedAt < clickedAt, "pending phải được ghi TRƯỚC cú bấm");

  const pending = log[savedAt].message.tour.pending;
  assert.equal(pending.nextIndex, 1);
  assert.equal(pending.expectedUrl, "/don-hang");
  assert.equal(sentOfType(sent, "tg:tour-state").at(-1).index, undefined, "chưa được sang bước — còn chờ URL");
});

test("3B: auto_click_next tự bấm đúng một lần rồi sang bước kế", async () => {
  const log = [];
  const el = pageEl("Cài Đặt", "button", { log });
  const { document, sent } = loadContent({
    job: liveJob([
      liveStep({ action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 20 } }),
      liveStep({ id: "st_2" }),
    ]),
    matches: { "#basic-button": [el] },
    log,
  });
  await tick();

  assert.equal(el.clicks, 1, "tự bấm mà không cần ai bấm Tiếp");
  assert.equal(sentOfType(sent, "tg:tour-state").at(-1).index, 1);
  // Đã bấm xong thì thẻ chuyển luôn sang bước 2 — đó mới là hành vi đúng.
  assert.match(cardText(document, ".meta"), /^Bước 2\/2/);
});

test("3B: auto_click_wait_url ghi pending trước, tự bấm, rồi đứng chờ", async () => {
  const log = [];
  const el = pageEl("Cài Đặt", "button", { log });
  const { document } = loadContent({
    job: liveJob([
      liveStep({ action: { type: "auto_click_wait_url", expectedUrl: "", timeoutMs: 20 } }),
      liveStep({ id: "st_2", urlPattern: "/don-hang" }),
    ]),
    matches: { "#basic-button": [el] },
    log,
  });
  await tick();

  const savedAt = log.findIndex((e) => e.kind === "send" && e.message?.tour?.pending);
  const clickedAt = log.findIndex((e) => e.kind === "click");
  assert.ok(savedAt >= 0 && savedAt < clickedAt, "pending trước, click sau");
  assert.equal(el.clicks, 1);
  // Vẫn đứng ở bước 1 chờ URL, và nói rõ đây là bước extension tự làm.
  assert.match(cardText(document, ".meta"), /^Bước 1\/2/);
  assert.match(cardText(document, ".note"), /tự thao tác/);
});

test("3B: bước cuối là auto-click thì vẫn bấm rồi mới kết thúc", async () => {
  const log = [];
  const el = pageEl("Cài Đặt", "button", { log });
  const { document, sent } = loadContent({
    job: liveJob([liveStep({ action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 20 } })]),
    matches: { "#basic-button": [el] },
    log,
  });
  await tick();

  assert.equal(el.clicks, 1, "bước cuối vẫn phải được thực hiện");
  assert.ok(sentOfType(sent, "tg:tour-exit").length > 0, "rồi mới kết thúc tour");
  assert.equal(document.body.children.length, 0, "overlay được dọn");
});

/* ---------------------------------------------------- không bấm hai lần */

test("3B: vẽ lại không làm bước auto bấm lần thứ hai", async () => {
  const log = [];
  const el = pageEl("Cài Đặt", "button", { log });
  const { deliver } = loadContent({
    job: liveJob([
      liveStep({ action: { type: "auto_click_wait_url", expectedUrl: "", timeoutMs: 20 } }),
      liveStep({ id: "st_2", urlPattern: "/don-hang" }),
    ]),
    matches: { "#basic-button": [el] },
    log,
  });
  await tick();
  assert.equal(el.clicks, 1);

  // Worker đẩy lại chính phiên đó (điều xảy ra sau mỗi lần ghi state).
  deliver({ type: "tg:session", session: liveJob([], {}) });
  await tick();
  assert.equal(el.clicks, 1, "executedStepId phải chặn cú bấm thứ hai");
});

/* ------------------------------------------------------- từ chối bấm khi không chắc */

test("3B: R1 text đã khác thì không tự bấm, và nói rõ", async () => {
  const log = [];
  const wrong = pageEl("Thiết Lập", "button", { log });
  const { document } = loadContent({
    job: liveJob([liveStep({ action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 20 } })]),
    matches: { "#basic-button": [wrong] },
    log,
  });
  await tick();

  assert.equal(wrong.clicks, 0, "tuyệt đối không bấm");
  assert.match(cardText(document, ".note"), /Đang tìm thành phần/);
});

test("3B: selector khớp nhiều phần tử mà text không lọc được thì không tự bấm", async () => {
  const log = [];
  const a = pageEl("Một", "button", { log, id: "a" });
  const b = pageEl("Hai", "button", { log, id: "b" });
  const { document } = loadContent({
    job: liveJob([
      liveStep({ matchText: "", intent: "first_item", action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 20 } }),
    ]),
    matches: { "#basic-button": [a, b] },
    log,
  });
  await tick();

  assert.equal(a.clicks + b.clicks, 0, "first_item không phải giấy phép để bấm");
  assert.match(cardText(document, ".note"), /Đang tìm thành phần/);
});

test("3B: phần tử ẩn hoặc bị vô hiệu hoá thì không tự bấm", async () => {
  for (const opts of [{ hidden: true }, { disabled: true }]) {
    const log = [];
    const el = pageEl("Cài Đặt", "button", { log, ...opts });
    const { document } = loadContent({
      job: liveJob([liveStep({ action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 20 } })]),
      matches: { "#basic-button": [el] },
      log,
    });
    await tick();
    assert.equal(el.clicks, 0, JSON.stringify(opts));
    assert.match(cardText(document, ".note"), /Đang tìm thành phần/);
  }
});

test("3B: không tìm thấy phần tử thì dừng lại và mời thử lại, không bỏ qua bước", async () => {
  const { document, sent } = loadContent({ job: liveJob([liveStep(), liveStep({ id: "st_2" })]), matches: {} });
  await tick();

  assert.match(cardText(document, ".note"), /Đang tìm thành phần/);
  assert.equal(sentOfType(sent, "tg:tour-state").length, 0, "không được lặng lẽ đi tiếp");
  assert.ok(cardButtons(document).some((b) => b.textContent === "Thử lại"));
});

test("3B: bấm lỗi thì KHÔNG tăng bước", async () => {
  const log = [];
  const el = pageEl("Cài Đặt", "button", { log, throws: true });
  const { document, sent } = loadContent({
    job: liveJob([
      liveStep({ action: { type: "click_next", expectedUrl: "", timeoutMs: 20 } }),
      liveStep({ id: "st_2" }),
    ]),
    matches: { "#basic-button": [el] },
    log,
  });
  await tick();

  pressCard(document, "Tiếp");
  await tick();

  assert.equal(el.clicks, 1, "đã thử bấm");
  const advanced = sentOfType(sent, "tg:tour-state").filter((m) => m.index !== undefined);
  assert.equal(advanced.length, 0, "bấm hỏng thì không được sang bước sau");
  assert.match(cardText(document, ".body"), /Không bấm được/);
});

/* ------------------------------------------------------------------ điều hướng */

test("3B: bước ở trang khác thì điều hướng tới đúng origin của nó", async () => {
  const { navigations, log } = loadContent({
    job: liveJob([liveStep({ site: "admin", urlPattern: "/quan-tri" })]),
    matches: {},
  });
  assert.ok(log);
  await tick();
  assert.deepEqual(navigations, ["https://admin.v2.circa.vn/quan-tri"]);
});

test("3B: navGuard chặn nhảy vòng POS ↔ Admin", async () => {
  // Đã chuyển sang Admin mà rơi vào màn đăng nhập: chuyển lần nữa là nhảy vô tận.
  const { document, navigations } = loadContent({
    job: liveJob([liveStep({ site: "admin", urlPattern: "/quan-tri" })], {
      tour: { phase: "waiting_url", pending: null, navGuard: { url: "https://admin.v2.circa.vn/quan-tri" }, executedStepId: null },
    }),
    url: "https://admin.v2.circa.vn/dang-nhap",
    matches: {},
  });
  await tick();

  assert.deepEqual(navigations, [], "không được điều hướng lần thứ hai");
  assert.equal(cardText(document, ".title"), "Đang chờ trang");
  assert.ok(cardButtons(document).some((b) => b.textContent === "Chờ thêm"));
});

test("3B: ghi navGuard trước khi rời trang", async () => {
  const log = [];
  const { navigations } = loadContent({
    job: liveJob([liveStep({ site: "admin", urlPattern: "/quan-tri" })]),
    matches: {},
    log,
  });
  await tick();

  const guardAt = log.findIndex((e) => e.kind === "send" && e.message?.tour?.navGuard);
  assert.ok(guardAt >= 0, "phải ghi navGuard");
  assert.equal(navigations.length, 1);
});

/* --------------------------------------------------------------------- thoát */

test("3B: Thoát dọn sạch overlay và báo cho worker", async () => {
  const log = [];
  const el = pageEl("Cài Đặt", "button", { log });
  const { document, sent } = loadContent({
    job: liveJob([liveStep(), liveStep({ id: "st_2" })]),
    matches: { "#basic-button": [el] },
    log,
  });
  await tick();

  pressCard(document, "Thoát");
  await tick();

  assert.equal(document.body.children.length, 0, "overlay phải biến mất");
  assert.ok(sentOfType(sent, "tg:tour-exit").length > 0);
});

test("3B: Quay lại bị khoá ở bước đầu", async () => {
  const log = [];
  const el = pageEl("Cài Đặt", "button", { log });
  const { document } = loadContent({
    job: liveJob([liveStep(), liveStep({ id: "st_2" })]),
    matches: { "#basic-button": [el] },
    log,
  });
  await tick();
  const back = cardButtons(document).find((b) => b.textContent === "Quay lại");
  assert.equal(back.getAttribute("disabled"), "disabled");
});

test("3B: tour tiếp tục đúng bước sau khi trang tải lại", async () => {
  const log = [];
  const el = pageEl("Cài Đặt", "button", { log });
  const { document } = loadContent({
    job: liveJob([liveStep(), liveStep({ id: "st_2", title: "Bước hai" })], { index: 1 }),
    matches: { "#basic-button": [el] },
    log,
  });
  await tick();
  assert.equal(cardText(document, ".title"), "Bước hai");
  assert.match(cardText(document, ".meta"), /^Bước 2\/2/);
});

/* ------------------------------------------- SPA navigation và MutationObserver */

test("3B: điều hướng SPA hỏi lại worker và chạy tiếp đúng bước", async () => {
  // POS và Admin là SPA: đổi route không tải lại script, nên không có sự kiện load nào để
  // bám. Watcher phát hiện URL đổi rồi hỏi worker — nơi giữ pending và matcher chung.
  const log = [];
  const el = pageEl("Cài Đặt", "button", { log });
  const run = loadContent({
    job: liveJob([liveStep(), liveStep({ id: "st_2", urlPattern: "/don-hang", title: "Bước hai" })]),
    matches: { "#basic-button": [el] },
    log,
  });
  await tick();

  // Worker đã chuyển tour sang bước 2 vì pending đã tới nơi.
  run.setJob(liveJob([liveStep(), liveStep({ id: "st_2", urlPattern: "/don-hang", title: "Bước hai" })], { index: 1 }));
  run.spaNavigate("https://pos.v2.circa.vn/don-hang");
  await tick();

  const hellos = run.sent.filter((m) => m.type === "tg:hello");
  assert.ok(hellos.length >= 2, "đổi route phải hỏi lại worker");
  assert.deepEqual(hellos.at(-1).loc.pathname, "/don-hang", "và gửi kèm vị trí hiện tại");
  assert.equal(cardText(run.document, ".title"), "Bước hai");
});

test("3B: MutationObserver chỉ đánh thức tour khi phần tử THẬT SỰ dùng được", async () => {
  // "Selector đã xuất hiện" là chưa đủ: nó có thể khớp một phần tử đang ẩn, hoặc một phần
  // tử mà text đã đổi dưới chân guide. Observer phải chạy lại đúng cổng đó.
  const log = [];
  const wrong = pageEl("Thiết Lập", "button", { log });
  const matches = { "#basic-button": [wrong] };
  const run = loadContent({
    job: liveJob([liveStep({ action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 60000 } })]),
    matches,
    log,
  });
  await tick();

  assert.match(cardText(run.document, ".note"), /Đang tìm thành phần/);
  assert.equal(run.observers.length, 1, "phải theo dõi DOM");

  // DOM đổi nhưng vẫn là phần tử sai text: không được đánh thức, không được bấm.
  run.observers[0].callback();
  await tick();
  assert.equal(wrong.clicks, 0);
  assert.equal(run.observers[0].live, true, "vẫn còn phải chờ");

  // Giờ phần tử đúng xuất hiện.
  const right = pageEl("Cài Đặt", "button", { log, id: "right" });
  matches["#basic-button"] = [right];
  run.observers[0].callback();
  await tick();

  assert.equal(right.clicks, 1, "đúng phần tử thì tour chạy tiếp");
});

test("3B: hết thời gian chờ thì dừng lại nói rõ, không bấm bừa", async () => {
  const log = [];
  const run = loadContent({
    job: liveJob([liveStep({ action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 15 } })]),
    matches: {},
    log,
  });
  await tick();
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(cardText(run.document, ".title"), "Không mở được trang của bước");
  assert.equal(log.filter((e) => e.kind === "click").length, 0);
});
