-- Rollback 0003. Chỉ drop function; không đụng dữ liệu.
drop function if exists public.admin_delete_guide(uuid);
drop function if exists public.admin_set_guide_status(uuid, text);
drop function if exists public.admin_assign_guide_site(uuid, text, text);
drop function if exists public.admin_save_guide_steps(uuid, jsonb, jsonb, timestamptz);
drop function if exists public.admin_upsert_guide(uuid, text, text, text, text, integer, text);
drop function if exists public.admin_get_guide(uuid);
drop function if exists public.admin_list_guides(text, text, text);
drop function if exists public.admin_import_legacy(jsonb, text, text);
drop function if exists public.require_admin();
