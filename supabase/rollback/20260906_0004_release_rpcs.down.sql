-- Rollback 0004. Chỉ drop function; không đụng dữ liệu.
drop function if exists public.get_release(text);
drop function if exists public.admin_list_releases(text);
drop function if exists public.admin_rollback_site(text, uuid);
drop function if exists public.admin_publish_site(text, text);
