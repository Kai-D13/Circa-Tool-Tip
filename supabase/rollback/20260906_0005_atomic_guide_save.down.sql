-- Rollback 0005. Chỉ drop function; không đụng dữ liệu.
-- Sau khi chạy file này, editor phải quay lại dùng cặp
-- admin_save_guide_steps + admin_upsert_guide (không còn nguyên tử).
drop function if exists public.admin_save_guide(uuid, text, text, text, text, integer, text, jsonb, jsonb, timestamptz);
