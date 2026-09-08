# QA — Batch 3A (extension đồng bộ release)

Batch này làm extension tải bản phát hành từ Supabase về máy và giữ lại đó. **Chưa có gì
hiển thị cho nhân viên** — chưa có tab Tool-tip, chưa có menu, chưa chạy được guide. Đó là
3B và 3C.

Điều cần kiểm ở đây là một câu duy nhất: **máy POS luôn giữ được bộ hướng dẫn đang dùng,
kể cả khi mạng hỏng hoặc dữ liệu mới sai.**

> QA này **có** publish thật một bản release. Đây là lần đầu tiên `releases` khác `0`, và
> đó là chủ đích: không có release thì không kiểm được đồng bộ. Không có gì hiển thị trên
> POS nên nhân viên không bị ảnh hưởng.

## 0. Chuẩn bị

```bash
cd C:\QR_code\Circa-Tool-Tip
node apps/extension/build.mjs
```

Build đọc `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` từ biến môi trường, nếu không có thì
lấy từ `apps/admin/.env.local` — chỗ Portal vốn đã cấu hình sẵn.

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 0.1 | Đọc dòng cuối của output build | `supabase : https://yoqzsvcbsornqjcatdvy.supabase.co · key đã tiêm` | |
| 0.2 | `chrome://extensions` → **Reload** extension | Không lỗi đỏ. ID không đổi | |
| 0.3 | Xem **Permissions** | Thêm `alarms` và host `yoqzsvcbsornqjcatdvy.supabase.co`. Vẫn **không** có `tabs`, không `<all_urls>` | |
| 0.4 | Mở service worker → Console | Không lỗi đỏ | |
| 0.5 | `pnpm --filter admin dev`, mở `http://localhost:3000` và đăng nhập | Cần cho các lệnh ở mục dưới | |

## Hai Console khác nhau — đừng nhầm

Batch này dùng **hai** Console và chúng không thay thế cho nhau:

| Chạy ở đâu | Dùng cho | Vì sao |
|---|---|---|
| Console tab **Portal** (`localhost:3000`) | `SYNC_NOW`, `GET_SYNC_STATUS` | Đây là message của Portal, đi qua `externally_connectable`. Handler nội bộ trong service worker chỉ nhận message bắt đầu bằng `tg:` nên gọi từ Console service worker sẽ **không** có gì trả về |
| Console **service worker** | `chrome.storage.local.*`, `chrome.alarms.*`, tab Network | Trang web không gọi được các API này |

Lệnh đồng bộ, chạy trong Console **Portal**:

```js
chrome.runtime.sendMessage(
  "hgkjieodgaieajjijlbdecfkejaclndf",
  { v: 1, type: "GET_SYNC_STATUS" },
  console.log
)
```

```js
chrome.runtime.sendMessage(
  "hgkjieodgaieajjijlbdecfkejaclndf",
  { v: 1, type: "SYNC_NOW" },
  console.log
)
```

Mở Console service worker: `chrome://extensions` → dưới extension bấm **service worker**.

## 1. Chưa phát hành gì thì không phải là lỗi

Lúc này `releases` vẫn `= 0`.

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 1.1 | Console **Portal**: chạy `GET_SYNC_STATUS` | `sites.pos.state = "no-release"`, `sites.admin.state = "no-release"`, `revision: 0` | |
| 1.2 | Nhìn Console | **Không** có lỗi validate nào. Chưa phát hành là bình thường, không phải hỏng | |
| 1.3 | Console **service worker**: `chrome.storage.local.get(null, console.log)` | Có `releaseStatus:pos` / `releaseStatus:admin`, **không** có `release:pos` / `release:admin` | |

## 2. Publish thật lần đầu

Ở Portal: `/guides` → duyệt vài bộ POS → `/releases` → nhập ghi chú → **Phát hành site POS**.

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 2.1 | Publish POS | Portal hiện revision `1`, kèm số bộ/bước và checksum | |
| 2.2 | Kiểm SQL | `select count(*) from public.releases` = `1` | |
| 2.3 | Console **Portal**: chạy `SYNC_NOW` | `ok: true`, `sites` có `{ site: "pos", action: "updated", revision: 1 }` | |
| 2.4 | Console **service worker**: `chrome.storage.local.get("release:pos", console.log)` | Có payload đầy đủ: `schemaVersion: 5`, `site: "pos"`, `revision: 1`, mảng `guides` | |
| 2.5 | Console **service worker**: `chrome.storage.local.get("releaseStatus:pos", console.log)` | `state: "ok"`, `revision: 1`, `checksum` khớp với cái Portal hiện ở 2.1 | |
| 2.6 | Nhìn `releaseStatus:admin` | Vẫn `no-release` — Admin chưa publish, và POS thành công không đụng tới nó | |

## 3. Không tải lại thứ đã có

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 3.1 | Console **Portal**: chạy `SYNC_NOW` lần nữa ngay lập tức | `action: "unchanged"` cho POS | |
| 3.2 | Mở tab **Network** của service worker, rồi chạy `SYNC_NOW` ở Console Portal | Chỉ có request tới `release_heads`. **Không** có request `get_release` | |

Một máy POS chạy 8 tiếng/ngày sẽ probe khoảng 32 lần; chỉ tải payload khi thật sự có bản
mới.

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 3.3 | Console **service worker**: làm hỏng checksum trong cache bằng lệnh dưới, rồi chạy `SYNC_NOW` ở Console Portal | `action: "updated"` — **không** phải `unchanged`. Cache được tải lại và sửa đúng | |

```js
chrome.storage.local.get("release:pos", (b) => {
  const p = b["release:pos"];
  chrome.storage.local.set({ "release:pos": { ...p, checksum: "sha256:SAI" } }, () => console.log("đã làm hỏng"));
});
```

Revision nói *bản nào*, checksum nói *trong đó có gì*. Nếu chỉ so revision thì một lần
lệch là lệch vĩnh viễn — mọi lần đồng bộ sau đều báo "không đổi" và không bao giờ sửa
lại.

## 4. Có bản mới thì lấy về

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 4.1 | Ở Portal, duyệt thêm một bộ POS rồi **Phát hành site POS** lần nữa | Portal hiện revision `2` | |
| 4.2 | Console **Portal**: chạy `SYNC_NOW` | `action: "updated"`, `revision: 2` | |
| 4.3 | Console **service worker**: `chrome.storage.local.get("release:pos", console.log)` | `revision: 2`, và số guide tăng đúng | |

## 5. Mạng hỏng không được làm mất bộ đang dùng

Đây là mục quan trọng nhất của batch.

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 5.1 | DevTools của service worker → tab **Network** → chọn **Offline** | | |
| 5.2 | Console **Portal**: chạy `SYNC_NOW` | `ok: false`, mỗi site có `action: "error"` | |
| 5.3 | Console **service worker**: `chrome.storage.local.get("release:pos", console.log)` | **Payload vẫn còn nguyên, `revision: 2`** | |
| 5.4 | Console **service worker**: `chrome.storage.local.get("releaseStatus:pos", console.log)` | `state: "error"`, nhưng `revision: 2` — trạng thái vẫn trỏ vào bản đang thật sự dùng | |
| 5.5 | Bỏ **Offline**, chạy `SYNC_NOW` ở Console Portal | Trở lại `state: "ok"` | |

## 6. Sống sót qua service worker và qua restart

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 6.1 | Để yên ~40s cho service worker ngủ, rồi chạy `GET_SYNC_STATUS` ở Console Portal | Vẫn đọc được `revision: 2` | |
| 6.2 | Đóng hẳn Chrome, mở lại, đăng nhập Portal, chạy `GET_SYNC_STATUS` | Vẫn `revision: 2` — cache nằm ở `storage.local` nên sống qua restart | |
| 6.3 | `chrome://extensions` → **Reload** extension | Vẫn `revision: 2`. Reload extension **không** được xoá cache | |

6.2 và 6.3 là lý do cache không nằm ở `storage.session`: nếu nằm đó thì mỗi sáng và mỗi
lần cập nhật, 25 máy cùng lúc khởi động với không có hướng dẫn nào.

## 7. Lịch tự đồng bộ

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 7.1 | Console **service worker**: `chrome.alarms.getAll(console.log)` | Có alarm `tg-sync` với `periodInMinutes: 15` | |
| 7.2 | Reload extension rồi kiểm lại | Vẫn đúng một alarm `tg-sync`, không bị nhân đôi | |
| 7.3 | (Tuỳ chọn, chờ ~15–20 phút) Xem Console | Có dòng `[tooltip] đồng bộ (alarm):` | |

Chrome coi 15 phút là mức sàn, không phải lời hứa — máy đang bị tiết kiệm pin có thể chạy
trễ hơn. Đó là lý do UI sẽ nói "khoảng mỗi 15 phút" chứ không cam kết chính xác.

## 8. Ranh giới an toàn

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 8.1 | Network của service worker → xem request tới Supabase → tab **Headers** | Có header `apikey`. **Không** có header `Authorization` | |
| 8.2 | Mở `apps/extension/dist/unpacked/config.js` | Có key. File này nằm trong `dist/`, đã gitignore | |
| 8.3 | `git status --short` | Không có file nào chứa key chờ commit | |
| 8.4 | Console tab POS (`pos.v2.circa.vn`): `chrome.runtime.sendMessage("<EXT_ID>", { v:1, type:"SYNC_NOW" }, console.log)` | Bị từ chối (`FORBIDDEN_SENDER`) — chỉ Portal mới gọi được | |

## 9. Những gì batch này KHÔNG làm

- Không có tab Tool-tip, không có menu hướng dẫn, không chạy được guide. Cache đã có
  nhưng chưa ai đọc nó — đó là 3B và 3C.
- Không có nút **Đồng bộ** trong giao diện. Ở batch này trigger thủ công là message
  `SYNC_NOW`; nút sẽ nằm trong panel Tool-tip ở 3C.

## Kết luận

| Hạng mục | Đạt | Ghi chú |
|---|---|---|
| Chưa phát hành → `no-release`, không báo lỗi (mục 1) | | |
| Publish thật → tải và validate được (mục 2) | | |
| Revision không đổi → không tải payload (3.2) | | |
| Lệch checksum thì tải lại, không báo unchanged (3.3) | | |
| Có bản mới → cập nhật (mục 4) | | |
| **Offline không làm mất bản đang dùng (5.3)** | | |
| Sống qua restart Chrome và reload extension (6.2, 6.3) | | |
| Alarm 15 phút tồn tại và không nhân đôi (7.1, 7.2) | | |
| Chỉ dùng header `apikey` (8.1) | | |
| Key không lọt vào git (8.3) | | |
