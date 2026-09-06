-- Rollback 0001. DESTRUCTIVE: removes the role model.
-- Run the later rollbacks first: is_admin() is referenced by every policy and RPC.

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop function if exists public.is_admin();

drop table if exists public.profiles;
drop table if exists public.admin_allowlist;

-- pgcrypto is left in place: other things may rely on it.
