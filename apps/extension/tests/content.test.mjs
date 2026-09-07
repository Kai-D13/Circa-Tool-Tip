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
 * precisely a message that was never sent to a listener that did not exist. So this
 * loads the three scripts the way Chrome loads them, into a DOM small enough to read,
 * and asserts what the operator would actually see on the page: the number on the bar.
 */
function loadContent({ session }) {
  const out = mkdtempSync(join(tmpdir(), "tg-ext-"));
  try {
    execFileSync(process.execPath, [resolve(EXT, "build.mjs"), "--out", out], { stdio: "pipe" });

    const sent = [];
    let onMessage = null;
    const timers = [];

    const document = fakeDocument();
    const ctx = {
      console,
      URL,
      TextEncoder,
      crypto: globalThis.crypto,
      Element: class Element {},
      document,
      location: { href: "https://pos.v2.circa.vn/trang-chu", pathname: "/trang-chu", search: "", origin: "https://pos.v2.circa.vn" },
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
              return { v: 1, ok: true, type: "tg:hello", data: { tabId: 7, recording: session } };
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

    for (const file of ["vendor/guide-schema.global.js", "selector.js", "content.js"]) {
      vm.runInContext(readFileSync(resolve(out, file), "utf8"), ctx);
    }
    return { ctx, document, sent, deliver: (message) => onMessage(message), timers };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Just enough DOM for the recorder's overlay: a tree, attributes, and a shadow root. */
function fakeEl(tag) {
  const attrs = {};
  const stubs = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    className: "",
    id: "",
    textContent: "",
    innerHTML: "",
    children: [],
    parentNode: null,
    shadow: null,
    setAttribute: (k, v) => (attrs[k] = String(v)),
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
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
    // innerHTML is set once, then queried by class; a stable stub per selector is all
    // the recorder needs from it.
    querySelector(selector) {
      if (!stubs.has(selector)) stubs.set(selector, fakeEl("span"));
      return stubs.get(selector);
    },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 10, height: 10 }),
  };
  return el;
}

function fakeDocument() {
  const body = fakeEl("body");
  return {
    body,
    documentElement: fakeEl("html"),
    createElement: (tag) => fakeEl(tag),
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
  };
}

const session = (id, steps) => ({
  v: 1,
  id,
  guideId: "g1",
  site: "pos",
  startUrl: "/trang-chu",
  tabId: 7,
  mode: "append",
  status: "recording",
  steps,
  startedAt: "2026-09-07T00:00:00.000Z",
});

const steps = (n) => Array.from({ length: n }, (_, i) => ({ selectors: ["#s" + i], matchText: "s" + i, tag: "button" }));

/** What the operator reads off the bar on the recorded page. */
function barText(document, part) {
  const host = document.body.children.find((c) => c.id === "circa-tooltip-recorder");
  if (!host) return null;
  const bar = host.shadow.children.find((c) => c.className === "bar");
  return bar.querySelector(part).textContent;
}

/* ------------------------------------------------------------------------ arming */

test("a page inside a recording arms itself and shows the step count", async () => {
  const { document, sent } = loadContent({ session: session("rec_1", steps(3)) });
  await tick();

  assert.equal(sent[0].type, "tg:hello");
  assert.equal(barText(document, ".count"), "3 bước");
  assert.ok(
    sent.some((m) => m.type === "tg:navigated" && m.sessionId === "rec_1"),
    "phải báo vị trí hiện tại khi bắt đầu ghi",
  );
});

test("a page outside any recording stays inert", async () => {
  const { document } = loadContent({ session: null });
  await tick();
  assert.equal(document.body.children.length, 0, "không được chèn UI vào trang không ghi");
});

/* -------------------------------------------------------------------------- undo */

test("P1 REGRESSION: a pushed session updates the counter on the page", async () => {
  // Undo happens between the Portal and the worker; this tab does nothing. Before the
  // fix nothing told it, so the bar kept showing the step that had just been removed.
  const { document, deliver } = loadContent({ session: session("rec_1", steps(3)) });
  await tick();
  assert.equal(barText(document, ".count"), "3 bước");

  deliver({ type: "tg:session", session: session("rec_1", steps(2)) });
  assert.equal(barText(document, ".count"), "2 bước", "counter phải giảm ngay, không đợi click kế tiếp");
});

test("a session belonging to another recording is ignored", async () => {
  const { document, deliver } = loadContent({ session: session("rec_1", steps(3)) });
  await tick();

  deliver({ type: "tg:session", session: session("rec_KHAC", steps(99)) });
  assert.equal(barText(document, ".count"), "3 bước", "phiên ghi khác không được vẽ đè lên tab này");
});

test("a malformed push does not blank the bar", async () => {
  const { document, deliver } = loadContent({ session: session("rec_1", steps(3)) });
  await tick();

  deliver({ type: "tg:session" });
  deliver({ type: "tg:session", session: null });
  assert.equal(barText(document, ".count"), "3 bước");
});

/* ------------------------------------------------------------------------ disarm */

test("disarm removes the overlay so the page stops being a recorder", async () => {
  const { document, deliver } = loadContent({ session: session("rec_1", steps(2)) });
  await tick();
  assert.equal(document.body.children.length, 1);

  deliver({ type: "tg:disarm" });
  assert.equal(document.body.children.length, 0, "thanh ghi phải biến mất khỏi trang");
});

test("a second disarm is harmless", async () => {
  const { document, deliver } = loadContent({ session: session("rec_1", steps(1)) });
  await tick();
  deliver({ type: "tg:disarm" });
  deliver({ type: "tg:disarm" });
  assert.equal(document.body.children.length, 0);
});

/** The handshake is a promise chain; let it settle. */
function tick() {
  return new Promise((r) => setTimeout(r, 10));
}
