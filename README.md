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
| 1B | Chạy migration 0001–0004 + RPC test + seed | Xong — `ALL GUIDE RPC TESTS PASSED` trên project thật |
| 2A | Admin Portal: login · import · triage | Xong — 48 guide / 409 step / 0 unassigned / POS 13 + Admin 35 |
| 2B.1 | Guide editor (metadata, step CRUD, validate, conflict 40001) | Code xong, chờ QA — [`docs/QA_LOCALHOST_2B1.md`](docs/QA_LOCALHOST_2B1.md) |
| 2B.2 | Recorder + preview draft (extension MV3) | Chưa bắt đầu |
| 2B.3 | Publish / release / rollback | Chưa bắt đầu |
| 3 | Extension viewer + sync + UI adapter | Chưa bắt đầu |
| 4 | QA 2 pha + Chrome Web Store Unlisted | Chưa bắt đầu |

## Cấu trúc

```
apps/admin/            Next.js 16 Admin Portal          (2A: login/import/triage)
apps/extension/        Chrome MV3                        (Batch 3)
packages/guide-schema/ Schema v5 + validator + URL matcher + checksum + flags
scripts/import-legacy/ Importer v4 -> v5
supabase/              migrations · rollback · seed · tests
data/                  Artifact importer sinh ra
docs/                  Plan, import report, migration runbook
```

## Yêu cầu

Node 24 (xem `.node-version`), pnpm 10. `packages/guide-schema` và `scripts/` không có
dependency (Node 24 chạy TypeScript trực tiếp). `apps/admin` là Next.js 16 — cần
`pnpm install`.

## Lệnh

```bash
node scripts/check-syntax.mjs                            # mọi file runtime phải parse
node --test "packages/guide-schema/tests/*.test.mjs"     # unit test
node scripts/import-legacy/cli.mjs                       # chạy lại importer

pnpm --filter admin test          # test logic thuần (import, triage, editor, RPC mapping, no-secrets)
pnpm --filter admin typecheck
pnpm --filter admin build
pnpm --filter admin dev           # cần apps/admin/.env.local, xem docs/QA_LOCALHOST_2A.md
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
- **Migration `0001–0004` là baseline đã áp dụng trên Supabase.** Không sửa lại; thay đổi
  DB mới đi qua `0005+`. Mọi hàm chạy với `search_path = public`: chỉ gọi hàm ở
  `pg_catalog`, `public`, hoặc kèm schema tường minh.
- **Portal chỉ có hai biến môi trường**, cả hai đều public (`.env.example`). Phân quyền
  thật nằm ở `requireAdmin()` phía server + RLS; `proxy.ts` chỉ refresh session và
  redirect thô.

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
