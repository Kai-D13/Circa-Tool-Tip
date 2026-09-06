# IMPORT REPORT — legacy v4 -> v5

Sinh bởi `scripts/import-legacy/cli.mjs`. Chưa ghi gì vào Supabase.

Báo cáo này KHÔNG chứa thời điểm chạy: chạy lại importer trên cùng file nguồn phải
cho ra file y hệt, nếu không thì worktree bẩn sau mỗi lần chạy.

| | |
|---|---|
| File nguồn | `C:/Users/Administrator/Downloads/tooltip-guide-pos.v2.circa.vn (1) (1).json` |
| Kích thước nguồn | 378029 bytes |
| `sourceFileSha256` | `8d791365a0b7dda183727ebf64f9148ef76fc2459d3c57d2a8d4d3a09ad7fb3e` |
| exportedAt | 2026-08-21T11:12:34.694Z |
| targetDomain gốc | pos.v2.circa.vn |
| `contentChecksum` | `sha256:35d5c7a1ad21d0e0047ca562d02371e2c02f6e4639484851ecca88fe7d8622e9` |

Ba loại checksum, đừng dùng lẫn:

- **`sourceFileSha256`** — SHA-256 của file export v4 gốc.
- **`contentChecksum`** — SHA-256 của phần nội dung artifact (không gồm chính nó). Đây là thứ nhúng trong `data/legacy-import.v5.json` và truyền cho `admin_import_legacy`.
- **`artifactFileSha256`** — SHA-256 của cả file artifact trên đĩa. Không nhúng vào file (không thể tự chứa hash của chính mình); tính bằng `sha256sum data/legacy-import.v5.json` khi cần đối soát.

## 1. Đối soát số lượng

| Hạng mục | Nguồn | Sau import | Khớp |
|---|---:|---:|:---:|
| Guide | 48 | 48 | OK |
| Step | 409 | 409 | OK |

Step id sinh ra là **deterministic** (`sha256(legacyGuideId:index)`), toàn bộ 409 id duy nhất, nên chạy lại importer cho kết quả byte-for-byte giống nhau và `admin_import_legacy` idempotent.

## 2. Dữ liệu cá nhân

**PASS** — sau khi decode nhiều lớp, không còn chuỗi nào giống số điện thoại Việt Nam trong bất kỳ URL, matchText, tiêu đề hay nội dung nào.

Số bước đã bị xoá PII: **2** (giá trị không được ghi ra ở bất kỳ đâu).

| Guide | Bước |
|---|---:|
| QUẢN LÝ BÁN HÀNG- ĐƠN HÀNG | 8 |
| QUẢN LÝ BÁN HÀNG- ĐƠN HÀNG | 9 |

## 3. Kết quả làm sạch URL

| Loại | Số bước | Ý nghĩa |
|---|---:|---|
| `PII_SCRUBBED` | 2 | Đã xoá dữ liệu cá nhân khỏi URL. |
| `URL_UUID_STRIPPED` | 6 | Đã gỡ UUID định danh bản ghi/cửa hàng khỏi URL. |
| `URL_STALE_QUERY_STRIPPED` | 36 | Đã gỡ tham số môi trường cũ (ngày tuyệt đối, từ khoá tìm kiếm). |

## 4. Phân bố action

| Action | Số bước |
|---|---:|
| `auto_click_wait_url` | 319 |
| `highlight` | 48 |
| `auto_click_next` | 41 |
| `wait_element` | 1 |

## 5. Flag toàn bộ corpus

Flag là thông tin tư vấn, **không chặn publish** (Plan v1.1 §P0-7). Chúng nuôi repair queue và cảnh báo lúc publish.

| Flag | Số bước | Ý nghĩa |
|---|---:|---|
| `SEL_NTH_OF_TYPE` | 347 | Selector dùng :nth-of-type. |
| `SEL_STRUCTURAL_ONLY` | 230 | Selector không có id/class/attribute — chỉ dựa vị trí. |
| `NO_TEXT_ANCHOR` | 134 | Không có matchText dùng được. |
| `SEL_STRUCTURAL_AND_NO_TEXT` | 73 | Selector thuần cấu trúc và không có text anchor. |
| `AUTO_CLICK_UNANCHORED` | 72 | Extension tự click, nhưng selector chỉ dựa vào vị trí trong DOM và không có text để xác nhận. Ưu tiên recapture. |
| `MATCH_TEXT_ZERO_WIDTH_ONLY` | 43 | matchText cũ chỉ chứa ký tự zero-width — trông có nhưng không khớp được gì. |
| `URL_STALE_QUERY_STRIPPED` | 36 | Đã gỡ tham số môi trường cũ (ngày tuyệt đối, từ khoá tìm kiếm). |
| `SEL_KNOWN_DUPLICATE_ID` | 14 | Dùng id đã đo được là trùng lặp trên production (#basic-button xuất hiện 9 lần). |
| `URL_TOO_LONG` | 7 | URL rất dài — UI phải truncate. |
| `URL_UUID_STRIPPED` | 6 | Đã gỡ UUID định danh bản ghi/cửa hàng khỏi URL. |
| `SEL_BROAD` | 4 | Selector quá rộng. |
| `PII_SCRUBBED` | 2 | Đã xoá dữ liệu cá nhân khỏi URL. |

### Rủi ro cao nhất: `AUTO_CLICK_UNANCHORED`

**72** bước, nằm ở **24/48** bộ. Đây là danh sách ưu tiên của repair queue và là điều kiện Portal cảnh báo trước khi publish.

## 6. Pattern wildcard cần đối chiếu khi neo đầu

Matcher v5 neo wildcard vào đầu path (v4 không neo). Đây là toàn bộ pattern bị ảnh hưởng — phải chứng minh bằng replay Batch 4 (Plan v1.1 R4).

| Pattern | Số bước |
|---|---:|
| `/quan-ly-deal/them/*` | 25 |
| `/quan-ly-bang-gia/*` | 9 |
| `/phieu-mua-hang/*` | 9 |
| `/ban-hang/*` | 8 |
| `/yeu-cau-mua-hang/*` | 7 |
| `/chuyen-hang/*` | 6 |
| `/dieu-chinh-ton-kho/*/edit` | 6 |
| `/dieu-chinh-gia-von/*/edit` | 5 |
| `/tra-hang/*` | 4 |
| `/danh-sach-lieu-thuoc/*` | 4 |
| `/quan-ly-cua-hang/*` | 4 |
| `/sellback/create?id=*` | 2 |
| `/sellback/eligible?pos=*` | 2 |
| `/sellback/new?id=*` | 2 |
| `/circa/sellback/*` | 2 |
| `/tra-hang-ban/*` | 1 |
| `/quan-ly-combo/*` | 1 |

## 7. Validate

- Bộ có lỗi: **0/48**
- Tổng cảnh báo: **4**

## 8. Bảng triage — 48 bộ cần gán site thủ công

`siteCode` của **mọi** bộ đang là `null`, `status = unassigned`. Cột *Gợi ý* chỉ là tư vấn từ tiền tố route và **không được dùng làm acceptance criterion**; người duyệt quyết định từng bộ.

| # | Tên bộ | Bước | startUrl | Gợi ý | Độ tin | Flag |
|---:|---|---:|---|---|---|---|
| 1 | BÁN HÀNG TẠI QUẦY | 10 | `/trang-chu` | pos | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_KNOWN_DUPLICATE_ID` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 2 | TRẢ HÀNG BÁN | 8 | `/trang-chu` | pos | high | `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_KNOWN_DUPLICATE_ID` |
| 3 | THEO DÕI ĐƠN CHỜ HÀNG ONLINE | 4 | `/dashboard` | pos | medium | `SEL_KNOWN_DUPLICATE_ID` `URL_STALE_QUERY_STRIPPED` |
| 4 | PHIẾU BÁN LẠI- POS | 10 | `/trang-chu` | pos | medium | `AUTO_CLICK_UNANCHORED` `DUP_STEP_TITLE` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `SEL_KNOWN_DUPLICATE_ID` `SEL_STRUCTURAL_AND_NO_TEXT` `URL_UUID_STRIPPED` |
| 5 | NHẬP ĐƠN HÀNG TỪ NCC | 5 | `/trang-chu` | pos | high | `SEL_KNOWN_DUPLICATE_ID` |
| 6 | IN TEM SẢN PHẨM | 8 | `/dashboard` | — | none | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `SEL_KNOWN_DUPLICATE_ID` `SEL_STRUCTURAL_AND_NO_TEXT` `URL_STALE_QUERY_STRIPPED` |
| 7 | TẠO PHIẾU LUÂN CHUYỂN HÀNG NỘI BỘ | 10 | `/trang-chu` | pos | high | `AUTO_CLICK_UNANCHORED` `DUP_STEP_TITLE` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_KNOWN_DUPLICATE_ID` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 8 | NHẬN PHIẾU LUÂN CHUYỂN NỘI BỘ | 6 | `/trang-chu` | pos | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_KNOWN_DUPLICATE_ID` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 9 | TẠO YÊU CẦU MUA HÀNG | 6 | `/dashboard` | admin | medium | `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_KNOWN_DUPLICATE_ID` `URL_STALE_QUERY_STRIPPED` |
| 10 | THAO TÁC IN TEM GIÁ | 13 | `/dashboard` | — | none | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `SEL_KNOWN_DUPLICATE_ID` `SEL_STRUCTURAL_AND_NO_TEXT` `URL_STALE_QUERY_STRIPPED` |
| 11 | ĐỐI SOÁT DOANH THU | 3 | `/ban-hang-offline` | pos | high | `DUP_STEP_TITLE` `SEL_KNOWN_DUPLICATE_ID` |
| 12 | XUẤT BÁO CÁO BÁN HÀNG | 5 | `/dashboard` | — | none | `SEL_KNOWN_DUPLICATE_ID` `URL_STALE_QUERY_STRIPPED` |
| 13 | TẠO PHẢN HỒI TICKET | 2 | `/dashboard` | — | none | `SEL_KNOWN_DUPLICATE_ID` `START_URL_MISMATCH` `URL_STALE_QUERY_STRIPPED` |
| 14 | DASHBOARD TỔNG HỢP | 7 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `SEL_STRUCTURAL_AND_NO_TEXT` `URL_STALE_QUERY_STRIPPED` |
| 15 | QUẢN LÝ BÁN HÀNG- ĐƠN HÀNG | 9 | `/tai-khoan` | admin | high | `MATCH_TEXT_ZERO_WIDTH_ONLY` `PII_SCRUBBED` `URL_STALE_QUERY_STRIPPED` `URL_TOO_LONG` |
| 16 | QUẢN LÝ BÁN HÀNG- TRẢ HÀNG BÁN | 5 | `/tai-khoan` | admin | high | — |
| 17 | TẠO PHIẾU BÁN LẠI CHO POS TRÊN ADMIN | 10 | `/tai-khoan` | admin | medium | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` `URL_UUID_STRIPPED` |
| 18 | DUYỆT PHIẾU BÁN LẠI | 6 | `/tai-khoan` | admin | high | `SEL_STRUCTURAL_AND_NO_TEXT` |
| 19 | THAO TÁC THÊM SẢN PHẨM | 15 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 20 | THAO TÁC CHỈNH ĐƠN VỊ | 8 | `/tai-khoan` | admin | high | — |
| 21 | THAO TÁC TẠO COMBO 1 | 10 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 22 | THAO TÁC TẠO COMBO 2 | 5 | `/tai-khoan` | admin | high | — |
| 23 | THAO TÁC ĐĂNG BÁN COMBO | 9 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `DUP_STEP_TITLE` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 24 | THAO TÁC TẠO LIỀU THUỐC | 10 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 25 | QUẢN LÝ TỒN KHO | 6 | `/dashboard` | admin | medium | `DUP_STEP_TITLE` `START_URL_MISMATCH` `URL_STALE_QUERY_STRIPPED` |
| 26 | THAO TÁC ĐIỀU CHỈNH TỒN KHO | 11 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 27 | KIỂM KÊ TỒN KHO | 3 | `/tai-khoan` | admin | high | — |
| 28 | THAO TÁC ĐIỀU CHỈNH GIÁ VỐN | 10 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 29 | LUÂN CHUYỂN TỒN | 5 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 30 | THAO TÁC PHIẾU NHẬN HÀNG | 4 | `/tai-khoan` | admin | high | — |
| 31 | THAO TÁC PHIẾU TRẢ HÀNG | 5 | `/trang-chu` | pos | high | `SEL_KNOWN_DUPLICATE_ID` |
| 32 | DANH MỤC BẢNG GIÁ | 7 | `/tai-khoan` | admin | high | `DUP_GUIDE_NAME` |
| 33 | DANH MỤC BẢNG GIÁ | 8 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `DUP_GUIDE_NAME` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 34 | DUYỆT YÊU CẦU MUA HÀNG | 6 | `/tai-khoan` | admin | high | — |
| 35 | DUYỆT YCMH | 7 | `/tai-khoan` | admin | high | — |
| 36 | TẠO PO MUA HÀNG | 13 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `DUP_STEP_TITLE` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 37 | THÊM NHÀ NCC | 4 | `/tai-khoan` | admin | high | — |
| 38 | TẠO DEALS | 18 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 39 | TẠO DEAL CẬN | 13 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 40 | TẠO VOUCHER GIẢM GIÁ | 15 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_BROAD` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 41 | TẠO VOUCHER TẶNG QUÀ | 15 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 42 | TẠO VOUCHER QUÀ TẶNG GIẢM GIÁ | 25 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `DUP_STEP_TITLE` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 43 | BƯỚC 1-  Tạo voucher giảm giá kiểu “Hệ thống tạo sau” | 14 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_BROAD` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 44 | BƯỚC 2- Tạo voucher quà tặng (hệ thống tạo sau) | 17 | `/tai-khoan` | admin | high | `AUTO_CLICK_UNANCHORED` `GUIDE_HAS_AUTO_CLICK_UNANCHORED` `MATCH_TEXT_ZERO_WIDTH_ONLY` `SEL_BROAD` `SEL_STRUCTURAL_AND_NO_TEXT` |
| 45 | QUẢN LÝ CHUYỂN KHOẢN | 3 | `/tai-khoan` | admin | high | — |
| 46 | KIỂM TRA HÓA ĐƠN VAT | 4 | `/tai-khoan` | admin | high | — |
| 47 | QUẢN LÝ VAT | 5 | `/tai-khoan` | admin | high | — |
| 48 | PHÂN QUYỀN CHO NHÂN VIÊN VÀO POS CỬA HÀNG | 7 | `/tai-khoan` | admin | high | — |

### Bằng chứng phân loại theo từng bộ

- **BÁN HÀNG TẠI QUẦY** — gợi ý `pos` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 14 / Admin 0 / trung tính 0. Prefix: `ban-hang`×9, `trang-chu`×5
- **TRẢ HÀNG BÁN** — gợi ý `pos` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 12 / Admin 0 / trung tính 0. Prefix: `trang-chu`×5, `tra-hang`×4, `ban-hang-offline`×2, `ban-hang`×1
- **THEO DÕI ĐƠN CHỜ HÀNG ONLINE** — gợi ý `pos` (medium). Toàn bộ prefix nghiệp vụ thuộc một site, nhưng URL bắt đầu là route trung tính. POS 4 / Admin 0 / trung tính 5. Prefix: `dashboard`×5, `ban-hang-online`×4
- **PHIẾU BÁN LẠI- POS** — gợi ý `pos` (medium). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. Phần lớn route là trung tính nên bằng chứng yếu. POS 5 / Admin 0 / trung tính 14. Prefix: `sellback`×14, `trang-chu`×5
- **NHẬP ĐƠN HÀNG TỪ NCC** — gợi ý `pos` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 11 / Admin 0 / trung tính 0. Prefix: `danh-sach-phieu-nhan-hang`×6, `trang-chu`×5
- **IN TEM SẢN PHẨM** — gợi ý `không rõ` (none). Không có prefix nào thuộc từ điển POS/Admin — toàn route trung tính. POS 0 / Admin 0 / trung tính 17. Prefix: `danh-sach-ton-kho`×12, `dashboard`×5
- **TẠO PHIẾU LUÂN CHUYỂN HÀNG NỘI BỘ** — gợi ý `pos` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 17 / Admin 0 / trung tính 0. Prefix: `chuyen-hang`×12, `trang-chu`×5
- **NHẬN PHIẾU LUÂN CHUYỂN NỘI BỘ** — gợi ý `pos` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 11 / Admin 0 / trung tính 0. Prefix: `chuyen-hang`×6, `trang-chu`×5
- **TẠO YÊU CẦU MUA HÀNG** — gợi ý `admin` (medium). Toàn bộ prefix nghiệp vụ thuộc một site, nhưng URL bắt đầu là route trung tính. POS 0 / Admin 5 / trung tính 5. Prefix: `dashboard`×5, `yeu-cau-mua-hang`×5
- **THAO TÁC IN TEM GIÁ** — gợi ý `không rõ` (none). Không có prefix nào thuộc từ điển POS/Admin — toàn route trung tính. POS 0 / Admin 0 / trung tính 27. Prefix: `in-tem-gia-hang-loat`×22, `dashboard`×5
- **ĐỐI SOÁT DOANH THU** — gợi ý `pos` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 7 / Admin 0 / trung tính 0. Prefix: `ban-hang-offline`×5, `doi-soat-doanh-thu`×2
- **XUẤT BÁO CÁO BÁN HÀNG** — gợi ý `không rõ` (none). Không có prefix nào thuộc từ điển POS/Admin — toàn route trung tính. POS 0 / Admin 0 / trung tính 11. Prefix: `dashboard`×11
- **TẠO PHẢN HỒI TICKET** — gợi ý `không rõ` (none). Không có prefix nào thuộc từ điển POS/Admin — toàn route trung tính. POS 0 / Admin 0 / trung tính 5. Prefix: `dashboard`×5
- **DASHBOARD TỔNG HỢP** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 15 / trung tính 0. Prefix: `dashboard-tong-hop`×12, `tai-khoan`×3
- **QUẢN LÝ BÁN HÀNG- ĐƠN HÀNG** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 19 / trung tính 0. Prefix: `don-hang`×14, `tai-khoan`×5
- **QUẢN LÝ BÁN HÀNG- TRẢ HÀNG BÁN** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 10 / trung tính 0. Prefix: `tai-khoan`×5, `tra-hang-ban`×5
- **TẠO PHIẾU BÁN LẠI CHO POS TRÊN ADMIN** — gợi ý `admin` (medium). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. Phần lớn route là trung tính nên bằng chứng yếu. POS 0 / Admin 5 / trung tính 12. Prefix: `sellback`×12, `tai-khoan`×5
- **DUYỆT PHIẾU BÁN LẠI** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 11 / trung tính 0. Prefix: `circa`×6, `tai-khoan`×5
- **THAO TÁC THÊM SẢN PHẨM** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 31 / trung tính 0. Prefix: `quan-ly-san-pham-pos`×26, `tai-khoan`×5
- **THAO TÁC CHỈNH ĐƠN VỊ** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 17 / trung tính 0. Prefix: `quan-ly-san-pham-pos`×12, `tai-khoan`×5
- **THAO TÁC TẠO COMBO 1** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 20 / trung tính 0. Prefix: `quan-ly-combo`×15, `tai-khoan`×5
- **THAO TÁC TẠO COMBO 2** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 11 / trung tính 0. Prefix: `quan-ly-combo`×6, `tai-khoan`×5
- **THAO TÁC ĐĂNG BÁN COMBO** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 19 / trung tính 0. Prefix: `combo-da-dang-ban`×14, `tai-khoan`×5
- **THAO TÁC TẠO LIỀU THUỐC** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 17 / trung tính 0. Prefix: `danh-sach-lieu-thuoc`×12, `tai-khoan`×5
- **QUẢN LÝ TỒN KHO** — gợi ý `admin` (medium). Toàn bộ prefix nghiệp vụ thuộc một site, nhưng URL bắt đầu là route trung tính. POS 0 / Admin 4 / trung tính 9. Prefix: `danh-sach-ton-kho`×8, `tai-khoan`×4, `dashboard`×1
- **THAO TÁC ĐIỀU CHỈNH TỒN KHO** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 17 / trung tính 0. Prefix: `dieu-chinh-ton-kho`×12, `tai-khoan`×5
- **KIỂM KÊ TỒN KHO** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 7 / trung tính 0. Prefix: `tai-khoan`×5, `kiem-ke-ton-kho`×2
- **THAO TÁC ĐIỀU CHỈNH GIÁ VỐN** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 16 / trung tính 0. Prefix: `dieu-chinh-gia-von`×11, `tai-khoan`×5
- **LUÂN CHUYỂN TỒN** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 11 / trung tính 0. Prefix: `luan-chuyen-ton`×6, `tai-khoan`×5
- **THAO TÁC PHIẾU NHẬN HÀNG** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 9 / trung tính 0. Prefix: `tai-khoan`×5, `phieu-nhan-hang`×4
- **THAO TÁC PHIẾU TRẢ HÀNG** — gợi ý `pos` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 11 / Admin 0 / trung tính 0. Prefix: `tra-hang-nhap`×6, `trang-chu`×5
- **DANH MỤC BẢNG GIÁ** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 11 / trung tính 0. Prefix: `quan-ly-bang-gia`×6, `tai-khoan`×5
- **DANH MỤC BẢNG GIÁ** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 12 / trung tính 0. Prefix: `quan-ly-bang-gia`×7, `tai-khoan`×5
- **DUYỆT YÊU CẦU MUA HÀNG** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 11 / trung tính 0. Prefix: `yeu-cau-mua-hang`×6, `tai-khoan`×5
- **DUYỆT YCMH** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 13 / trung tính 0. Prefix: `yeu-cau-mua-hang`×8, `tai-khoan`×5
- **TẠO PO MUA HÀNG** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 18 / trung tính 0. Prefix: `phieu-mua-hang`×13, `tai-khoan`×5
- **THÊM NHÀ NCC** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 9 / trung tính 0. Prefix: `tai-khoan`×5, `quan-ly-nha-cung-cap`×4
- **TẠO DEALS** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 22 / trung tính 0. Prefix: `quan-ly-deal`×17, `tai-khoan`×5
- **TẠO DEAL CẬN** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 17 / trung tính 0. Prefix: `quan-ly-deal`×12, `tai-khoan`×5
- **TẠO VOUCHER GIẢM GIÁ** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 31 / trung tính 0. Prefix: `quan-ly-voucher`×26, `tai-khoan`×5
- **TẠO VOUCHER TẶNG QUÀ** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 31 / trung tính 0. Prefix: `quan-ly-voucher`×26, `tai-khoan`×5
- **TẠO VOUCHER QUÀ TẶNG GIẢM GIÁ** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 51 / trung tính 0. Prefix: `quan-ly-voucher`×46, `tai-khoan`×5
- **BƯỚC 1-  Tạo voucher giảm giá kiểu “Hệ thống tạo sau”** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 29 / trung tính 0. Prefix: `quan-ly-voucher`×24, `tai-khoan`×5
- **BƯỚC 2- Tạo voucher quà tặng (hệ thống tạo sau)** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 35 / trung tính 0. Prefix: `quan-ly-voucher`×30, `tai-khoan`×5
- **QUẢN LÝ CHUYỂN KHOẢN** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 7 / trung tính 0. Prefix: `tai-khoan`×5, `thanh-toan-chuyen-khoan`×2
- **KIỂM TRA HÓA ĐƠN VAT** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 9 / trung tính 0. Prefix: `tai-khoan`×5, `hoa-don-ban-hang`×4
- **QUẢN LÝ VAT** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 11 / trung tính 0. Prefix: `danh-sach-vat`×6, `tai-khoan`×5
- **PHÂN QUYỀN CHO NHÂN VIÊN VÀO POS CỬA HÀNG** — gợi ý `admin` (high). Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site. POS 0 / Admin 11 / trung tính 0. Prefix: `quan-ly-cua-hang`×6, `tai-khoan`×5

## 9. Sáu bước URL động sau khi sửa

Record id trong query không bị xoá trắng — làm vậy sẽ để lại URL chết. URL được nới
thành wildcard, và `navigationUrl` bị bỏ trống vì các trang này chỉ tới được bằng cách
click qua bước trước.

| Guide | Bước | urlPattern | navigationUrl | action | Bước trước |
|---|---:|---|---|---|---|
| PHIẾU BÁN LẠI- POS | 9 | `/sellback/create?id=*` | *(trống)* | `auto_click_wait_url` | `auto_click_wait_url` |
| PHIẾU BÁN LẠI- POS | 10 | `/sellback/create?id=*` | *(trống)* | `highlight` | `auto_click_wait_url` |
| TẠO PHIẾU BÁN LẠI CHO POS TRÊN ADMIN | 7 | `/sellback/eligible?pos=*` | *(trống)* | `auto_click_wait_url` | `auto_click_wait_url` |
| TẠO PHIẾU BÁN LẠI CHO POS TRÊN ADMIN | 8 | `/sellback/eligible?pos=*` | *(trống)* | `auto_click_wait_url` | `auto_click_wait_url` |
| TẠO PHIẾU BÁN LẠI CHO POS TRÊN ADMIN | 9 | `/sellback/new?id=*` | *(trống)* | `auto_click_wait_url` | `auto_click_wait_url` |
| TẠO PHIẾU BÁN LẠI CHO POS TRÊN ADMIN | 10 | `/sellback/new?id=*` | *(trống)* | `highlight` | `auto_click_wait_url` |

## 10. Bốn cảnh báo selector quá rộng

Stakeholder duyệt hạ từ error xuống warning, **kèm điều kiện**: cả bốn vào repair/QA
queue bắt buộc, và runtime chỉ auto-click khi text match là exact + unique + element
actionable — không có fallback kiểu 'lấy candidate đầu tiên' cho selector rộng.

| Guide | Bước | Selector chính | Số candidate | matchText | action |
|---|---:|---|---:|---|---|
| TẠO VOUCHER GIẢM GIÁ | 8 | `div > div:nth-of-type(9)` | 2 | Ngày bắt đầu | `auto_click_wait_url` |
| TẠO VOUCHER GIẢM GIÁ | 9 | `div > div:nth-of-type(10)` | 2 | Ngày kết thúc | `auto_click_wait_url` |
| BƯỚC 1-  Tạo voucher giảm giá kiểu “Hệ thống tạo sau” | 8 | `div > div:nth-of-type(9)` | 2 | Ngày bắt đầu | `auto_click_wait_url` |
| BƯỚC 2- Tạo voucher quà tặng (hệ thống tạo sau) | 1 | `div > div:nth-of-type(1)` | 1 | Công cụ Marketing | `auto_click_wait_url` |

## 11. Acceptance Batch 1A

| Tiêu chí | Kết quả |
|---|---|
| 48/48 guide | PASS |
| 409/409 step | PASS |
| Không còn PII sau decode nhiều lớp | PASS |
| Mọi guide ở trạng thái unassigned | PASS |
| Step id duy nhất và deterministic | PASS |
| Bộ có lỗi validate | PASS (0) |

