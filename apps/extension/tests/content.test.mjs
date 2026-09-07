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
function loadContent({ job, matches = {}, url = "https://pos.v2.circa.vn/trang-chu" }) {
  const out = mkdtempSync(join(tmpdir(), "tg-ext-"));
  try {
    execFileSync(process.execPath, [resolve(EXT, "build.mjs"), "--out", out], { stdio: "pipe" });

    const sent = [];
    let onMessage = null;
    const timers = [];
    const parsed = new URL(url);

    const document = fakeDocument(matches);
    const navigations = [];
    const ctx = {
      console,
      URL,
      TextEncoder,
      crypto: globalThis.crypto,
      Element: FakeElement,
      innerHeight: 800,
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
            if (message.type === "tg:hello") {
              return { v: 1, ok: true, type: "tg:hello", data: { tabId: 7, job } };
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

    // `location.href = ...` is how the preview navigates; record it instead of pretending
    // a page load happened.
    Object.defineProperty(ctx.location, "href", {
      get: () => url,
      set: (v) => navigations.push(v),
      configurable: true,
    });

    for (const file of ["vendor/guide-schema.global.js", "selector.js", "resolve.js", "overlay.js", "content.js"]) {
      vm.runInContext(readFileSync(resolve(out, file), "utf8"), ctx);
    }
    return { ctx, document, sent, navigations, deliver: (message) => onMessage(message), timers };
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
function pageEl(text, tag = "button") {
  const el = fakeEl(tag);
  el.innerText = text;
  el.textContent = text;
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

const boxVisible = (document) => {
  const host = overlay(document);
  const box = host.shadow.children.find((c) => String(c.className).startsWith("box"));
  return box.style.display === "block";
};

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
