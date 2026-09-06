# Circa Tool-tip — Implementation Plan v1.1

| | |
|---|---|
| **Version** | 1.1 |
| **Ngày** | 2026-09-06 |
| **Thay thế** | Plan v1.0 (Conditional Approval — 7 P0 + 5 P1) |
| **Trạng thái** | Đã áp dụng toàn bộ correction P0/P1 của stakeholder audit |
| **Phạm vi code** | Chỉ repo `Circa-Tool-Tip`. **Không sửa** `C:\QR_code\tooltip-guide-extension` |

---

## 0. Correction log — v1.0 → v1.1

Mỗi mục ghi rõ v1.0 sai gì và v1.1 làm gì. Đây là phần acceptance của Bước 0.

### P0-1 — Bỏ yêu cầu tự quản lý `.pem`

* **v1.0:** sinh RSA keypair, nhét public key vào `manifest.key`, bắt buộc upload Web Store bằng đúng `.pem`; liệt kê "mất .pem = chết kênh portal↔extension" thành rủi ro R3.
* **v1.1:** Chrome Web Store nhận ZIP và **tự quản lý việc ký**. Quy trình:
  1. Dev build ZIP.
  2. Stakeholder tạo draft item trên CWS Developer Dashboard, upload ZIP.
  3. CWS cấp **Extension ID** + public key của item.
  4. Nếu cần ID local trùng ID Store, dán public key đó vào `manifest.key` cho bản load-unpacked.
  5. Portal đọc ID qua `NEXT_PUBLIC_EXTENSION_ID`.
* **Trong lúc phát triển:** dùng ID của bản Load unpacked hiện tại. Không sinh `.pem`. Không có file `.pem` nào trong repo.
* **D2 và R3 bị xoá khỏi blocker MVP.** Không tạo `docs/EXTENSION_KEY_CUSTODY.md`.

### P0-2 — Vercel domain không phải blocker

* **v1.0:** khẳng định `externally_connectable` không match được `*.vercel.app` nên **bắt buộc** custom domain trước khi code.
* **v1.1:** hạn chế đó chỉ áp dụng cho **wildcard subdomain**. Một hostname cụ thể hoàn toàn hợp lệ:
  * Dùng được: `"https://circa-tool-tip.vercel.app/*"`
  * Không dùng được: `"https://*.vercel.app/*"`
* **v1.1 xử lý:** D1 hạ từ *blocking trước khi code* xuống **"phải chốt trước khi build Web Store release"**. Custom domain `tooltip.circa.vn` là tuỳ chọn, không bắt buộc.
* **Dev manifest** dùng `"http://localhost/*"`; portal chạy `http://localhost:3000`. Preview URL động của Vercel không chạy recorder — chấp nhận và ghi vào docs.
* Đổi domain sau khi đã lên Store: chỉ cần release phiên bản extension mới; **Extension ID không đổi**.

### P0-3 — Migration auth chỉ trích phần cần thiết

* **v1.0:** "port verbatim dòng 1-147" của `20260712090000_consultation_platform.sql`.
* **v1.1:** dòng 1-147 chứa cả `dataset_status`, `dataset_versions`, `consultation_rules`, `dataset_audit_logs` và RLS của chúng — copy nguyên là kéo nguyên schema sản phẩm cũ sang, trái quyết định "project độc lập".
* **`0001_auth_spine.sql` chỉ gồm:** `pgcrypto`, `admin_allowlist`, `profiles`, `handle_new_user()`, `is_admin()`, RLS + policy của đúng hai bảng đó.
* **Không** tạo `dataset_*`. **Không** tạo enum `dataset_status`.
* **Admin user đã tồn tại trước migration** (`hoangvudn96@gmail.com`) nên trigger `handle_new_user()` không tự chạy → migration có bước **backfill `profiles` từ `auth.users`, lookup bằng `lower(trim(email))`, không hardcode UUID**.

### P0-4 — Schema release hết mâu thuẫn

* **v1.0:** khai báo enum `release_status ('active','superseded')` nhưng bảng `releases` không có cột `status`, trong khi RPC lại "mark previous superseded".
* **v1.1:** chọn phương án tối giản, bỏ hẳn trạng thái:
  * **Xoá enum `release_status`.**
  * `releases` **immutable tuyệt đối** — insert xong không update.
  * `release_heads` (1 dòng/site) trỏ tới release hiện hành. Đây là **nguồn sự thật duy nhất** về "bản nào đang chạy".
  * Rollback = copy payload cũ thành **revision mới lớn hơn**, ghi `rolled_back_from`.
* Rollback monotonic của v1.0 được giữ nguyên vì đúng: extension từ chối downgrade, nếu lùi revision thì mọi máy đã nhận bản cao hơn sẽ đứng vĩnh viễn.

### P0-5 — Model `site` của step tương thích quy trình import

* **v1.0:** `StepV5.site` bắt buộc — mâu thuẫn với importer đưa 48 guide vào `unassigned` (lúc normalize chưa biết POS hay Admin).
* **v1.1:** tách hai hình dạng:

  | | Draft (`guides.draft_steps`) | Release (`releases.payload`) |
  |---|---|---|
  | Trường site | `siteOverride?` — **chỉ có khi step thực sự nhảy site khác** | `site` — **bắt buộc** |
  | Nguồn | step kế thừa `guides.site_code` | materialize lúc publish: `site = siteOverride ?? guide.site_code` |
  | Guide legacy | 409 step đều **không** có `siteOverride` → kế thừa site được Admin gán | mọi step có site cụ thể |

* `validateReleasePayload()` **từ chối** bất kỳ step nào site null/rỗng, hoặc site không có trong bảng `sites`.
* Nhờ vậy vừa nhập được 48 guide legacy (chưa phân loại) vừa hỗ trợ guide cross-origin viết mới.

### P0-6 — Phá vòng lặp QA ↔ publish

* **v1.0:** guide rủi ro không được publish trước khi replay, nhưng replay lại yêu cầu release đã publish → dependency cycle.
* **v1.1:** replay chạy **từ draft**, qua giao thức Portal → Extension `PREVIEW_GUIDE`, không đọc release:

```
Import draft → phân loại site (48/48) → replay draft qua PREVIEW_GUIDE
  → sửa selector → Admin duyệt guide → publish release → sync smoke-test
```

* Extension không cần release nào tồn tại để preview: payload guide đi thẳng qua message, chạy trong session `mode:"preview"`.
* Sau publish chỉ còn **smoke test sync** (revision probe → tải payload → validate → swap), không phải replay lại toàn bộ.

### P0-7 — Bỏ các hard gate ngoài phạm vi đã chốt

* **v1.0 tự thêm:** `destructive:true` bắt end-user confirm trong runtime; chặn cứng 24 guide ở database; SQL PII backstop trong RPC publish.
* **Stakeholder đã chốt:** extension vẫn chạy business auto-click, không thêm guard phức tạp. v1.1 gỡ toàn bộ ba thứ trên.
* **v1.1 giữ / thay bằng:**

  | Bỏ | Thay bằng |
  |---|---|
  | `destructive:true` + confirm runtime | Không có. Runtime không hỏi end-user. |
  | DB hard-block 24 guide | **Portal cảnh báo** khi publish guide còn step `auto_click_*` + `SEL_STRUCTURAL_AND_NO_TEXT`, yêu cầu Admin **xác nhận có chủ đích**. Không chặn ở database. |
  | SQL PII backstop trong publish | **Importer scrub triệt để**: xoá số điện thoại, query môi trường cũ, UUID định danh — để URL tái sử dụng được. Assertion nằm ở importer. |
  | — | **`isActionable()` được GIỮ** — đây là kiểm tra kỹ thuật thuần: element phải `isConnected`, không `disabled`/`aria-disabled`, không nằm trong `[inert]`/`[aria-hidden]`, visible, kích thước > 0. Không phải guard nghiệp vụ. |
  | — | 72 step structural+textless vào **repair queue ưu tiên**. |

* QA 2 pha (dry-run → full auto-click trên danh sách được duyệt) giữ nguyên.

### P1-1 — Bỏ permission `tabs`

`chrome.tabs.create()` và `chrome.tabs.onRemoved` **không** cần permission `tabs`; permission này chỉ để đọc `url`/`title`/`pendingUrl`/`favIconUrl`. Recorder lấy URL từ chính content script (qua message), không đọc `tab.url`. → **Bỏ `tabs`** khỏi manifest để giảm cảnh báo review Web Store. `chrome.tabs.sendMessage` chỉ cần host permission.

Manifest cuối: `permissions: ["storage","alarms"]`.

### P1-2 — Next.js 16 + `proxy.ts`

Dùng **Next.js 16**; convention `middleware.ts` đã đổi thành **`proxy.ts`**. Không tạo `middleware.ts`. Version pin cứng trong `apps/admin/package.json`.

### P1-3 — Packager dùng allowlist manifest-driven

* **v1.0:** đổi fixed-list thành "glob trừ exclude" → rủi ro đóng gói nhầm `.env`, fixture, source map, artifact nội bộ.
* **v1.1:** allowlist suy ra từ chính `manifest.json`:
  1. Mọi file được `manifest.json` tham chiếu (`background.service_worker`, `content_scripts[].js/css`, `action.default_popup`, `icons`, `web_accessible_resources`, `default_locale` → `_locales/*/messages.json`).
  2. Đồ thị phụ thuộc runtime của các file đó.
  3. Thư mục asset **được khai báo tường minh** trong config packager.
* **CI fail** nếu: manifest tham chiếu file không tồn tại, **hoặc** ZIP chứa file ngoài allowlist.
* Viết bằng Node (`fs.readFileSync(p,'utf8')`) nên lỗi encoding kiểu `build-package.ps1:52` không thể tái diễn, và CI Linux chạy được.

### P1-4 — Admin sidebar: node của extension, không `cloneNode`

* **v1.0:** `cloneNode(true)` accordion `POS Tools`.
* **v1.1:** clone kéo theo `aria-controls`, `aria-expanded`, ID của descendant, icon expand/ripple và cấu trúc accordion không cần thiết → tạo **node riêng của extension**, style theo số đo thật:
  * sidebar ~`209px`, nền trắng, container `ul.MuiList-root`
  * item cao `46px`, padding `0 12px`, `role="button"`
  * chữ Roboto `14px/21px`, màu `rgb(88,88,94)`
  * chèn **sau** ancestor `[role="button"]` chứa text chuẩn hoá `POS Tools` (trong `MuiAccordionSummary`)
  * ID riêng `#tg-nav-entry`, đảm bảo duy nhất một instance
  * `MutationObserver` debounce phục hồi khi React rerender
  * sidebar collapse → chỉ icon, giữ `aria-label`/`title` = `Tool-tip`
  * **không** phụ thuộc class `css-*`

### P1-5 — POS adapter không chỉ dựa `.h-nav.bg-primary`

Điều kiện nhận diện (tất cả phải đúng):
1. Button **visible** (`isActionable`).
2. Text chuẩn hoá (bỏ dấu, lowercase, gộp khoảng trắng) === `cai dat`.
3. Nằm trong navbar có sibling text chuẩn hoá thuộc `{ho tro, bao cao}`.
4. **Đúng một** candidate sau khi lọc — nhiều hơn thì không chèn và log cảnh báo.
5. Không dùng `#basic-button` (production có 9 element trùng ID), không dùng class `css-*`.

`.h-nav.bg-primary` chỉ là **gợi ý thu hẹp phạm vi tìm**, có fallback quét toàn document khi không thấy.

### Ghi chú `chrome.storage.session`

* Mặc định **không** cho content script truy cập → service worker phải gọi `chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })` trong **cả** `onInstalled` **và** `onStartup`. Thiếu dòng này thì mọi resume câm lặng, không báo lỗi.
* Dữ liệu bị xoá khi **extension reload/update** hoặc **browser restart** → chấp nhận được cho state của một tour đang chạy, nhưng **release cache phải nằm ở `chrome.storage.local`**, không phải session.
* `boot.js` có assertion: nếu đọc session trả `undefined` ở nơi đáng lẽ có record thì log lớn.

---

## 1. Repo và toolchain

```
Circa-Tool-Tip/
├─ package.json               pnpm workspaces; scripts: check | test | import:legacy
├─ pnpm-workspace.yaml
├─ .node-version              24
├─ .github/workflows/ci.yml
├─ apps/
│  ├─ admin/                  Next.js 16 + TS  (Batch 2)
│  └─ extension/              Chrome MV3       (Batch 3)
├─ packages/guide-schema/     schema + validator + URL matcher + checksum + flags
├─ scripts/import-legacy/     importer v4 → v5
├─ supabase/
│  ├─ migrations/  0001_auth_spine · 0002_guide_schema_v5 · 0003_rpcs
│  ├─ rollback/    .down.sql cho từng migration
│  ├─ seed/        sites.sql
│  └─ tests/       guide_rpc_test.sql (transactional, rollback)
├─ data/           legacy-import.v5.json (artifact importer sinh ra)
└─ docs/
```

**Không dùng transpiler.** Node 24 chạy TypeScript trực tiếp (type-stripping mặc định), nên `packages/guide-schema` viết bằng `.ts` và test bằng `node --test` không cần build step. Giữ đúng tiền lệ zero-dependency của `circa-consult-salesup` (`node --test`, `node --check`).

Bản IIFE global cho extension (`GUIDE_SCHEMA`) sinh ở Batch 3 bằng script Node nội bộ, không thêm bundler.

**Ràng buộc cú pháp:** chỉ dùng *erasable syntax* (`type`, `interface`, annotation). **Không** `enum`, không `namespace`, không parameter properties, không decorator — vì Node chỉ xoá type chứ không transform.

---

## 2. Schema v5

### 2.1 Trường bị loại khỏi v4

Đo trên toàn bộ 409 step: `intent` = `"exact"` ×409, `position` = `"auto"` ×409, `urlMatchMode` suy ra được 100% từ `urlPattern` (0 sai lệch), `selector === selectorCandidates[0]` ×409, `action.expectedUrl` = `""` ×409, `action.timeoutMs` = `0` ×409.

→ v5 bỏ `selector` (trùng `selectors[0]`), lược `intent`/`position`/`urlMatchMode` khi bằng mặc định.

### 2.2 Quy tắc `expectedUrl` — dòng quan trọng nhất của importer

`action.expectedUrl` rỗng trên **cả 409 step** trong khi 319 step dùng `auto_click_wait_url`. Runtime v4 suy đích từ step kế tiếp (`content.js:836`):

```js
const want = expectedUrl || (tourSteps[nextIdx] && tourSteps[nextIdx].urlPattern) || "";
```

→ Importer **materialize**: `expectedUrl := steps[i+1].urlPattern` cho `click_wait_url` / `auto_click_wait_url`. Nếu action chờ-URL rơi vào step cuối → flag `WAIT_URL_ON_LAST_STEP`.

### 2.3 Hình dạng step

```ts
type DraftStep = {
  id: string;                  // legacy: 'st_' + sha256(legacyGuideId + ':' + index).slice(0,10)
  siteOverride?: SiteCode;     // CHỈ khi step nhảy sang site khác (P0-5)
  selectors: string[];         // was selectorCandidates
  matchText: string;           // đã strip zero-width + gộp khoảng trắng
  matchTextStable?: boolean;
  tag: string;
  title: string;
  content: string;
  intent?: 'exact' | 'first_item';                   // lược khi 'exact'
  position?: 'auto'|'top'|'bottom'|'left'|'right';   // lược khi 'auto'
  urlPattern: string;
  navigationUrl: string;
  urlMatchMode?: 'path'|'path_query'|'exact'|'wildcard';  // lược khi == suy ra được
  action: { type: ActionType; expectedUrl: string; expectedSiteOverride?: SiteCode; timeoutMs: number };
  flags?: string[];            // authoring-only, BỊ STRIP khỏi release payload
};

type ReleaseStep = Omit<DraftStep, 'siteOverride' | 'flags'> & { site: SiteCode };  // site BẮT BUỘC
```

### 2.4 Release payload

```jsonc
{
  "schemaVersion": 5,
  "site": "pos",
  "revision": 42,
  "releasedAt": "2026-09-06T09:12:44.117Z",
  "checksum": "sha256:…",          // canonical JSON của groups + guides
  "sites": { "pos": "https://pos.v2.circa.vn", "admin": "https://admin.v2.circa.vn" },
  "groups": [ { "id": "…", "name": "Bán hàng", "sortOrder": 1 } ],
  "guides": [ { "id","legacyId","name","site","groupId","sortOrder","guideRevision",
                "start": { "site","url" }, "steps": [ /* ReleaseStep */ ] } ]
}
```

`sites` map site → origin là thứ cho phép `resolveUrl` thôi giả định `location.origin`, và là nền của handoff POS→Admin.

**Extension đồng bộ CẢ HAI release.** Menu trên POS vẫn phải hiện guide Admin (chọn xong thì điều hướng cross-origin), nên `release_heads` được probe cho cả hai site trong một request và cả hai payload đều được cache.

Kích thước: mảng guide legacy thô 255 KB → hai release ~500 KB trong `chrome.storage.local`, dưới hạn 10 MB, **không cần `unlimitedStorage`**. Lưu ý `urlPattern` dài nhất **1101 ký tự** → cột URL phải là `text`, UI phải truncate.

---

## 3. Supabase DDL (tóm tắt — chi tiết trong `supabase/migrations/`)

* `sites(code PK, label, origin UNIQUE, sort_order)` — seed `pos`, `admin`.
* `guide_groups(id, site_code FK, name, sort_order, UNIQUE(site_code,name))`
* `guides(id, legacy_id UNIQUE, site_code FK NULL, group_id FK NULL, name, status, start_url, sort_order, draft_steps jsonb, step_count, validation jsonb, site_guess, site_evidence jsonb, notes, audit cols)`
  * `status`: `unassigned | draft | published | archived`
  * CHECK `status = 'unassigned' OR site_code IS NOT NULL` — tiêu chí "48/48 phải có site trước publish" nằm ở database
* `guide_versions(id, guide_id FK, revision, steps jsonb, step_count, site_code, checksum, note, UNIQUE(guide_id,revision))` — immutable
* `releases(id, site_code FK, revision bigint, payload jsonb, checksum, guide_count, step_count, rolled_back_from FK NULL, note, audit cols, UNIQUE(site_code,revision))` — **immutable, không có cột status** (P0-4)
* `release_heads(site_code PK, release_id FK, revision, checksum, guide_count, step_count, released_at)` — 1 dòng/site

**RLS:** bật trên mọi bảng. Chỉ có policy **SELECT**:
* `sites`, `guide_groups`, `guides`, `guide_versions` → `authenticated` + `is_admin()`
* `releases`, `release_heads` → **`anon, authenticated`, `using (true)`** — đây là data plane của extension
* **Không có policy INSERT/UPDATE/DELETE trên bất kỳ bảng nào.** Mọi thay đổi đi qua RPC `security definer` mở đầu bằng `is_admin()` guard.

---

## 4. RPC

| # | Signature | Grant |
|---|---|---|
| 1 | `admin_list_guides(p_site, p_group, p_status) → jsonb` | authenticated |
| 2 | `admin_get_guide(p_guide_id) → jsonb` | authenticated |
| 3 | `admin_upsert_guide(...) → jsonb` | authenticated |
| 4 | `admin_save_guide_steps(p_guide_id, p_steps, p_validation, p_expected_updated_at) → jsonb` | authenticated |
| 5 | `admin_assign_guide_site(p_guide_id, p_site, p_group_id) → jsonb` | authenticated |
| 6 | `admin_set_guide_status(p_guide_id, p_status) → jsonb` | authenticated |
| 7 | `admin_delete_guide(p_guide_id) → jsonb` (từ chối khi `published`) | authenticated |
| 8 | `admin_create_guide_version(p_guide_id, p_note) → jsonb` | authenticated |
| 9 | `admin_publish_site(p_site, p_note) → jsonb` | authenticated |
| 10 | `admin_list_releases(p_site) → jsonb` | authenticated |
| 11 | `admin_rollback_site(p_site, p_release_id) → jsonb` | authenticated |
| 12 | `admin_import_legacy(p_payload, p_source_filename, p_checksum) → jsonb` (idempotent theo `legacy_id`) | authenticated |
| 13 | `get_release(p_site) → jsonb` | **anon, authenticated** |

Chuẩn bắt buộc: `language plpgsql security definer set search_path = public`, mở đầu `if not public.is_admin() then raise exception ... using errcode = '42501'` (trừ #13), dùng `is distinct from` cho mọi type gate jsonb (vì `jsonb_typeof(NULL)` là SQL NULL và `IF` coi NULL là false), kết thúc `revoke all ... from public; grant execute ... to <role>`.

`admin_publish_site` (v1.1 — đã gỡ PII backstop và auto-click hard-block):
1. `is_admin()`.
2. Mọi guide `published` của site có `site_code = p_site`, `group_id` (nếu có) thuộc đúng site.
3. Pin từng guide vào `guide_versions` mới nhất; tự tạo version nếu `draft_steps` đã trôi.
4. Materialize `step.site` cho toàn bộ step (P0-5).
5. Build payload, tính checksum, insert `releases` với `revision = coalesce(max,0)+1`.
6. **Reconciliation**: `jsonb_array_length(payload->'guides')` phải bằng số guide đếm được và tổng step phải bằng `step_count`, sai thì `raise` và abort.
7. Upsert `release_heads`.

`admin_rollback_site`: đọc payload của release cũ → insert **release mới revision cao hơn** với `rolled_back_from` → upsert head. Không bao giờ giảm revision.

---

## 5. Sync

1. **Probe** (REST GET, không phải RPC — `release_heads` vốn đã anon-readable):
   `GET /rest/v1/release_heads?select=site_code,revision,checksum,released_at` — 2 dòng, ~200 byte, một round trip cho cả hai site.
2. **Tải payload** chỉ cho site có `revision` khác cache: `POST /rest/v1/rpc/get_release {"p_site":"pos"}`.
3. **Validate trước khi swap**: `schemaVersion === 5`, `site` đúng, `revision` khớp bản vừa probe (chống republish giữa chừng), `checksum` trong payload khớp `release_heads.checksum`, mọi guide/step hợp lệ, mọi step có `site` hợp lệ.

   **Chính sách checksum (đã chốt lúc implement 0004).** Checksum tính trong SQL bằng `sha256(jsonb::text)`. Postgres serialize jsonb ổn định nên giá trị này nhất quán ở phía server, **nhưng không tái tạo được từ JavaScript** vì canonical JSON của JS sắp xếp key theo cách khác. Do đó extension **không tính lại** checksum; nó đối chiếu `release_heads.checksum` với `checksum` nhúng trong payload tải về, cộng với so khớp revision. Đó đúng là lỗi cần bắt: head bị đổi trong lúc payload đang truyền. Body bị cắt cụt thì `JSON.parse` chết, body sai cấu trúc thì `validateReleasePayload()` chặn. Hàm `releaseChecksum()` trong `packages/guide-schema` vẫn dùng cho portal để phát hiện draft trôi so với version đã snapshot, không dùng cho đường sync.
4. **Monotonic**: chỉ nhận `incoming.revision > current.revision`.
5. **Thất bại ở bất kỳ bước nào** → giữ nguyên `release:<site>`, chỉ ghi `releaseStatus:<site> = {ok:false, syncedAt, error}`.
6. **Hai pipeline độc lập** — POS lỗi không được làm Admin bị đánh dấu lỗi.
7. **Broadcast** `chrome.tabs.sendMessage` + `chrome.storage.onChanged`. **Tour đang chạy không bị giật**: session ghim `releaseRevision`, bản mới chỉ áp dụng sau `endTour`.

Trigger: `onInstalled`, `onStartup`, alarm 15 phút, nút "Đồng bộ", và `SYNC_NOW` từ portal.

---

## 6. Portal ↔ Extension (recorder)

`externally_connectable.matches`:
* dev: `["http://localhost/*"]`
* release: đúng **một** hostname production — chốt ở bước build ZIP, không phải bây giờ.

Gate phía extension (defence in depth, không thay thế `externally_connectable`):

```js
function portalSenderOk(sender) {
  if (sender.id) return false;                                  // extension khác
  if (!sender.tab) return false;
  return ALLOWED_PORTAL_ORIGINS.has(sender.origin);
}
```

One-shot: `HELLO`, `PREVIEW_GUIDE`, `PROBE_SELECTOR`, `SYNC_NOW`.
Long-lived port `tg-recorder`: `START` → `READY` → `STEP*` / `NAVIGATED` / `ERROR` → `UNDO` / `STOP` → `DONE`.

**State của recorder nằm trong `chrome.storage.session`, port chỉ là kênh thông báo**; portal có fallback poll `GET_RECORDING` mỗi 2s để sống sót qua việc MV3 evict service worker.

Portal đọc `NEXT_PUBLIC_EXTENSION_ID`. Cho phép override bằng localStorage **chỉ khi** `process.env.NODE_ENV !== 'production'`.

---

## 7. Per-tab session và handoff cross-origin

Thay toàn bộ key global `tg_tour` / `tg_preview` / `tg_pendingnav` / `tg_author_draft` / `lastPicked*` bằng **một record/tab** trong `chrome.storage.session`, key `tg:tour:<tabId>`:

```js
{ v:5, mode:"live"|"preview", guideId, guideRevision, releaseRevision,
  stepIndex, steps:null|Step[], pending:null|{fromIdx,nextIdx,want:{site,urlPattern},ts},
  navGuard:null|{url,ts}, ts }
```

Ba điều kiện bắt buộc:
1. `setAccessLevel("TRUSTED_AND_UNTRUSTED_CONTEXTS")` trong `onInstalled` **và** `onStartup`.
2. Content script không tự biết `tabId` → lấy một lần qua `sendMessage({type:"tg:hello"})`, background trả `sender.tab.id`.
3. **Giữ nguyên thứ tự ghi-trước-click**: `savePendingNavState(..., cb)` hiện gọi click trong callback (`content.js:848-851`) đúng để hard-navigation không cuốn mất bản ghi. v5 = `await session.setPending(...)` **rồi mới** `safeClick(t)`. Không được "tối giản" chỗ này.

Handoff POS→Admin chạy được vì **`chrome.storage.session` là extension-scoped, không phân vùng theo origin** (khác `sessionStorage`). Kéo theo:
* `resolveUrl` đổi từ `location.origin + path` sang `sites[step.site] + path`.
* `urlMatches` thêm mệnh đề đầu tiên là so khớp origin.
* `tg_navguard` chuyển từ `sessionStorage` vào record session — hiện nó bị phân vùng theo origin nên ping-pong POS↔Admin **đang không được bảo vệ**.
* Nếu POS/Admin không dùng chung phiên đăng nhập, thẻ chờ cross-origin để **5 phút** và đổi chữ thành "Đang chờ đăng nhập Admin…", giữ nguyên hai nút "Chờ thêm"/"Tiếp tục thủ công".

---

## 8. Các bug của bản cũ được sửa ở đâu

| Bug | Vị trí cũ | Cách sửa |
|---|---|---|
| Hai matcher URL không nhất quán | `urlMatches` `content.js:147` dùng ở 7 chỗ; `stepUrlMatches` `:289` chỉ dùng ở `:541`, `:660` | Một hàm thuần `stepMatchesLocation(step, loc, sites)` trong `packages/guide-schema`; `urlMatches(pattern)` bị xoá khỏi API công khai; `pending.want` đổi thành `{site,urlPattern}` để poller dùng chung hàm với route guard |
| Wildcard không neo đầu | `wildcardToRegExp` `:139` (`/ban-hang*` khớp cả `/xx/ban-hang-online`) | Neo `^` sau khi so origin. **Đổi hành vi của 91 step** → phải chứng minh bằng replay Batch 4, không merge theo niềm tin |
| Không kiểm tra visible/enabled | Toàn `content.js` 0 hit `offsetParent`/`getComputedStyle`/`disabled`/`checkVisibility` | `isActionable()` lọc ở **cả ba pass** của `resolveTarget` (`:384-392`, `:394-397`, `:399-404`) **và** trong callback `MutationObserver` của `waitForTarget` (`:736-740`) |
| Step cuối không auto-click | `onNext` `:637` `if (current < tourSteps.length - 1)` | Tái cấu trúc: resolve action → auto mà không có target thì giữ nguyên lỗi cứng (`:630-636`) → click → *rồi mới* advance-or-finish |
| State tour dùng chung mọi tab | `content.js:13-15,41` | §7 |
| `loadConfig` không normalize | `:47-71` | Release được validate lúc sync (trước swap) và lúc load |
| `startLocationWatch` không teardown | `:2546-2552` | Giữ interval 350ms (cách duy nhất bắt `pushState` từ isolated world) nhưng thêm teardown `pagehide` + return sớm khi không có tour |
| `getAction` trùng `normalizeAction` | `:768` vs `shared.js:21` | Một bản duy nhất trong `packages/guide-schema` |
| `inferModeFromPattern` trùng `inferUrlMatchMode` | `:271` vs `shared.js:35` | Như trên |

---

## 9. Batch

### Batch 1A — Foundation offline (PR đầu tiên)

Workspace + toolchain pin · `packages/guide-schema` · unit test URL/schema/checksum · legacy importer · `IMPORT_REPORT.md` · file migration Supabase **chưa chạy** · không đụng extension cũ.

Giao nộp: commit SHA/DIFF · danh sách file · lệnh test + full output · xác nhận 48 guide/409 step · bảng flag theo từng guide · migration SQL + hướng dẫn rollback.

**Acceptance:** 48/48 guide và 409/409 step ra khỏi importer không mất mát · `pnpm test` xanh · scrub assertion pass (0 chuỗi giống số điện thoại VN sau khi decode) · không file nào trong `tooltip-guide-extension` bị đổi.

### Batch 1B — Supabase + triage

Stakeholder chạy migration bằng SQL Editor → tạo Admin Auth user → seed allowlist → chạy SQL test trong transaction rollback → import 48 guide thành draft/unassigned → deploy màn triage → stakeholder phân loại 48/48. **Chưa publish release.**

### Batch 2 — Portal + recorder shell

CRUD guide/step · recorder Portal↔Extension · preview draft · repair queue · tích hợp Web Store draft ID · deploy production hostname cố định.

### Batch 3 — Viewer + sync + UI adapter

POS header adapter · Admin sidebar adapter · menu phân nhóm site · sync manual/15 phút · per-tab runtime · sửa URL/action/resume · đóng gói ZIP sạch.

### Batch 4 — QA và phân phối

Replay draft 48 guide (pha 1 dry-run) · repair step lỗi · stakeholder duyệt danh sách full auto-click · supervised production replay (pha 2) · publish release · smoke test sync · submit CWS Unlisted · cài bằng link trên 25 máy.

---

## 10. Rủi ro (đã cập nhật theo v1.1)

| # | Rủi ro | Giảm thiểu |
|---|---|---|
| R1 | Business auto-click bắn vào element resolve sai. 128 step auto-click không có text anchor dùng được; 72 trong số đó selector thuần cấu trúc, nằm ở 24/48 guide | `isActionable()` bắt buộc · giữ nguyên text gate của `resolveTarget` cho `intent:"exact"` (`:388`) · từ chối auto-click khi `querySelectorAll(sel).length > 1` mà text không phân biệt được · repair queue ưu tiên · Portal cảnh báo + Admin xác nhận khi publish. **Không** chặn cứng ở DB, **không** confirm runtime |
| R2 | UUID định danh cửa hàng ở `/sellback/eligible?pos=` đưa mọi cửa hàng về một POS | Importer strip param UUID + flag `URL_UUID_STRIPPED` → triage duyệt lại |
| R3 | Rollback làm lùi revision → extension đứng vĩnh viễn | Rollback mint revision mới cao hơn |
| R4 | Neo wildcard đổi hành vi 91 step | Chứng minh bằng replay Batch 4 trước khi merge |
| R5 | Republish giữa tour làm lệch index | Session ghim `releaseRevision`; bản mới chỉ áp sau `endTour` |
| R6 | MV3 evict service worker giữa phiên record | State ở `chrome.storage.session`; portal poll `GET_RECORDING` |
| R7 | Quên `setAccessLevel` | Assertion lớn trong `boot.js` |
| R8 | POS/Admin không dùng chung phiên đăng nhập | Thẻ chờ cross-origin 5 phút + đổi copy. Cần kiểm tra thủ công |
| R9 | Preview deployment của Vercel không chạy được recorder | Ghi vào docs; QA recorder trên hostname production hoặc localhost |

---

## 11. Còn chờ stakeholder (không chặn Batch 1A)

1. POS và Admin có dùng chung phiên đăng nhập trên máy cửa hàng không (R8).
2. Hostname production của Portal — chốt trước khi build Web Store release.
3. Sidebar Admin có chế độ collapse thật không, bật bằng cách nào.
4. Danh sách guide được duyệt chạy full auto-click ở QA pha 2 — chốt sau khi có báo cáo pha 1.
