# QA localhost — Batch 2B.2B (ghi hướng dẫn từ thao tác thật)

Batch này là lần đầu extension **làm được việc**: bấm "Bắt đầu ghi" trong Guide Editor,
extension mở tab POS/Admin, mọi cú click được ghi thành bước, dừng lại thì bước chảy
ngược về editor.

Vẫn **chưa có** trong batch này: tab Tool-tip trên POS/Admin, menu hướng dẫn cho nhân
viên, đồng bộ release 15 phút, chạy thử tour. Đó là Batch 3.

Một điều cần nắm trước khi test: **ghi xong không ghi vào database**. Bước nằm trong
editor y như vừa gõ tay, và chỉ vào Supabase khi bấm **Lưu thay đổi**.

## 0. Chuẩn bị

```bash
cd C:\QR_code\Circa-Tool-Tip
node apps/extension/build.mjs
```

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 0.1 | `chrome://extensions` → **Reload** extension Circa Tool-tip (dev) | Không lỗi đỏ. ID **không đổi**: `hgkjieodgaieajjijlbdecfkejaclndf` | |
| 0.2 | Xem lại **Permissions** | Vẫn chỉ `storage` + hai host POS/Admin. Mở tab dùng `chrome.tabs.create`, **không** cần quyền `tabs` | |
| 0.3 | `apps/admin/.env.local` đã có `NEXT_PUBLIC_EXTENSION_ID` | Có sẵn từ 2B.2A | |
| 0.4 | `pnpm --filter admin dev`, đăng nhập Portal | | |

> Nếu Portal đang chạy sẵn từ trước 2B.2A thì phải khởi động lại: `NEXT_PUBLIC_*` được
> nhúng lúc build client.

## 1. Nút "Bắt đầu ghi" xuất hiện đúng chỗ, và khoá đúng lúc

Mở một bộ hướng dẫn bất kỳ: `/guides` → bấm vào một bộ.

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 1.1 | Nhìn giữa khối "Thông tin bộ" và danh sách bước | Có thẻ **"Ghi hướng dẫn từ thao tác thật"** với nút **Bắt đầu ghi** | |
| 1.2 | Đọc dòng chữ cạnh nút | Nói rõ extension sẽ mở URL nào, ví dụ `https://pos.v2.circa.vn/trang-chu` | |
| 1.3 | Mở một bộ **chưa gán site** (từ `/guides/triage`) | Nút bị khoá, lý do: "Gán site cho bộ này trước khi ghi." | |
| 1.4 | Tắt extension ở `chrome://extensions` rồi tải lại trang editor | Nút bị khoá hoặc bấm vào báo không tìm thấy extension — **không** văng lỗi trắng trang | |
| 1.5 | Bật lại extension, F5 | Nút hoạt động trở lại | |

## 2. Ghi trên POS

Dùng một bộ POS đã gán site (`/guides` → lọc site POS).

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 2.1 | Bấm **Bắt đầu ghi** | Tab mới mở đúng `https://pos.v2.circa.vn/...`. Portal chuyển sang "Đang ghi · 0 bước" | |
| 2.2 | Nhìn tab POS vừa mở | Có thanh đen dưới đáy: "Đang ghi hướng dẫn · 0 bước" | |
| 2.3 | Rê chuột qua các nút trên header | Viền đỏ bám theo phần tử đang trỏ | |
| 2.4 | Rê chuột vào **chữ** bên trong một nút | Viền đỏ bao **cả nút**, không phải chỉ chữ | |
| 2.5 | Bấm vào **Cài Đặt** | Menu Cài Đặt vẫn mở ra bình thường; thanh đếm lên "1 bước"; Portal cũng lên 1 | |
| 2.6 | Bấm thêm 2–3 thao tác nữa | Đếm tăng đúng từng bước một, **không nhảy 2** | |

**2.6 là tiêu chí "không click lặp"**: mỗi cú bấm chỉ được tính một lần, và trang chỉ
được phản ứng một lần.

## 3. Điều hướng cứng không làm mất bước

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 3.1 | Trong tab POS đang ghi, bấm một link/nút **làm chuyển trang** | Trang chuyển bình thường | |
| 3.2 | Sau khi trang mới tải xong, nhìn thanh đếm | Thanh đen quay lại, số bước **đã bao gồm cú bấm vừa rồi** | |
| 3.3 | Nhìn Portal | Cùng số bước; dòng URL cạnh chip đổi sang đường dẫn mới | |

Bước được ghi vào `chrome.storage.session` **trước** khi cú click được cho phép chạy
thật, nên điều hướng không thể cắt mất nó.

## 4. Reload trang vẫn nối lại đúng recorder

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 4.1 | Trong tab POS đang ghi, nhấn **F5** | Sau khi tải xong, thanh đen hiện lại với đúng số bước cũ | |
| 4.2 | Bấm tiếp một thao tác | Đếm tăng tiếp từ số cũ, không reset về 1 | |

## 5. Service worker chết giữa chừng

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 5.1 | Để yên tab POS ~40 giây, không thao tác gì. `chrome://extensions` sẽ đổi dòng **service worker** thành **(không hoạt động)** | Worker đã bị Chrome thu hồi giữa lúc phiên ghi còn chạy | |
| 5.2 | Quay lại tab POS, bấm thêm một thao tác | Bước vẫn được ghi; đếm tăng | |
| 5.3 | Nhìn Portal | Nếu port đã đứt: chip đổi thành **"Mất kết nối — hỏi lại mỗi 2s"**, và số bước vẫn cập nhật (chậm hơn 2 giây) | |
| 5.4 | Bấm **Dừng ghi** ở Portal lúc đang mất kết nối | Vẫn dừng được: Portal mở port mới rồi mới gửi STOP | |

## 6. Hai recorder không dùng chung một tab

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 6.1 | Đang ghi bộ A. Mở tab Portal thứ hai, vào bộ B, bấm **Bắt đầu ghi** | Bộ B mở **tab POS mới của riêng nó**, không cướp tab của A | |
| 6.2 | Thao tác trên tab của A | Chỉ số bước của A tăng | |
| 6.3 | Thao tác trên tab của B | Chỉ số bước của B tăng | |
| 6.4 | Mở thêm một tab POS **thủ công** (không qua nút ghi) khi đang có phiên ghi | Tab đó **không** có thanh đen, click không bị chặn, không bước nào bị ghi thêm | |

6.4 là tiêu chí chống nhầm tab: extension chỉ nhận bước từ đúng tab của phiên ghi
(`TAB_MISMATCH`).

## 7. Dừng ghi và chèn bước — không tự động lưu

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 7.1 | Bấm **Hoàn tác bước cuối** | Số bước giảm 1 ở cả Portal lẫn thanh đen | |
| 7.2 | Bấm **Dừng ghi** | Portal hiện "Đã dừng · N bước ghi được" kèm danh sách text/selector. Thanh đen trên tab POS **biến mất**, click trên POS trở lại bình thường | |
| 7.3 | Kiểm tra Supabase (`/guides` ở tab khác, hoặc reload editor) | Bộ **chưa** có bước mới nào — chưa lưu gì cả | |
| 7.4 | Bấm **Chèn N bước vào cuối bộ** | Các bước cũ **còn nguyên, đúng thứ tự**; N bước mới nằm sau cùng; xuất hiện chip "Có thay đổi chưa lưu" | |
| 7.5 | Mở một bước mới ra xem | Có `selectors`, `matchText`, `tag`, `urlPattern`. `title`/`content` để trống cho người duyệt viết | |
| 7.6 | **Chưa lưu**, bấm F5 | Bước mới biến mất — đúng, vì chưa lưu | |
| 7.7 | Ghi lại, chèn lại, rồi bấm **Lưu thay đổi** | Lưu thành công, reload vẫn còn | |

## 8. Chất lượng selector (quan trọng nhất)

Mở vài bước vừa ghi trên POS và đọc ô **Selector**.

| # | Kiểm tra | Kỳ vọng | Kết quả |
|---|---|---|---|
| 8.1 | Có selector nào là `#basic-button` đứng **đầu** danh sách không? | **Không.** POS có 9 element trùng ID này; nó chỉ được phép nằm ở vị trí dự phòng | |
| 8.2 | Có class dạng `css-jj9uz9` trong selector không? | **Không** — class MUI sinh động bị loại trước khi ghi | |
| 8.3 | `matchText` của bước bấm "Cài Đặt" | Đúng chuỗi `Cài Đặt` | |
| 8.4 | Action của bước **làm chuyển trang** | `click_wait_url`, `expectedUrl` = URL của bước kế | |
| 8.5 | Action của bước **không chuyển trang** | `click_next` | |
| 8.6 | Có bước nào là `auto_click_*` không? | **Không.** Recorder không bao giờ sinh auto-click | |

## 9. Ghi trên Admin, và bước xuyên site

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 9.1 | Mở một bộ đã gán site **Admin**, bấm **Bắt đầu ghi** | Tab mở `https://admin.v2.circa.vn/...` | |
| 9.2 | Ghi 2–3 thao tác, dừng, chèn | Như POS | |
| 9.3 | Xem `siteOverride` của các bước Admin trong bộ Admin | **Trống** — bước trên chính site của bộ thì kế thừa, không ghi thừa | |
| 9.4 | (Nếu có luồng nhảy POS → Admin) Ghi một bước POS rồi đi sang Admin trong cùng phiên | Bước Admin có `siteOverride = admin`; bước POS trước đó có `expectedSiteOverride = admin` | |

## 10. Ranh giới an toàn

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 10.1 | Console tab Portal: `chrome.runtime.connect("hgkjieodgaieajjijlbdecfkejaclndf",{name:"tg-recorder"})` rồi gửi START với `startUrl: "https://evil.example/"` | `ok:false`, `error.code = "BAD_URL"`. **Không** có tab nào mở ra | |
| 10.2 | Gửi START với `startUrl: "https://pos.v2.circa.vn.evil.example/"` | Cũng `BAD_URL` | |
| 10.3 | Trong tab POS đang ghi, mở một trang **ngoài** POS/Admin (vd `google.com`) trong tab đó | Không có thanh đen, không ghi gì | |
| 10.4 | Đóng tab POS đang ghi | Portal chuyển sang "Đã dừng", giữ nguyên các bước đã ghi | |

## 11. Giới hạn đã biết của batch này

Không phải bug, ghi ra để khỏi mất công truy:

- **`<select>` gốc và `<input type="file">`**: hai loại này được ghi nhưng click **không**
  bị chặn-rồi-phát-lại, vì dropdown gốc không mở lại được bằng script và hộp thoại chọn
  file bị trình duyệt từ chối khi user-gesture đã hết. Chúng không điều hướng nên không
  mất bước.
- **`urlPattern` chỉ lấy đường dẫn, bỏ query.** Audit đã tìm thấy số điện thoại thật nằm
  trong query của POS; recorder mà chép query vào guide sẽ đưa PII đó trở lại một release
  công khai. Ai cần pattern hẹp hơn thì tự thêm query trong editor.
- **Portal reload giữa lúc ghi** làm mất id phiên trong bộ nhớ trang: phiên ghi vẫn chạy
  trong extension, nhưng Portal không còn theo dõi được. Đóng tab POS để dừng nó.
- Chưa có gì hiển thị cho **nhân viên** trên POS/Admin. Đó là Batch 3.

## Kết luận

| Hạng mục | Đạt | Ghi chú |
|---|---|---|
| Mở tab và gắn recorder đúng tab | | |
| Điều hướng cứng không mất bước (mục 3) | | |
| Không click lặp (mục 2.6) | | |
| Reload trang nối lại đúng recorder (mục 4) | | |
| Service-worker restart không mất bước (mục 5) | | |
| Hai recorder không chung tab (mục 6) | | |
| Dừng ghi không tự lưu database (mục 7.3) | | |
| Append giữ nguyên bước cũ (mục 7.4) | | |
| Chất lượng selector (mục 8) | | |
| Ranh giới BAD_URL (mục 10) | | |
