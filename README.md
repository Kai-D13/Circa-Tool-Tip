# Circa Tool-tip

Hệ thống hướng dẫn thao tác trên POS và Admin của Circa: Admin Portal quản lý guide,
Supabase giữ dữ liệu, Chrome extension hiển thị tooltip cho nhân viên cửa hàng.

Thay thế cho `tooltip-guide-extension` v2.4.9 (config nằm trong extension, đồng bộ qua
Google Apps Script). **Không sửa repo cũ** — nó vẫn đang chạy production.

## Trạng thái

| Batch | Nội dung | Trạng thái |
|---|---|---|
| Bước 0 | Plan v1.1 sau audit | Xong — [`docs/IMPLEMENTATION_PLAN_v1.1.md`](docs/IMPLEMENTATION_PLAN_v1.1.md) |
| 1A | Monorepo, guide-schema v5, unit test, legacy importer, migration files | Xong |
| 1B | Chạy migration, import 48 guide, màn triage | Chờ stakeholder chạy migration |
| 2 | Admin Portal + recorder | Chưa bắt đầu |
| 3 | Extension viewer + sync + UI adapter | Chưa bắt đầu |
| 4 | QA 2 pha + Chrome Web Store Unlisted | Chưa bắt đầu |

## Cấu trúc

```
apps/admin/            Next.js 16 Admin Portal          (Batch 2)
apps/extension/        Chrome MV3                        (Batch 3)
packages/guide-schema/ Schema v5 + validator + URL matcher + checksum + flags
scripts/import-legacy/ Importer v4 -> v5
supabase/              migrations · rollback · seed · tests
data/                  Artifact importer sinh ra
docs/                  Plan, import report, migration runbook
```

## Yêu cầu

Node 24 (xem `.node-version`), pnpm 10. Chưa có dependency nào: `packages/guide-schema`
viết bằng TypeScript nhưng Node 24 chạy trực tiếp bằng type-stripping, nên không cần
transpiler cho tới khi Batch 2 thêm Next.js.

## Lệnh

```bash
node scripts/check-syntax.mjs                            # mọi file runtime phải parse
node --test "packages/guide-schema/tests/*.test.mjs"     # unit test
node scripts/import-legacy/cli.mjs                       # chạy lại importer
```

Importer đọc file export v4 và ghi ra `data/legacy-import.v5.json` +
`docs/IMPORT_REPORT.md`. Step id là deterministic nên chạy lại cho kết quả giống hệt.

## Điểm cần biết trước khi sửa code

- **`packages/guide-schema` là contract dùng chung.** Portal, importer và extension đều
  import từ đây. Ở bản cũ, `normalizeAction`, `inferUrlMatchMode` và bộ so khớp URL bị
  viết hai lần và đã trôi khỏi nhau — đừng lặp lại.
- **Chỉ dùng cú pháp TypeScript xoá được.** Node xoá type chứ không transform, nên không
  `enum`, không `namespace`, không parameter property, không decorator.
- **Draft step kế thừa site từ guide; release step bắt buộc có `site`.** Xem
  Plan v1.1 §P0-5.
- **Bốn bảng, không hơn:** `sites`, `guides`, `releases`, `release_heads`. Không có
  bảng version theo từng guide, không có bảng nhóm — nhóm là cột text. Đây là feature
  nội bộ cho ~25 máy POS; thêm bảng là thêm chỗ sai.
- **Flag không chặn publish.** Chúng nuôi repair queue và cảnh báo trên Portal; quyết
  định là của Admin (Plan v1.1 §P0-7).
- **SQL trong `supabase/` chưa từng được chạy.** Máy dev không có Postgres; lần chạy đầu
  ở Batch 1B là lần verify. Theo đúng [`docs/MIGRATION_RUNBOOK.md`](docs/MIGRATION_RUNBOOK.md).

## Tài nguyên

| | |
|---|---|
| Supabase project | `yoqzsvcbsornqjcatdvy` — `https://yoqzsvcbsornqjcatdvy.supabase.co` |
| Site đích | `https://pos.v2.circa.vn` · `https://admin.v2.circa.vn` |
| Portal khi dev | `http://localhost:3000` |
| Phân phối | Chrome Web Store, chế độ Unlisted (tạo item sau khi extension xong) |
| Extension cũ | `C:\QR_code\tooltip-guide-extension` — **chỉ đọc** |
| Tham chiếu kiến trúc | `C:\QR_code\circa-consult-salesup` — cùng stack, đã chạy production |

Publishable key cấu hình qua `.env.local`, không commit. Không dùng service-role key cho
runtime của ứng dụng.
