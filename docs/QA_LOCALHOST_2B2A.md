# QA localhost — Batch 2B.2A (nền tảng extension MV3)

Batch này **chưa có gì để nhìn trên POS/Admin**: chưa có tab Tool-tip, chưa có menu
hướng dẫn, chưa chọn được element, chưa đồng bộ. Nó chỉ dựng đường ống: extension nạp
được, Portal bắt tay được, và state phiên ghi sống sót qua service-worker restart.

Mục đích của vòng QA này là lấy **Extension ID** và xác nhận đường ống thông.

## 1. Build và nạp extension

```bash
cd C:\QR_code\Circa-Tool-Tip
node apps/extension/build.mjs
```

Thư mục để "Load unpacked":

```
C:\QR_code\Circa-Tool-Tip\apps\extension\dist\unpacked
```

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 1.1 | `chrome://extensions` → bật **Developer mode** | | |
| 1.2 | **Load unpacked** → chọn thư mục trên | Hiện **Circa Tool-tip (dev)** phiên bản 0.1.0, không có lỗi đỏ | |
| 1.3 | Xem mục **Permissions** của extension | Chỉ `storage` + hai host `pos.v2.circa.vn` và `admin.v2.circa.vn`. **Không** có `tabs`, không có "all sites" | |
| 1.4 | Copy **ID** của extension | Ghi lại: `________________________________` | |
| 1.5 | Bấm **service worker** để mở DevTools của nó | Console không có lỗi đỏ | |

## 2. Content script nhận đúng tab

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 2.1 | Mở `https://pos.v2.circa.vn`, F12 → Console | Không có lỗi đỏ từ extension | |
| 2.2 | Console → bật **Verbose**, F5 | Không bắt buộc thấy log, nhưng **không** được thấy cảnh báo `không lấy được tabId` | |
| 2.3 | Mở `https://admin.v2.circa.vn`, F5 | Như trên | |
| 2.4 | Mở một trang bất kỳ ngoài hai domain đó (vd `google.com`) | Extension **không** chạy ở đó (content script chỉ khai báo cho hai host) | |

## 3. Portal bắt tay được với extension

Thêm ID vừa copy vào `apps/admin/.env.local`:

```dotenv
NEXT_PUBLIC_EXTENSION_ID=<ID ở bước 1.4>
```

Khởi động lại Portal:

```bash
pnpm --filter admin dev
```

Batch 2B.2A **chưa có nút bấm** cho việc này trong giao diện Portal — nút "Bắt đầu ghi"
thuộc 2B.2B. Kiểm tra bằng Console của trang Portal (`http://localhost:3000`, sau khi
đăng nhập):

```js
chrome.runtime.sendMessage("<EXTENSION_ID>", { v: 1, type: "HELLO" }, console.log)
```

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 3.1 | Chạy lệnh trên trong Console của `localhost:3000` | `{v:1, ok:true, type:"HELLO", data:{extVersion:"0.1.0", protocolVersion:1, schemaVersion:5, capabilities:["record"]}}` | |
| 3.2 | Gửi sai phiên bản: đổi `v: 1` thành `v: 2` | `ok:false`, `error.code = "VERSION_MISMATCH"` | |
| 3.3 | Gửi type lạ: `{v:1, type:"NUKE"}` | `ok:false`, `error.code = "UNKNOWN_TYPE"` | |
| 3.4 | Hỏi phiên ghi không tồn tại: `{v:1, type:"GET_RECORDING", payload:{sessionId:"x"}}` | `ok:false`, `error.code = "NO_SESSION"` | |

`schemaVersion: 5` ở 3.1 là bằng chứng extension đang dùng đúng `packages/guide-schema`,
không phải một bản sao riêng.

## 4. Origin lạ không gọi được extension

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 4.1 | Mở `https://pos.v2.circa.vn`, Console chạy `chrome.runtime.sendMessage("<ID>", {v:1,type:"HELLO"}, console.log)` | Không nhận được phản hồi hợp lệ — `chrome.runtime` không khả dụng cho trang này, hoặc trả lỗi | |
| 4.2 | Làm tương tự trên một trang ngoài (vd `https://example.com`) | Như trên | |

Bản dev chỉ khai báo `http://localhost/*`, nên chỉ Portal ở localhost gọi được.

## 5. State phiên ghi sống qua service-worker restart

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 5.1 | Ở Console của Portal, mở port và bắt đầu một phiên giả:<br>`const p = chrome.runtime.connect("<ID>", {name:"tg-recorder"}); p.onMessage.addListener(console.log); p.postMessage({v:1,type:"START",payload:{session:{id:"qa1",guideId:"g-qa",site:"pos",startUrl:"/trang-chu"}}})` | Nhận `{ok:true, type:"READY", data:{session:{id:"qa1", status:"recording", steps:[]}}}` | |
| 5.2 | `chrome://extensions` → bấm **service worker** → trong DevTools của nó bấm **Stop**, hoặc đợi nó tự ngủ | Service worker dừng | |
| 5.3 | Về Console Portal chạy:<br>`chrome.runtime.sendMessage("<ID>", {v:1,type:"GET_RECORDING",payload:{sessionId:"qa1"}}, console.log)` | Vẫn `ok:true` và trả đúng phiên `qa1` — **state không nằm trong service worker** | |
| 5.4 | Dọn: `chrome.runtime.sendMessage("<ID>", {v:1,type:"HELLO"}, console.log)` rồi đóng Chrome | Phiên giả biến mất khi đóng trình duyệt (storage.session) | |

Bước 5.3 là điểm quan trọng nhất của batch này.

## 6. Gửi lại

- **Extension ID** (cần cho 2B.2B).
- Screenshot trang `chrome://extensions` cho thấy permissions.
- Kết quả JSON của 3.1 và 5.3.
- Cột Kết quả đã điền.

## Giới hạn còn lại của 2B.2A

- Chưa chọn được element trên trang (2B.2B).
- Chưa có `PROBE_SELECTOR` và `PREVIEW_GUIDE` (2B.2C).
- Chưa có tab Tool-tip, menu hướng dẫn, đồng bộ 15 phút (Batch 3).
- `externally_connectable` mới chỉ có localhost; origin production chốt khi build release.
- Content script chưa làm gì ngoài bắt tay lấy `tabId`.

Không đụng Supabase trong batch này: database vẫn **48 guide / 409 step / 0 release**.
