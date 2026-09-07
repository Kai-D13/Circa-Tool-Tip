# QA localhost — Batch 2B.2C (kiểm tra selector và chạy thử)

Hai công cụ chạy trên trang thật, và cả hai **không ghi gì cả**:

- **Kiểm tra selector** — nút trong từng bước. Mở trang của bước đó, đếm số element mỗi
  selector khớp, tô sáng cái mà runtime sẽ chọn.
- **Chạy thử** — đi qua từng bước của bản **đang sửa trên màn hình**, kể cả thay đổi chưa
  lưu. Bản nháp đi kèm trong message, không đọc lại từ database, không đụng release nào.

Vẫn **chưa có** trong batch này: tab Tool-tip trên POS/Admin, menu hướng dẫn cho nhân
viên, đồng bộ 15 phút. Đó là Batch 3.

## 0. Chuẩn bị

```bash
cd C:\QR_code\Circa-Tool-Tip
node apps/extension/build.mjs
pnpm --filter admin dev
```

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 0.1 | `chrome://extensions` → **Reload** extension | Không lỗi đỏ. ID không đổi: `hgkjieodgaieajjijlbdecfkejaclndf` | |
| 0.2 | Xem **Permissions** | Vẫn chỉ `storage` + hai host POS/Admin. Batch này thêm `chrome.tabs.remove` (đóng tab probe cũ) — vẫn **không** cần quyền `tabs` | |
| 0.3 | Mở service worker → Console | Không lỗi đỏ | |
| 0.4 | Console tab Portal: `chrome.runtime.sendMessage("hgkjieodgaieajjijlbdecfkejaclndf",{v:1,type:"HELLO"},console.log)` | `capabilities` có đủ ba: `["record","probe","preview"]` | |

## 1. Ghi hướng dẫn vẫn nguyên vẹn (regression 2B.2B)

Phần transport của Portal đã được gom vào một chỗ dùng chung cho ghi/probe/chạy thử, nên
phải chạy lại ba mục cốt lõi của 2B.2B trước.

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 1.1 | Ghi 3 bước trên POS | Đếm tăng đúng từng bước ở cả Portal lẫn thanh đen | |
| 1.2 | **Hoàn tác bước cuối** | Cả Portal lẫn thanh đen xuống 2 **ngay** | |
| 1.3 | **Dừng ghi** → **Chèn vào cuối bộ** | Bước cũ nguyên vẹn, bước mới nối sau, chưa lưu database | |
| 1.4 | Để worker ngủ ~40s giữa lúc ghi rồi bấm tiếp | Bước vẫn ghi được; chip đổi "Mất kết nối — hỏi lại mỗi 2s" rồi vẫn Dừng được | |

## 2. Kiểm tra selector — trường hợp tốt

Mở một bộ POS đã gán site, mở rộng một bước có selector thật.

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 2.1 | Nhìn trong khối bước, dưới ô Selector | Có nút **Kiểm tra selector trên trang** | |
| 2.2 | Bấm nút | Tab mới mở đúng **trang của bước đó** (không phải startUrl của bộ, trừ khi bước dùng URL động) | |
| 2.3 | Nhìn trang vừa mở | Element được tô sáng **viền xanh**, có thẻ trắng liệt kê từng selector kèm số element | |
| 2.4 | Quay lại Portal | Bước hiện chip xanh, ví dụ "Khớp đúng 1 element" hoặc "Khớp 9, text lọc còn 1" | |
| 2.5 | Đóng khối bước lại | Chip kết quả vẫn hiện ở dòng tiêu đề bước | |
| 2.6 | Danh sách selector dưới nút | Dòng nào đang được dùng có chữ **← đang dùng** | |

**2.4 với "Khớp 9, text lọc còn 1"** là trường hợp `#basic-button` của POS: selector khớp
9 element, `matchText = "Cài Đặt"` lọc ra đúng 1. Đó là **đạt**, không phải lỗi.

## 3. Kiểm tra selector — trường hợp xấu

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 3.1 | Sửa selector của một bước thành `#khong-ton-tai-dau-ca`, **không lưu**, bấm kiểm tra | Chip đỏ "Không tìm được". Thẻ trên trang nói "Không selector nào tìm thấy element" | |
| 3.2 | Sửa selector thành `button:has(` (sai cú pháp) | Báo **sai cú pháp**, không phải "0 element" | |
| 3.3 | Xoá hết `matchText` của một bước có selector khớp nhiều element | Chip đỏ, lý do nói selector khớp nhiều element và không có text để lọc | |
| 3.4 | Đổi `matchText` thành chữ không có trên trang, giữ selector khớp đúng 1 | Chip đỏ, lý do nói **text trên trang đã khác** — không được báo đạt | |
| 3.4b | **Vẫn ở bước đó**, bấm **Chạy thử** | Element được tô **viền đỏ** (để chẩn đoán), thẻ ghi "TEXT trên trang đã khác". **Tuyệt đối không** tô xanh | |
| 3.4c | Bấm **Tiếp** ở bước hỏng đó | Vẫn đi tiếp được — một bước hỏng không làm kẹt cả bộ | |
| 3.5 | Xoá hết selector của một bước | Nút bị khoá, lý do "Bước này chưa có selector nào để kiểm tra." | |
| 3.6 | Kiểm tra bước thứ hai ngay sau bước thứ nhất | Tab cũ **đóng lại**, chỉ còn một tab kiểm tra | |
| 3.7 | Bấm kiểm tra selector rồi **đóng tab kiểm tra** trước khi nó kịp hiện kết quả | Nút thoát khỏi "Đang kiểm tra…", Portal báo tab bị đóng | |

3.1–3.4 dùng bước **chưa lưu** — đó là điểm chính: kiểm tra được trước khi lưu.

## 4. Kiểm tra selector cho bước xuyên site

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 4.1 | Trong một bộ POS, đặt một bước có **Site riêng = Admin** và urlPattern của Admin, rồi kiểm tra | Tab mở trên `admin.v2.circa.vn`, **không** phải POS | |

## 5. Chạy thử

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 5.1 | Trong editor, tìm thẻ **"Chạy thử bộ này trên trang thật"** | Có nút **Chạy thử** và dòng nói sẽ mở URL nào | |
| 5.2 | Bấm **Chạy thử** | Tab mở trang của bước 1; trên trang có thẻ trắng: tiêu đề bước, nội dung, "Bước 1/N", ba nút Trước / Tiếp / Thoát | |
| 5.3 | Nhìn phần tử của bước 1 | Được tô sáng viền xanh và cuộn vào giữa màn hình | |
| 5.4 | Nút **Trước** ở bước 1 | Bị khoá | |
| 5.5 | Bấm **Tiếp** | Sang bước 2; Portal cũng hiện "Bước 2/N" | |
| 5.6 | Bấm **Tiếp** tới bước ở trang khác | Trình duyệt tự chuyển trang, sau khi tải xong vẫn **đúng bước đó**, không quay về bước 1 | |
| 5.7 | Ở bước cuối, nút chính ghi **Kết thúc** | Bấm vào thì thẻ biến mất, Portal quay về trạng thái chưa chạy | |
| 5.8 | Chạy lại rồi bấm **Thoát** giữa chừng | Thẻ biến mất ngay, trang trở lại bình thường | |
| 5.9 | Chạy lại rồi bấm **Dừng chạy thử** ở Portal | Thẻ trên trang biến mất | |
| 5.10 | Chạy lại rồi **đóng tab** đang chạy thử | Portal quay về trạng thái chưa chạy **ngay**, nút **Chạy thử** dùng lại được. Không được kẹt ở "Đang chạy thử" | |

## 6. Chạy thử dùng đúng bản đang sửa, và không lưu gì

Đây là tiêu chí quan trọng nhất của batch.

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 6.1 | Sửa **tiêu đề** một bước thành "TEST CHUA LUU", **không bấm Lưu**, rồi **Chạy thử** | Thẻ trên trang hiện đúng "TEST CHUA LUU" | |
| 6.2 | Trong lúc đang chạy thử, mở `/guides` ở tab khác | Bộ **không** có thay đổi nào; số bước và nội dung vẫn như trước khi sửa | |
| 6.3 | Thoát chạy thử, F5 trang editor | "TEST CHUA LUU" biến mất — đúng, vì chưa lưu | |
| 6.4 | Kiểm tra Supabase: bảng `releases` | **Không** có bản ghi mới nào từ lúc bắt đầu QA | |
| 6.5 | Thêm một bước mới (chưa lưu) rồi Chạy thử | Bước mới có trong luồng chạy thử | |

## 7. Bước tự-bấm không được bấm hộ (rủi ro R1)

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 7.1 | Mở một bộ import từ v4 có bước `auto_click_next` hoặc `auto_click_wait_url`, Chạy thử tới bước đó | Phần tử được **tô sáng**, thẻ ghi rõ "Khi chạy thật bước này TỰ bấm. Bản chạy thử chỉ tô sáng, không bấm hộ." | |
| 7.2 | Nhìn trang | **Không** có gì bị bấm: không mở dialog, không tạo đơn, không đổi trang | |

360/409 bước legacy là auto-click. Bản chạy thử là chỗ cuối cùng người ta muốn một đơn
hàng thật được tạo ra.

## 8. Chạy thử khi trang đã đổi

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 8.1 | Sửa selector của bước 1 thành thứ không tồn tại, rồi Chạy thử | Thẻ vẫn hiện, ghi "Không tìm thấy phần tử trên trang này", **không** tô sáng bừa element khác | |
| 8.2 | Vẫn ở màn hình đó, bấm **Tiếp** | Vẫn đi tiếp được — bước hỏng không làm kẹt cả bộ | |
| 8.3 | Đặt urlPattern của bước 1 thành `/mot-trang-khac` rồi Chạy thử | Thẻ ghi "Bước này ở trang https://…/mot-trang-khac" kèm nút **Đi tới trang của bước** | |
| 8.4 | Bấm nút đó | Chuyển đúng trang, rồi hiện bước bình thường | |

## 9. Ranh giới an toàn

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 9.1 | Console tab Portal: mở port rồi gửi `PROBE_SELECTOR` với `url: "https://evil.example/"` | `ok:false`, `error.code = "BAD_URL"`, không tab nào mở | |
| 9.2 | Gửi `PROBE_SELECTOR` không kèm `step` | `ok:false`, `error.code = "BAD_STEP"` | |
| 9.3 | Gửi `PREVIEW_GUIDE` với `guide.steps: []` | `ok:false`, `error.code = "BAD_STEP"` | |
| 9.4 | Vừa ghi hướng dẫn bộ A, vừa chạy thử bộ B, vừa kiểm tra selector bộ C | Ba tab riêng, không tab nào giành việc của tab kia | |
| 9.5 | Trong tab đang chạy thử, click bừa vào trang | **Không** có bước nào được ghi — chạy thử không phải là ghi | |

## 10. Giới hạn đã biết

- **Chạy thử không tự bấm và không tự chờ URL.** Nó tô sáng bước và để người xem tự bấm
  **Tiếp**. Runtime thật (Batch 3) mới có auto-click và chờ điều hướng.
- **Portal reload giữa lúc chạy thử** làm mất id phiên trong bộ nhớ trang; phiên vẫn chạy
  trong extension. Bấm **Thoát** trên chính trang đó để dừng.
- **Mỗi lần kiểm tra selector mở một tab mới** và đóng tab kiểm tra trước đó. Cố ý: gán
  lại URL cho tab cũ không đảm bảo trang tải lại, và câu trả lời khi đó có thể đến từ
  trang cũ.

## Kết luận

| Hạng mục | Đạt | Ghi chú |
|---|---|---|
| Ghi hướng dẫn không hồi quy (mục 1) | | |
| Probe đếm đúng và tô sáng đúng element (mục 2) | | |
| Probe phân biệt được sai cú pháp / không thấy / text lệch (mục 3) | | |
| Probe mở đúng site của bước xuyên site (mục 4) | | |
| Chạy thử đi hết bộ, qua được điều hướng (mục 5) | | |
| Chạy thử dùng bản chưa lưu và không ghi database (mục 6) | | |
| Không auto-click khi chạy thử (mục 7) | | |
| Text lệch: probe đỏ VÀ chạy thử không tô xanh (mục 3.4–3.4b) | | |
| Đóng tab chạy thử / tab probe không kẹt trạng thái (5.10, 3.7) | | |
| HELLO khai đủ ba capability (mục 0.4) | | |
| BAD_URL / BAD_STEP (mục 9) | | |
