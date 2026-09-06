# Migration runbook

Ai chạy: **stakeholder**, bằng Supabase SQL Editor của project Tool-tip
(`yoqzsvcbsornqjcatdvy`). Dev-team không cần service-role key hay access token.

> **Chưa chạy thử ở đâu.** Máy dev không có Postgres cục bộ nên toàn bộ SQL trong
> `supabase/` mới chỉ được review bằng mắt, chưa từng execute. Lần chạy đầu tiên chính
> là lần verify. Vì vậy hãy chạy đúng thứ tự bên dưới và **dừng lại ngay** nếu bước 5
> không in ra `ALL GUIDE RPC TESTS PASSED`.

## Thứ tự chạy

| Bước | File | Ghi chú |
|---|---|---|
| 1 | `supabase/migrations/20260906_0001_auth_spine.sql` | Tạo `admin_allowlist`, `profiles`, `handle_new_user()`, `is_admin()`. Có **backfill** cho admin đã tồn tại trước migration. |
| 2 | `supabase/migrations/20260906_0002_guide_schema_v5.sql` | Bảng + RLS + helper validate. |
| 3 | `supabase/migrations/20260906_0003_guide_rpcs.sql` | RPC import/triage/CRUD. |
| 4 | `supabase/migrations/20260906_0004_release_rpcs.sql` | RPC version/publish/rollback/get_release. |
| 5 | `supabase/tests/guide_rpc_test.sql` | **Tự rollback.** Phải in `ALL GUIDE RPC TESTS PASSED`. |
| 6 | `supabase/seed/sites.sql` | Seed `pos` + `admin`. |

## Kiểm tra sau bước 1

```sql
select user_id, email, role from public.profiles;
```

Phải thấy `hoangvudn96@gmail.com` với `role = 'admin'`. Nếu là `viewer` thì email trong
`auth.users` khác với email trong `admin_allowlist` — sửa allowlist rồi chạy lại phần
backfill của 0001 (nó idempotent).

## Kiểm tra sau bước 6

```sql
select code, origin from public.sites order by sort_order;
select count(*) from public.guides;   -- 0, import chạy ở Batch 1B
```

## Rollback

Chạy **ngược thứ tự**, vì function tham chiếu bảng và policy tham chiếu `is_admin()`:

```
supabase/rollback/20260906_0004_release_rpcs.down.sql   -- chỉ drop function, an toàn
supabase/rollback/20260906_0003_guide_rpcs.down.sql     -- chỉ drop function, an toàn
supabase/rollback/20260906_0002_guide_schema_v5.down.sql -- XOÁ DỮ LIỆU
supabase/rollback/20260906_0001_auth_spine.down.sql      -- XOÁ role model
```

0001 và 0002 là **destructive**. Trước khi chạy chúng trên project đã có dữ liệu thật,
hãy backup. 0003 và 0004 chỉ drop function nên chạy lại migration là khôi phục được.

## Sau khi migration xong

Batch 1B tiếp tục với:
1. Đăng nhập Portal một lần bằng `hoangvudn96@gmail.com` để xác nhận Auth chạy.
2. Gọi `admin_import_legacy` với nội dung `data/legacy-import.v5.json`.
3. Phân loại 48/48 guide trên màn triage.

Kiểm tra sau import:

```sql
select count(*) as guides, sum(step_count) as steps from public.guides;
-- kỳ vọng: 48 guide / 409 step
select count(*) from public.guides where status = 'unassigned';
-- kỳ vọng: 48 ngay sau import, phải về 0 trước khi publish
```
