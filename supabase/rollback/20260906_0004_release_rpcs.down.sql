-- Rollback 0004. Drops only functions; no data is touched.
drop function if exists public.get_release(text);
drop function if exists public.admin_list_releases(text);
drop function if exists public.admin_rollback_site(text, uuid);
drop function if exists public.admin_publish_site(text, text);
drop function if exists public.admin_create_guide_version(uuid, text);
