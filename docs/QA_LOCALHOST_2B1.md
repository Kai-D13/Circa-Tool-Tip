# QA localhost — Batch 2B.1 (Guide Editor)

Tiền đề: Batch 2A đã pass — 48 guide / 409 step / 0 unassigned / POS 13 + Admin 35 /
0 release. Checklist này **không** publish gì và **không** đụng release.

```bash
cd C:\QR_code\Circa-Tool-Tip
pnpm --filter admin dev
```

`apps/admin/.env.local` đã có sẵn. Đăng nhập bằng `hoangvudn96@gmail.com`.

> **Nguyên tắc xuyên suốt:** chỉ sửa trên **một bộ thử** do bạn chọn. Không sửa hàng loạt,
> không đổi trạng thái sang `published`, không xoá bộ production.

## 1. Mở và đóng — không được đổi gì

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 1.1 | `/guides` → bấm tên một bộ bất kỳ | Vào `/guides/<id>`, hiện metadata + đủ số bước đúng như cột "Bước" ở danh sách | |
| 1.2 | Xem một bộ nhiều bước (vd `TẠO VOUCHER QUÀ TẶNG GIẢM GIÁ`, 25 bước) | Thứ tự bước đúng 1→25; mở rộng một bước thấy đủ selector/matchText/urlPattern/action | |
| 1.3 | Không sửa gì, bấm nút lưu | Nút hiện **"Đã lưu"** và **bị khoá** — không có gì để lưu | |
| 1.4 | Quay lại `/guides` | Tổng vẫn **48 / 409**, không bộ nào đổi trạng thái | |

## 2. Sửa và lưu một bộ thử

Chọn **một** bộ, ghi lại tên: ______________________

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 2.1 | Sửa **Ghi chú** thành `QA 2B.1` | Chip "Có thay đổi chưa lưu" xuất hiện | |
| 2.2 | Bấm **Lưu thay đổi** | Chip "Đã lưu"; không có lỗi đỏ | |
| 2.3 | F5 trang | Ghi chú vẫn là `QA 2B.1` | |
| 2.4 | Sửa tiêu đề bước 1, lưu, F5 | Tiêu đề mới còn nguyên; **số bước không đổi** | |
| 2.5 | Đổi thứ tự: bấm ↓ ở bước 1, lưu, F5 | Bước 1 và 2 đã hoán đổi và **giữ nguyên sau F5** | |
| 2.6 | Bấm ↑ để trả lại thứ tự cũ, lưu | Về đúng thứ tự ban đầu | |
| 2.7 | `/guides` | Vẫn **48 / 409** | |

## 3. Validation — cảnh báo cho lưu, lỗi thì không

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 3.1 | Xoá trắng **Tiêu đề** của một bước | Bước đó hiện cảnh báo vàng "thiếu tiêu đề"; **vẫn lưu được** | |
| 3.2 | Trả lại tiêu đề | Cảnh báo biến mất | |
| 3.3 | Đổi action của một bước sang `auto_click_next` rồi xoá trắng ô selector | Bước đó hiện **lỗi đỏ** "action TỰ click nhưng chưa chọn phần tử" | |
| 3.4 | Khi đang có lỗi đỏ, nhìn nút **Đánh dấu published** | Nút **bị khoá**, dưới có dòng giải thích còn N lỗi validate | |
| 3.5 | Bấm **Lưu thay đổi** khi đang có lỗi | **Vẫn lưu được** (lỗi không chặn lưu, chỉ chặn publish) | |
| 3.6 | Hoàn tác: trả action và selector về như cũ, lưu | Hết lỗi; nút published mở lại (nhưng **đừng bấm**) | |

## 4. Xung đột hai tab — `40001`

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 4.1 | Mở **cùng một bộ** ở hai tab A và B | Cả hai hiện cùng nội dung | |
| 4.2 | Ở tab A: sửa ghi chú thành `A`, bấm lưu | Lưu thành công | |
| 4.3 | Ở tab B (chưa F5): sửa ghi chú thành `B`, bấm lưu | Hiện banner đỏ **"Bộ này đã bị sửa ở nơi khác"** kèm nút **Tải lại**. Không có thông báo "Đã lưu" | |
| 4.4 | Ở tab B bấm **Tải lại** | Thấy ghi chú `A` của tab A — thay đổi của A **không bị mất** | |
| 4.5 | Kiểm tra lại `/guides` | Vẫn 48 / 409 | |

Đây là điểm quan trọng nhất của batch này: dữ liệu của người lưu trước **không được** bị
người lưu sau ghi đè.

## 5. Tạo bộ mới và xoá đi

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 5.1 | `/guides` → **+ Tạo bộ mới** | Form tên/site/nhóm/URL bắt đầu | |
| 5.2 | Tên `ZZ TEST 2B1`, site POS, URL `/trang-chu` → **Tạo và sửa bước** | Chuyển sang `/guides/<id mới>`, 0 bước | |
| 5.3 | **+ Thêm bước cuối**, điền tiêu đề + selector `button.test` + urlPattern `/trang-chu`, lưu | Lưu thành công, 1 bước | |
| 5.4 | `/guides` | Tổng là **49** guide (48 production + 1 test); step 409 + 1 | |
| 5.5 | Mở lại bộ test → **Xoá bộ** → xác nhận | Về `/guides`, tổng trở lại **48 / 409** | |

Bước 5.5 bắt buộc: kết thúc QA phải trở lại đúng 48 guide / 409 step.

## 6. Chốt lại trạng thái

Sau khi xong, kiểm tra ở `/guides`:

- Tổng **48**, step **409**
- Chưa phân loại **0**, draft **48**, published **0**, archived **0**
- POS 13 + Admin 35

Nếu bộ thử ở mục 2 còn ghi chú `QA 2B.1` thì xoá ghi chú đó đi rồi lưu, để dữ liệu về
nguyên trạng.

## 7. Gửi lại

- Screenshot: màn editor một bộ nhiều bước, banner xung đột ở 4.3, và `/guides` cuối cùng.
- Kết quả từng dòng ở cột Kết quả.
- Bất kỳ thông báo lỗi đỏ nào ngoài dự kiến (chụp nguyên văn).

**Không** bấm published, **không** publish release, **không** chạy migration.
