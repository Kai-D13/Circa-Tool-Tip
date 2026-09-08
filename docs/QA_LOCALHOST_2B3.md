# QA localhost — Batch 2B.3 (trang Phát hành)

Batch này thêm trang `/releases` để Admin publish và rollback theo từng site, và đổi lại
toàn bộ nhãn trạng thái guide.

> **Vòng QA này KHÔNG publish thật.** Đi tới tận hộp xác nhận rồi bấm **Huỷ**. Kiểm tra
> cuối cùng là `select count(*) from public.releases` vẫn phải bằng `0`.

Đường rollback và màn hình sau-publish chỉ được phủ bằng unit test trong batch này — vì
kiểm chúng bằng tay đòi hỏi tạo release thật. Chúng sẽ được QA ở Batch 3 khi extension đã
đồng bộ được.

## 0. Chuẩn bị

```bash
cd C:\QR_code\Circa-Tool-Tip
pnpm --filter admin dev
```

Không cần build lại extension. Không chạy SQL nào.

## 1. Nhãn trạng thái không còn chữ tiếng Anh

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 1.1 | Mở `/guides`, nhìn cột **Trạng thái** | Toàn tiếng Việt. **Không** còn chip nào ghi `draft` / `published` / `archived` / `unassigned` | |
| 1.2 | Nhìn màu chip của một bộ đã duyệt | **Vàng/cam**, không phải xanh lá. Xanh lá từ nay chỉ dành cho bản đang chạy trên extension | |
| 1.3 | Nhìn dãy ô đếm phía trên bảng | `Tổng` · `Chưa phân loại` · `Bản nháp` · `Đã duyệt cho lần phát hành tiếp theo` · `Đã lưu trữ` | |
| 1.4 | Mở một bộ, nhìn dòng `Trạng thái:` ở khối cuối | Hiện nhãn tiếng Việt, không phải mã enum | |
| 1.5 | Nhìn ba nút đổi trạng thái | `Chuyển về bản nháp` · `Duyệt cho lần phát hành tiếp theo` · `Lưu trữ` | |
| 1.6 | Mở `/guides/triage`, xem dropdown lọc | Vẫn có mục `Chưa phân loại` như cũ | |

## 2. Hộp xác nhận khi duyệt bộ có bước tự bấm

24/48 bộ mang cờ `GUIDE_HAS_AUTO_CLICK_UNANCHORED`. Tìm một bộ như vậy: mở `/guides`,
vào một bộ, mở rộng một bước và xem có chip flag không — hoặc dùng
`docs/IMPORT_REPORT.md` mục auto-click.

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 2.1 | Mở một bộ **có** cờ auto-click, bấm **Duyệt cho lần phát hành tiếp theo** | Hiện thẻ xác nhận nói rõ có bao nhiêu bước tự bấm và hậu quả nếu resolve sai | |
| 2.2 | Bấm **Huỷ** | Trạng thái **không** đổi | |
| 2.3 | Bấm lại, chọn **Vẫn duyệt** | Trạng thái đổi sang đã duyệt | |
| 2.4 | Mở một bộ **không** có cờ auto-click, bấm duyệt | Đổi ngay, **không** hỏi lại | |
| 2.5 | Với bộ có cờ, bấm **Lưu trữ** | Đổi ngay, không hỏi — hộp thoại chỉ dành cho đường duyệt phát hành | |
| 2.6 | Bộ có cảnh báo thường (vd thiếu tiêu đề) nhưng không có cờ auto-click | **Không** hỏi lại. Hỏi ở mọi cảnh báo thì hộp thoại bật gần như luôn và không ai đọc nữa | |

**Sau mục 2, trả mọi bộ vừa đổi về `Bản nháp`** trước khi sang mục 3, để mục 3.2 kiểm được
trạng thái rỗng.

## 3. Trang Phát hành — trạng thái rỗng

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 3.1 | Nhìn thanh menu trên cùng | Có tab **Phát hành** sau `Phân loại` | |
| 3.2 | Mở `/releases` | Hai khối riêng: POS và Admin, mỗi khối một thẻ | |
| 3.3 | Nhìn mỗi khối | `Chưa có bản phát hành · Revision: 0`, và **không** có chip "Đang chạy trên extension" | |
| 3.4 | Nhìn ô đếm `Revision hiện hành` | `0` | |
| 3.5 | Nhìn mục **Lịch sử phát hành** | `Chưa có bản phát hành.` | |
| 3.6 | Nhìn nút phát hành khi chưa duyệt bộ nào | **Bị khoá**, cạnh nó ghi lý do "Chưa có bộ nào được duyệt cho lần phát hành tiếp theo." | |
| 3.7 | Đăng xuất rồi mở thẳng `http://localhost:3000/releases` | Bị đá về `/login` | |

## 4. Trang Phát hành — có bộ đã duyệt

Vào `/guides`, duyệt **đúng một** bộ POS (thao tác này ghi vào bảng `guides`, **không**
tạo release), rồi quay lại `/releases`.

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 4.1 | Nhìn khối POS | Ô `Đã duyệt cho lần phát hành tiếp theo` = **1**, `Tổng bước` = số bước của bộ đó | |
| 4.2 | Nhìn ô `Bản nháp` của POS | Bằng số bộ POS còn ở bản nháp (12 nếu bạn chỉ duyệt một bộ) | |
| 4.3 | Nhìn khối Admin | Vẫn **0** đã duyệt — hai site đếm độc lập | |
| 4.4 | Bấm **Xem 1 bộ sẽ vào bản phát hành** | Mở ra bảng: tên bộ (bấm được, sang trang sửa), số bước, cột cảnh báo | |
| 4.5 | Nếu bộ đó có cờ auto-click | Cột cảnh báo hiện chip **Auto-click chưa có neo text** | |
| 4.6 | Để trống ô **Ghi chú phát hành** | Nút phát hành **bị khoá**, lý do "Nhập ghi chú phát hành trước đã." | |
| 4.7 | Gõ một ghi chú | Nút mở ra | |

## 5. Hộp xác nhận phát hành — rồi HUỶ

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 5.1 | Bấm **Phát hành site POS** | Hiện thẻ xác nhận, **chưa gọi database** | |
| 5.2 | Đọc bảng trong thẻ | Site · Guide (dự kiến) · Bước (dự kiến) · Revision hiện tại `0` · Revision dự kiến `1` · Ghi chú vừa gõ | |
| 5.3 | Nhìn dòng giải thích dưới bảng | Nói rõ con số là **dự kiến**, server mới là nơi chốt và tự tính checksum | |
| 5.4 | **Bấm Huỷ** | Về lại màn hình cũ, không có gì được tạo | |
| 5.5 | Mở lại thẻ xác nhận rồi Huỷ vài lần | Không có lỗi, không có request nào chạy | |

## 6. Không có gì được ghi

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 6.1 | Tải lại `/releases` vài lần | Vẫn `Chưa có bản phát hành` — **mở trang không bao giờ tạo release** | |
| 6.2 | Chạy SQL bên dưới | `0` | |

```sql
select count(*) as releases from public.releases;
select count(*) as heads    from public.release_heads;
```

Cả hai phải là `0`.

| # | Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|
| 6.3 | Trả bộ vừa duyệt về **Bản nháp** | `/releases` quay lại 0 đã duyệt, nút phát hành khoá lại | |

## 7. Những gì batch này KHÔNG kiểm bằng tay

Ghi ra để khỏi tưởng là bỏ sót:

- **Publish thật**, và màn hình sau khi publish thành công.
- **Rollback**: nút, hộp xác nhận, và việc revision mới phải **cao hơn** chứ không phải
  hạ xuống.
- **Chip "Đang chạy trên extension"** trên bản head.
- **Cột "Rollback từ revision N"** trong lịch sử.

Cả bốn đều cần một release tồn tại. Chúng được phủ bằng unit test trong
`apps/admin/tests/releases.test.mjs` (22 test) và bằng test đối chiếu thẳng với SQL trong
`apps/admin/tests/rpc-mapping.test.mjs` — gồm: rollback không nhận ghi chú, rollback từ
chối bản hiện hành, rollback dùng `max(revision)+1`, `releases` không bao giờ bị `update`,
và checksum chỉ do SQL tính.

QA bằng tay cho các đường này thuộc Batch 3, khi extension đã đồng bộ được release và có
thể xác nhận đầu cuối.

## Kết luận

| Hạng mục | Đạt | Ghi chú |
|---|---|---|
| Nhãn trạng thái hết chữ tiếng Anh (mục 1) | | |
| Xanh lá không còn dùng cho "đã duyệt" (1.2) | | |
| Hỏi lại đúng lúc, không hỏi tràn lan (mục 2) | | |
| Trạng thái rỗng đúng chữ (mục 3) | | |
| `/releases` cần đăng nhập (3.7) | | |
| Hai site đếm độc lập (4.3) | | |
| Ghi chú bắt buộc (4.6) | | |
| Hộp xác nhận đủ 6 dòng và ghi rõ "dự kiến" (5.2–5.3) | | |
| **`releases` vẫn = 0 sau toàn bộ QA (6.2)** | | |
