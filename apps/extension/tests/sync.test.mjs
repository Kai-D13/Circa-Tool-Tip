import test from "node:test";
import assert from "node:assert/strict";

import * as SCHEMA from "../../../packages/guide-schema/src/index.ts";
import { buildHeaders, createApi, headsUrl, releaseUrl } from "../src/supabase.js";
import { RELEASE_KEY, STATUS_KEY, SYNC_STATE, checkPayload, createSync } from "../src/sync.js";

/**
 * The sync pipeline, driven with a fake network and a fake storage area.
 *
 * The real schema package is used rather than a stub: "is this payload valid" is the
 * whole question, and a stub would answer whatever the test wanted.
 */

const ORIGINS = { pos: "https://pos.v2.circa.vn", admin: "https://admin.v2.circa.vn" };

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

const payload = (over = {}) => ({
  schemaVersion: 5,
  site: "pos",
  revision: 3,
  releasedAt: "2026-09-08T10:00:00.000Z",
  checksum: "sha256:aaa",
  sites: ORIGINS,
  groups: ["Bán hàng"],
  guides: [
    {
      id: "g1",
      legacyId: null,
      name: "BÁN HÀNG TẠI QUẦY",
      site: "pos",
      group: "Bán hàng",
      sortOrder: 0,
      start: { site: "pos", url: "/trang-chu" },
      steps: [step()],
    },
  ],
  ...over,
});

const headRow = (over = {}) => ({
  site_code: "pos",
  revision: 3,
  checksum: "sha256:aaa",
  released_at: "2026-09-08T10:00:00.000Z",
  ...over,
});

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
  };
}

/** Counts calls so "the payload was never downloaded" is an assertion. */
function fakeApi({ heads = [headRow()], releases = {}, failHeads = null, failRelease = null } = {}) {
  const calls = { heads: 0, release: [] };
  return {
    calls,
    async heads() {
      calls.heads++;
      if (failHeads) throw failHeads;
      return heads;
    },
    async release(site) {
      calls.release.push(site);
      if (failRelease) throw failRelease;
      return releases[site] ?? payload({ site });
    },
  };
}

const makeSync = (storage, api, over = {}) =>
  createSync({ storage, api, schema: SCHEMA, now: () => "2026-09-08T12:00:00.000Z", ...over });

/* ----------------------------------------------------------------- headers */

test("publishable key đi trong apikey, và KHÔNG bao giờ trong Authorization", () => {
  // sb_publishable_… không phải JWT; đặt nó vào Bearer là bị từ chối chứ không phải
  // được cấp quyền. Extension cũng không bao giờ đăng nhập thay một con người.
  const headers = buildHeaders("sb_publishable_abc");
  assert.equal(headers.apikey, "sb_publishable_abc");
  assert.ok(!("Authorization" in headers));
  assert.ok(!JSON.stringify(headers).includes("Bearer"));
});

test("URL đọc head lấy cả hai site trong một request", () => {
  const url = headsUrl("https://x.supabase.co/");
  assert.equal(url, "https://x.supabase.co/rest/v1/release_heads?select=site_code,revision,checksum,released_at");
  assert.ok(!url.includes("site_code=eq"), "không lọc theo site — một request cho cả hai");
  assert.equal(releaseUrl("https://x.supabase.co"), "https://x.supabase.co/rest/v1/rpc/get_release");
});

test("thiếu URL hoặc key thì báo ngay lúc dựng, không im lặng", () => {
  assert.throws(() => createApi({ url: "", key: "k" }), /Supabase URL/);
  assert.throws(() => createApi({ url: "https://x", key: "" }), /publishable key/);
});

test("request treo bị cắt bằng timeout, không giữ pipeline mở vĩnh viễn", async () => {
  // Một request treo sẽ làm alarm kế tiếp thấy "đang chạy" rồi bỏ qua, và extension âm
  // thầm ngừng đồng bộ mà không có lỗi ở đâu cả.
  const api = createApi({
    url: "https://x.supabase.co",
    key: "k",
    timeoutMs: 5,
    fetchImpl: (_t, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  await assert.rejects(() => api.heads());
});

/* ------------------------------------------------------- checkPayload thuần */

test("payload phải khớp revision của head vừa đọc", () => {
  // Chống trường hợp có bản phát hành xen vào giữa lúc probe và lúc tải.
  const problems = checkPayload(payload({ revision: 4 }), "pos", headRow({ revision: 3 }), SCHEMA);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /không khớp head/);
});

test("payload phải khớp checksum của head", () => {
  const problems = checkPayload(payload({ checksum: "sha256:khac" }), "pos", headRow(), SCHEMA);
  assert.match(problems.join(" "), /checksum/);
});

test("payload sai site bị từ chối", () => {
  const problems = checkPayload(payload({ site: "admin" }), "pos", headRow(), SCHEMA);
  assert.match(problems.join(" "), /site/i);
});

test("payload sai schemaVersion bị từ chối", () => {
  const problems = checkPayload(payload({ schemaVersion: 4 }), "pos", headRow(), SCHEMA);
  assert.match(problems.join(" "), /schemaVersion/);
});

test("payload hợp lệ không có vấn đề gì", () => {
  assert.deepEqual(checkPayload(payload(), "pos", headRow(), SCHEMA), []);
});

/* --------------------------------------------------------------- pipeline */

test("site chưa từng phát hành: no-release, và KHÔNG đưa revision 0 qua validator", async () => {
  // validateReleasePayload từ chối revision <= 0, và nó đúng. Gọi nó ở đây sẽ báo một
  // máy mới cài hoàn toàn bình thường là hỏng.
  const storage = fakeStorage();
  const api = fakeApi({ heads: [] });
  const result = await makeSync(storage, api).syncAll();

  assert.deepEqual(
    result.sites.map((s) => [s.site, s.action]),
    [
      ["pos", "no-release"],
      ["admin", "no-release"],
    ],
  );
  assert.equal(result.ok, true, "chưa phát hành không phải là lỗi");
  assert.equal(storage.dump()[STATUS_KEY("pos")].state, SYNC_STATE.NO_RELEASE);
  assert.equal(storage.dump()[RELEASE_KEY("pos")], undefined, "không cache gì cả");
  assert.equal(api.calls.release.length, 0, "không tải payload nào");
});

test("revision không đổi thì không tải payload", async () => {
  const storage = fakeStorage({ [RELEASE_KEY("pos")]: payload() });
  const api = fakeApi();
  const result = await makeSync(storage, api).syncAll();

  assert.equal(result.sites.find((s) => s.site === "pos").action, "unchanged");
  assert.equal(api.calls.release.length, 0, "revision y hệt — không được tốn một byte nào");
  assert.equal(storage.dump()[STATUS_KEY("pos")].revision, 3);
});

test("revision cao hơn thì tải, kiểm, rồi mới đổi cache", async () => {
  const storage = fakeStorage({ [RELEASE_KEY("pos")]: payload({ revision: 2, checksum: "sha256:cu" }) });
  const api = fakeApi({ heads: [headRow({ revision: 3 })] });
  await makeSync(storage, api).syncAll();

  assert.deepEqual(api.calls.release, ["pos"]);
  assert.equal(storage.dump()[RELEASE_KEY("pos")].revision, 3);
  assert.equal(storage.dump()[STATUS_KEY("pos")].state, SYNC_STATE.OK);
  assert.equal(storage.dump()[STATUS_KEY("pos")].checksum, "sha256:aaa");
});

/* ----------------------------------------- cache tốt không bao giờ bị mất */

test("head đổi giữa lúc tải payload: giữ bản cũ", async () => {
  // Probe thấy revision 3, nhưng payload tải về là revision 4 vì có người publish xen
  // vào. Cache nó dưới số cũ thì lần sau thấy "không đổi" và sai vĩnh viễn.
  const good = payload({ revision: 2, checksum: "sha256:cu" });
  const storage = fakeStorage({ [RELEASE_KEY("pos")]: good });
  const api = fakeApi({ heads: [headRow({ revision: 3 })], releases: { pos: payload({ revision: 4 }) } });

  const result = await makeSync(storage, api).syncAll();

  assert.equal(result.sites.find((s) => s.site === "pos").action, "error");
  assert.deepEqual(storage.dump()[RELEASE_KEY("pos")], good, "bản đang dùng phải nguyên vẹn");
  assert.match(storage.dump()[STATUS_KEY("pos")].message, /không khớp head/);
});

test("payload hỏng: giữ bản cũ, không bao giờ xoá cache", async () => {
  const good = payload({ revision: 2, checksum: "sha256:cu" });
  const storage = fakeStorage({ [RELEASE_KEY("pos")]: good });
  const api = fakeApi({
    heads: [headRow({ revision: 3 })],
    releases: { pos: payload({ revision: 3, guides: "không phải mảng" }) },
  });

  await makeSync(storage, api).syncAll();
  assert.deepEqual(storage.dump()[RELEASE_KEY("pos")], good);
  assert.equal(storage.dump()[STATUS_KEY("pos")].state, SYNC_STATE.ERROR);
  assert.equal(storage.dump()[STATUS_KEY("pos")].revision, 2, "status vẫn trỏ vào bản đang thật sự dùng");
});

test("mất mạng lúc đọc head: cả hai site giữ nguyên cache", async () => {
  const storage = fakeStorage({
    [RELEASE_KEY("pos")]: payload(),
    [RELEASE_KEY("admin")]: payload({ site: "admin" }),
  });
  const api = fakeApi({ failHeads: new Error("Failed to fetch") });

  const result = await makeSync(storage, api).syncAll();

  assert.equal(result.ok, false);
  assert.equal(result.sites.length, 2, "một lần probe hỏng thì cả hai site cùng báo lỗi");
  assert.ok(storage.dump()[RELEASE_KEY("pos")], "cache POS còn");
  assert.ok(storage.dump()[RELEASE_KEY("admin")], "cache Admin còn");
});

test("mất mạng lúc tải payload: giữ bản cũ", async () => {
  const good = payload({ revision: 2 });
  const storage = fakeStorage({ [RELEASE_KEY("pos")]: good });
  const api = fakeApi({ heads: [headRow({ revision: 3 })], failRelease: new Error("timeout") });

  await makeSync(storage, api).syncAll();
  assert.deepEqual(storage.dump()[RELEASE_KEY("pos")], good);
  assert.match(storage.dump()[STATUS_KEY("pos")].message, /Không tải được/);
});

test("head thấp hơn bản đang có là lỗi, không phải lý do hạ cấp", async () => {
  // Rollback phát hành nội dung cũ dưới số CAO hơn, chính là để trường hợp này được coi
  // là bất thường. Extension từ chối downgrade.
  const good = payload({ revision: 9 });
  const storage = fakeStorage({ [RELEASE_KEY("pos")]: good });
  const api = fakeApi({ heads: [headRow({ revision: 3 })] });

  await makeSync(storage, api).syncAll();
  assert.deepEqual(storage.dump()[RELEASE_KEY("pos")], good);
  assert.match(storage.dump()[STATUS_KEY("pos")].message, /thấp hơn/);
  assert.equal(api.calls.release.length, 0, "không tải bản thấp hơn về làm gì");
});

/* ------------------------------------------------------- hai site độc lập */

test("POS thành công, Admin thất bại — mỗi site đi đường riêng", async () => {
  const storage = fakeStorage({ [RELEASE_KEY("admin")]: payload({ site: "admin", revision: 1 }) });
  const api = {
    calls: { release: [] },
    async heads() {
      return [headRow({ site_code: "pos", revision: 3 }), headRow({ site_code: "admin", revision: 2 })];
    },
    async release(site) {
      this.calls.release.push(site);
      if (site === "admin") throw new Error("Admin hỏng");
      return payload({ site: "pos", revision: 3 });
    },
  };

  const result = await makeSync(storage, api).syncAll();

  assert.equal(result.sites.find((s) => s.site === "pos").action, "updated");
  assert.equal(result.sites.find((s) => s.site === "admin").action, "error");
  assert.equal(storage.dump()[RELEASE_KEY("pos")].revision, 3, "POS vẫn được cập nhật");
  assert.equal(storage.dump()[RELEASE_KEY("admin")].revision, 1, "Admin giữ bản cũ");
});

/* ------------------------------------------------------- một pipeline duy nhất */

test("nhiều trigger cùng lúc chỉ chạy một lần đồng bộ", async () => {
  // Cài đặt, khởi động, alarm và nút Đồng bộ đều có thể nổ cùng lúc trên một máy vừa
  // bật. Chạy song song là tải cùng một payload vài lần và hai writer đua trên một key.
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const api = {
    calls: { heads: 0, release: [] },
    async heads() {
      this.calls.heads++;
      await gate;
      return [headRow()];
    },
    async release(site) {
      this.calls.release.push(site);
      return payload({ site });
    },
  };
  const sync = makeSync(fakeStorage(), api);

  const runs = [sync.syncAll(), sync.syncAll(), sync.syncAll()];
  release();
  const results = await Promise.all(runs);

  assert.equal(api.calls.heads, 1, "ba trigger, một lần probe");
  assert.equal(results[0], results[1], "cùng một promise được chia sẻ");
  assert.equal(results[1], results[2]);
});

test("xong rồi thì lần đồng bộ sau vẫn chạy được", async () => {
  const api = fakeApi();
  const sync = makeSync(fakeStorage(), api);
  await sync.syncAll();
  await sync.syncAll();
  assert.equal(api.calls.heads, 2, "guard phải nhả, không được kẹt sau lần đầu");
});

/* ------------------------------------------- sống sót qua worker restart */

test("service worker khởi động lại vẫn đọc được cache", async () => {
  // storage.local sống qua worker eviction và qua cả restart trình duyệt. Đây chính là
  // lý do cache KHÔNG nằm ở storage.session.
  const storage = fakeStorage();
  await makeSync(storage, fakeApi()).syncAll();

  const afterRestart = makeSync(storage, fakeApi({ failHeads: new Error("chưa có mạng") }));
  const cached = await afterRestart.readCache("pos");
  assert.equal(cached.revision, 3, "guide vẫn dùng được ngay cả khi chưa sync lại được");

  const status = await afterRestart.status();
  assert.equal(status.pos.state, SYNC_STATE.OK);
  assert.equal(status.admin.state, SYNC_STATE.NO_RELEASE, "site chưa publish có trạng thái mặc định");
});

test("status trả về cả hai site kể cả khi chưa bao giờ đồng bộ", async () => {
  const status = await makeSync(fakeStorage(), fakeApi()).status();
  assert.deepEqual(Object.keys(status).sort(), ["admin", "pos"]);
  assert.equal(status.pos.revision, 0);
});
