# QA localhost — Batch 2A (Admin Portal: login · import · triage)

Người thực hiện: stakeholder, trên máy QA. Dev-team không có credential Supabase nên
không tự chạy được phần này; mọi bước dưới đây là thao tác thật trên project
`yoqzsvcbsornqjcatdvy`.

## 0. Chuẩn bị (một lần)

```bash
cd Circa-Tool-Tip
pnpm install
cp apps/admin/.env.example apps/admin/.env.local
```

Điền vào `apps/admin/.env.local` (không commit):

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://yoqzsvcbsornqjcatdvy.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Lấy publishable key ở Supabase Dashboard → Project Settings → API Keys. **Không** dùng
secret key / service-role ở bất kỳ đâu trong Portal.

Chạy:

```bash
pnpm --filter admin dev
```

Mở `http://localhost:3000`.

## 1. Auth

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 1.1 | Mở `/guides` khi chưa đăng nhập | Bị đưa về `/login` | |
| 1.2 | Đăng nhập `hoangvudn96@gmail.com` | Vào `/guides`, header hiện email | |
| 1.3 | F5 trang `/guides` | Vẫn đăng nhập, không văng về login | |
| 1.4 | Mở `/login` khi đã đăng nhập | Bị đưa về `/guides` | |
| 1.5 | Bấm **Đăng xuất** | Về `/login`; mở lại `/guides` bị chặn | |
| 1.6 | (tuỳ chọn) Tài khoản không có trong `admin_allowlist` | Thấy trang **Không có quyền**, có nút Đăng xuất | |

## 2. Import

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 2.1 | `/guides` khi DB trống | Bảng tổng = 0, link "Import 48 bộ legacy" | |
| 2.2 | `/guides/import` → chọn `data/legacy-import.v5.json` → **Kiểm tra file** | Bảng kết quả: `circa-tooltip-legacy-import`, schemaVersion 5, **48 / 409**, hai dòng checksum **giống nhau**, alert xanh "File hợp lệ" | |
| 2.3 | Bấm **Import 48 bộ hướng dẫn** | Hộp xác nhận nêu **48 guide / 409 step** | |
| 2.4 | **Đồng ý, import** | Kết quả: `inserted 48 · updated 0 · skippedBecauseTriaged 0 · unassignedRemaining 48` | |
| 2.5 | `/guides` | Tổng 48, Chưa phân loại 48, bảng liệt kê 48 bộ | |
| 2.6 | Sửa tay 1 ký tự trong bản copy của artifact rồi Kiểm tra file | Alert đỏ "Checksum tính lại KHÁC checksum trong file", nút Import bị khoá | |

Ghi lại nguyên văn JSON kết quả RPC ở 2.4.

## 3. Triage

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 3.1 | `/guides/triage` | Counter **Đã phân loại 0/48**; 4 bộ "không gợi ý được" nằm đầu: IN TEM SẢN PHẨM, THAO TÁC IN TEM GIÁ, XUẤT BÁO CÁO BÁN HÀNG, TẠO PHẢN HỒI TICKET | |
| 3.2 | Chọn **một trong bốn bộ "không gợi ý được"** (sau khi bạn đã xác định site thật của nó), chọn POS/Admin, nhập nhóm, **Xác nhận phân loại** | Counter **1/48** ngay, không reload; thẻ **rời khỏi** hàng chờ "Chưa phân loại" (bộ lọc mặc định). Chuyển bộ lọc sang POS/Admin/Tất cả thì thấy thẻ đã gán, nút ghi "Đã phân loại" | |
| 3.3 | Bộ lọc "Hiển thị: POS" | Chỉ thấy bộ vừa gán (nếu chọn POS) | |
| 3.4 | Tìm "voucher" | Chỉ các bộ có chữ voucher (không phân biệt dấu) | |
| 3.5 | **Áp dụng gợi ý độ tin cao (39)** | Hiện bảng 39 bộ + site sẽ gán **trước** khi xác nhận; huỷ được. Số 39 chỉ đúng nếu 3.2 đã gán một bộ *không rõ* — gán nhầm một bộ độ tin cao thì ở đây chỉ còn 38 | |
| 3.6 | (chưa làm ở bước này) Xác nhận gán hàng loạt | Chỉ làm sau khi audit 3.1–3.5. Khi làm: có tiến độ **Đã xử lý x/39**; nếu một bộ lỗi, hộp kết quả **không đóng**, nêu rõ đã gán bao nhiêu / bộ nào lỗi / còn bao nhiêu, và có nút **Thử lại N bộ còn lại** chỉ chạy lại bộ còn chưa phân loại | |

## 4. Import lại không ghi đè

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 4.1 | Sau 3.2, quay lại `/guides/import`, import lại cùng file | `inserted 0 · updated 47 · skippedBecauseTriaged 1 · unassignedRemaining 47` | |
| 4.2 | `/guides` | Bộ đã gán ở 3.2 vẫn giữ site/nhóm | |

## 5. Gửi lại cho audit

- Screenshot: login, kết quả Kiểm tra file, kết quả import, màn triage sau 3.2.
- JSON kết quả RPC của 2.4 và 4.1.
- Bảng trên với cột Kết quả đã điền.

**Chưa** xác nhận gán hàng loạt (3.6) và **chưa** publish gì cho tới khi audit xong.
