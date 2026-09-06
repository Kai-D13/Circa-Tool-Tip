-- Rollback 0003. Drops only functions; no data is touched.
drop function if exists public.admin_upsert_group(uuid, text, text, integer);
drop function if exists public.admin_delete_guide(uuid);
drop function if exists public.admin_set_guide_status(uuid, text);
drop function if exists public.admin_assign_guide_site(uuid, text, uuid);
drop function if exists public.admin_save_guide_steps(uuid, jsonb, jsonb, timestamptz);
drop function if exists public.admin_upsert_guide(uuid, text, text, uuid, text, integer, text);
drop function if exists public.admin_get_guide(uuid);
drop function if exists public.admin_list_guides(text, uuid, text);
drop function if exists public.admin_import_legacy(jsonb, text, text);
drop function if exists public.require_admin();
