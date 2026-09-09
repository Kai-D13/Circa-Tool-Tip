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
const REPO = resolve(EXT, "../..");

/** Built fresh, loaded the way Chrome loads it: schema, then resolve, then tour. */
function load() {
  const out = mkdtempSync(join(tmpdir(), "tg-ext-"));
  try {
    execFileSync(process.execPath, [resolve(EXT, "build.mjs"), "--out", out], { stdio: "pipe" });
    const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, URL, console });
    for (const f of ["vendor/guide-schema.global.js", "resolve.js", "tour.js"]) {
      vm.runInContext(readFileSync(resolve(out, f), "utf8"), ctx);
    }
    return { tour: ctx.TG_TOUR, schema: ctx.GUIDE_SCHEMA, source: readFileSync(resolve(out, "tour.js"), "utf8") };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const { tour: T, schema: SCHEMA, source: TOUR_SRC } = load();

const SITES = { pos: "https://pos.v2.circa.vn", admin: "https://admin.v2.circa.vn" };

const step = (over = {}) => ({
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

const session = (steps, over = {}) => ({
  kind: "live",
  sites: SITES,
  guide: { id: "g1", name: "BÁN HÀNG", site: "pos", steps },
  stepIndex: 0,
  pending: null,
  navGuard: null,
  ...over,
});

const at = (pathname, origin = SITES.pos) => ({ origin, pathname, search: "", hash: "" });

/** Objects built inside the vm realm carry a different prototype; copy before comparing. */
const plain = (v) => ({ ...v });

/** The two things the gate asks the DOM. */
const dom = ({ visible = true, enabled = true } = {}) => ({
  isVisible: () => visible,
  isEnabled: () => enabled,
});

const target = (over = {}) => ({ element: { tag: "button" }, selector: "#basic-button", selectorIndex: 0, via: "selector", count: 1, ...over });

/* ------------------------------------------------------------ bảng hành vi */

test("năm action của guide đều có hành vi runtime rõ ràng", () => {
  assert.deepEqual(plain(T.behaviourOf("highlight")), { clicks: false, auto: false, waitsUrl: false, needsTarget: true });
  assert.deepEqual(plain(T.behaviourOf("click_next")), { clicks: true, auto: false, waitsUrl: false, needsTarget: true });
  assert.deepEqual(plain(T.behaviourOf("click_wait_url")), { clicks: true, auto: false, waitsUrl: true, needsTarget: true });
  assert.deepEqual(plain(T.behaviourOf("auto_click_next")), { clicks: true, auto: true, waitsUrl: false, needsTarget: true });
  assert.deepEqual(plain(T.behaviourOf("auto_click_wait_url")), { clicks: true, auto: true, waitsUrl: true, needsTarget: true });
});

test("manual không cần phần tử; wait_element thì cần", () => {
  assert.equal(T.behaviourOf("manual").needsTarget, false);
  assert.equal(T.behaviourOf("wait_element").needsTarget, true);
  assert.equal(T.behaviourOf("wait_element").clicks, false);
});

test("action lạ suy biến thành highlight, KHÔNG bao giờ thành click", () => {
  // Một guide viết theo schema mới hơn phải trơ ra ở đây, không được liều.
  for (const unknown of ["", null, undefined, "auto_submit_form", "click"]) {
    const b = T.behaviourOf(unknown);
    assert.equal(b.clicks, false, `${String(unknown)} không được click`);
    assert.equal(b.auto, false);
  }
});

test("toàn bộ 409 bước của corpus đều có action runtime xử lý được", () => {
  // Không được có bước nào rơi vào nhánh "không biết là gì" trên máy POS thật.
  const data = JSON.parse(readFileSync(resolve(REPO, "data/legacy-import.v5.json"), "utf8"));
  const steps = data.guides.flatMap((g) => g.steps);
  assert.equal(steps.length, 409, "corpus phải đúng 409 bước");

  const unhandled = new Set();
  for (const s of steps) if (!T.isHandledAction(s.action?.type)) unhandled.add(String(s.action?.type));
  assert.deepEqual([...unhandled], [], "còn action chưa xử lý");

  // Và bảng hành vi phủ đúng tập action của schema, không thừa không thiếu.
  assert.deepEqual(Object.keys(T.BEHAVIOUR).sort(), [...SCHEMA.ACTION_TYPES].sort());
});

/* -------------------------------------------------------- cổng auto-click */

test("không có phần tử thì không tự bấm", () => {
  assert.equal(T.autoClickGate(null, dom()).ok, false);
  assert.equal(T.autoClickGate({ element: null, via: "selector" }, dom()).ok, false);
});

test("R1: text trên trang đã khác thì tuyệt đối không tự bấm", () => {
  const gate = T.autoClickGate(target({ via: "selector-text-mismatch" }), dom());
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /TEXT/);
});

test("R1: selector khớp nhiều phần tử, chỉ lấy được cái đầu thì không tự bấm", () => {
  // "Lấy cái đầu tiên" là cách đọc, không phải giấy phép để bấm.
  const gate = T.autoClickGate(target({ via: "first_item", count: 12 }), dom());
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /đầu/);
});

test("phần tử ẩn hoặc bị vô hiệu hoá thì không tự bấm", () => {
  assert.match(T.autoClickGate(target(), dom({ visible: false })).reason, /ẩn/);
  assert.match(T.autoClickGate(target(), dom({ enabled: false })).reason, /vô hiệu/);
});

test("selector duy nhất, hoặc text lọc ra đúng một, thì được tự bấm", () => {
  // #basic-button khớp 9 phần tử trên POS và "Cài Đặt" lọc ra đúng một — đó chính là ca
  // phải chạy được, nếu không 13 guide POS không dùng được.
  assert.equal(T.autoClickGate(target({ via: "selector", count: 1 }), dom()).ok, true);
  assert.equal(T.autoClickGate(target({ via: "text", count: 9 }), dom()).ok, true);
  assert.equal(T.autoClickGate(target({ via: "text-fallback", count: 1 }), dom()).ok, true);
});

test("bước thường vẫn chạy được ở chỗ auto-click bị từ chối", () => {
  // Người dùng tự bấm là quyết định của họ; tự bấm hộ là quyết định của mình.
  const first = step({ action: { type: "click_next", expectedUrl: "", timeoutMs: 0 } });
  const auto = step({ action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 0 } });
  const many = target({ via: "first_item", count: 12 });

  assert.equal(T.stepReadiness(first, many, dom()).ok, true);
  assert.equal(T.stepReadiness(auto, many, dom()).ok, false);
});

test("bước manual chạy được kể cả khi không tìm thấy gì", () => {
  const manual = step({ action: { type: "manual", expectedUrl: "", timeoutMs: 0 } });
  assert.equal(T.stepReadiness(manual, null, dom()).ok, true);
  assert.equal(T.stepReadiness(step(), null, dom()).ok, false, "highlight thì vẫn cần phần tử");
});

/* ------------------------------------------------------------------ pending */

test("pending ghi rõ bước kế, URL đích và site đích", () => {
  const s = session([
    step({ id: "a", action: { type: "click_wait_url", expectedUrl: "", timeoutMs: 0 } }),
    step({ id: "b", urlPattern: "/don-hang", navigationUrl: "/don-hang" }),
  ]);
  const pending = T.pendingFor(s, 0, SCHEMA);

  assert.equal(pending.fromIndex, 0);
  assert.equal(pending.nextIndex, 1);
  assert.equal(pending.expectedUrl, "/don-hang", "expectedUrl rỗng thì lấy urlPattern của bước sau");
  assert.equal(pending.expectedSite, "pos");
  assert.ok(pending.createdAt);
});

test("pending sang site khác lấy đúng site đích", () => {
  const s = session([
    step({ action: { type: "click_wait_url", expectedUrl: "", timeoutMs: 0, expectedSiteOverride: "admin" } }),
    step({ site: "admin", urlPattern: "/quan-tri", navigationUrl: "/quan-tri" }),
  ]);
  assert.equal(T.pendingFor(s, 0, SCHEMA).expectedSite, "admin");
});

test("đã tới nơi hay chưa được hỏi bằng matcher chung, không phải so chuỗi", () => {
  // /don-hang phải chấp nhận cả /don-hang?tab=2 — chỉ stepMatchesLocation biết luật đó.
  const s = session(
    [step(), step({ site: "pos", urlPattern: "/don-hang", navigationUrl: "/don-hang" })],
    { pending: { fromIndex: 0, nextIndex: 1, expectedSite: "pos", expectedUrl: "/don-hang" } },
  );

  assert.equal(T.pendingArrived(s, at("/don-hang"), SCHEMA), true);
  assert.equal(T.pendingArrived(s, { ...at("/don-hang"), search: "?tab=2" }, SCHEMA), true);
  assert.equal(T.pendingArrived(s, at("/trang-chu"), SCHEMA), false);
  assert.equal(T.pendingArrived(s, at("/don-hang", SITES.admin), SCHEMA), false, "đúng path nhưng sai site");
});

test("không có pending thì không có gì để tới", () => {
  assert.equal(T.pendingArrived(session([step()]), at("/trang-chu"), SCHEMA), false);
});

/* --------------------------------------------------------------- điều hướng */

test("đang đúng trang thì chỉ việc vẽ", () => {
  const s = session([step()]);
  assert.deepEqual(plain(T.navigationDecision(s, 0, at("/trang-chu"), SCHEMA)), { action: "render" });
});

test("sai trang thì điều hướng tới đúng origin của bước", () => {
  const s = session([step({ site: "admin", urlPattern: "/quan-tri", navigationUrl: "/quan-tri" })]);
  const decision = T.navigationDecision(s, 0, at("/trang-chu"), SCHEMA);
  assert.equal(decision.action, "navigate");
  assert.equal(decision.url, "https://admin.v2.circa.vn/quan-tri", "bước Admin không được mở trên origin POS");
});

test("navGuard chặn vòng lặp điều hướng POS ↔ Admin", () => {
  // Chuyển sang Admin mà rơi vào màn đăng nhập: chuyển lại lần nữa sẽ nhảy qua nhảy lại
  // vô tận. Lần thứ hai phải là CHỜ, không phải đi tiếp.
  const s = session([step({ site: "admin", urlPattern: "/quan-tri", navigationUrl: "/quan-tri" })], {
    navGuard: { url: "https://admin.v2.circa.vn/quan-tri", createdAt: "x" },
  });
  const decision = T.navigationDecision(s, 0, at("/dang-nhap", SITES.admin), SCHEMA);

  assert.equal(decision.action, "wait");
  assert.match(decision.reason, /đăng nhập/);
});

test("bước dùng URL động thì dừng lại nói rõ, không đoán bừa", () => {
  const s = session([step({ urlPattern: "/don-hang/*", navigationUrl: "" })]);
  const decision = T.navigationDecision(s, 0, at("/trang-chu"), SCHEMA);
  assert.equal(decision.action, "stall");
});

/* ------------------------------------------------------------------ bước cuối */

test("biết được đâu là bước cuối", () => {
  const s = session([step(), step({ id: "b" })]);
  assert.equal(T.isLastStep(s, 0), false);
  assert.equal(T.isLastStep(s, 1), true);
  assert.equal(T.stepCount(s), 2);
});

test("module không tự viết lại resolver", () => {
  // Probe, chạy thử và runtime phải đồng ý tuyệt đối; bản sao thứ hai ở đây sẽ trôi.
  assert.match(TOUR_SRC, /TG_RESOLVE/);
  assert.ok(!/querySelectorAll|function resolveTarget/.test(TOUR_SRC), "tour.js không được tự tìm phần tử");
});

/* ============== 3B.1: đến nơi hay chưa phải hỏi ĐÍCH ĐÃ LƯU ==================== */

test("P1: expectedUrl tường minh quyết định, không phải urlPattern của bước kế", () => {
  // Lỗi cũ đọc thẳng bước kế, nên một action.expectedUrl viết tay bị bỏ qua hoàn toàn.
  const s = session([step(), step({ id: "b", urlPattern: "/bước-kế", navigationUrl: "/bước-kế" })], {
    pending: { fromIndex: 0, nextIndex: 1, expectedSite: "pos", expectedUrl: "/dich-tuong-minh" },
  });

  assert.equal(T.pendingArrived(s, at("/dich-tuong-minh"), SCHEMA), true, "đích đã lưu mới là đích");
  assert.equal(T.pendingArrived(s, at("/bước-kế"), SCHEMA), false, "tới bước kế nhưng chưa tới đích");
});

test("P1: expectedSite trong pending quyết định site đích", () => {
  const s = session([step(), step({ id: "b", site: "pos", urlPattern: "/quan-tri", navigationUrl: "/quan-tri" })], {
    pending: { fromIndex: 0, nextIndex: 1, expectedSite: "admin", expectedUrl: "/quan-tri" },
  });

  assert.equal(T.pendingArrived(s, at("/quan-tri", SITES.admin), SCHEMA), true);
  assert.equal(T.pendingArrived(s, at("/quan-tri", SITES.pos), SCHEMA), false, "đúng path nhưng sai site");
});

test("P1: wait-url ở BƯỚC CUỐI vẫn tới nơi được", () => {
  // Không có bước kế để đọc, nên cách cũ trả false mãi mãi và tour treo ở bước cuối.
  const s = session([step({ action: { type: "click_wait_url", expectedUrl: "/xong", timeoutMs: 0 } })], {
    pending: { fromIndex: 0, nextIndex: 1, expectedSite: "pos", expectedUrl: "/xong" },
  });

  assert.equal(T.pendingArrived(s, at("/xong"), SCHEMA), true);
  assert.equal(T.pendingCompletesTour(s), true, "tới nơi ở bước cuối nghĩa là xong tour");
});

test("P1: pending chưa tới bước cuối thì chưa phải kết thúc", () => {
  const s = session([step(), step({ id: "b" })], {
    pending: { fromIndex: 0, nextIndex: 1, expectedSite: "pos", expectedUrl: "/trang-chu" },
  });
  assert.equal(T.pendingCompletesTour(s), false);
});

test("P1: pending không có đích thì không bao giờ coi là đã tới", () => {
  const s = session([step(), step({ id: "b" })], {
    pending: { fromIndex: 0, nextIndex: 1, expectedSite: "pos", expectedUrl: "" },
  });
  assert.equal(T.pendingArrived(s, at("/trang-chu"), SCHEMA), false);
});

/* ============== 3B.1: mọi bước có click đều cần thấy được và bấm được ========== */

test("P1: click_next từ chối phần tử ẩn hoặc bị vô hiệu hoá", () => {
  const manual = step({ action: { type: "click_next", expectedUrl: "", timeoutMs: 0 } });
  assert.match(T.stepReadiness(manual, target(), dom({ visible: false })).reason, /ẩn/);
  assert.match(T.stepReadiness(manual, target(), dom({ enabled: false })).reason, /vô hiệu/);
  assert.equal(T.stepReadiness(manual, target(), dom()).ok, true);
});

test("P1: click_wait_url cũng vậy", () => {
  const manual = step({ action: { type: "click_wait_url", expectedUrl: "", timeoutMs: 0 } });
  assert.equal(T.stepReadiness(manual, target(), dom({ enabled: false })).ok, false);
});

test("P1: bước không bấm gì thì không bị chặn vì ẩn", () => {
  // highlight chỉ tô sáng — một phần tử ngoài màn hình vẫn cuộn tới được.
  const highlight = step({ action: { type: "highlight", expectedUrl: "", timeoutMs: 0 } });
  assert.equal(T.stepReadiness(highlight, target(), dom({ visible: false })).ok, true);
});

test("P1: bấm tay vẫn được phép chọn phần tử đầu, tự bấm thì không", () => {
  const many = target({ via: "first_item", count: 12 });
  const manual = step({ action: { type: "click_next", expectedUrl: "", timeoutMs: 0 } });
  const auto = step({ action: { type: "auto_click_next", expectedUrl: "", timeoutMs: 0 } });
  assert.equal(T.stepReadiness(manual, many, dom()).ok, true);
  assert.equal(T.stepReadiness(auto, many, dom()).ok, false);
});
