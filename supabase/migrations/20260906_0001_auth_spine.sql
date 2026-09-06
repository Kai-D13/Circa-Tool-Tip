-- =============================================================================
-- Circa Tool-tip · 0001 · Auth spine
--
-- Adapted from circa-consult-salesup/supabase/migrations/20260712090000_consultation_platform.sql
-- but DELIBERATELY NOT a verbatim copy of lines 1-147 (Plan v1.1 §P0-3): that range also
-- creates dataset_status, dataset_versions, consultation_rules and dataset_audit_logs,
-- which belong to a different product. Only the auth spine is carried over:
--   admin_allowlist · profiles · handle_new_user() · is_admin() · their RLS.
--
-- Authorisation model, unchanged from the proven original:
--   * SELECT policies only. There is NO insert/update/delete policy on any table.
--   * Every mutation goes through a security-definer RPC guarded by is_admin().
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Who is allowed to be an admin. Seeded with the first admin; add more rows later.
-- -----------------------------------------------------------------------------
create table if not exists public.admin_allowlist (
  email      text primary key check (email = lower(email)),
  note       text,
  created_at timestamptz not null default now()
);

insert into public.admin_allowlist (email, note)
values ('hoangvudn96@gmail.com', 'Admin đầu tiên - stakeholder')
on conflict (email) do nothing;

-- -----------------------------------------------------------------------------
-- One row per auth user, carrying the role.
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  role       text not null check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Role assignment on signup / email change.
-- Email is normalised with lower(trim(...)) everywhere - allowlist, trigger and
-- backfill - so a stray space can never silently downgrade an admin to viewer.
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(trim(coalesce(new.email, '')));
  assigned_role    text;
begin
  assigned_role := case
    when exists (select 1 from public.admin_allowlist a where a.email = normalized_email)
      then 'admin'
    else 'viewer'
  end;

  insert into public.profiles (user_id, email, role)
  values (new.id, normalized_email, assigned_role)
  on conflict (user_id) do update
    set email      = excluded.email,
        role       = excluded.role,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- BACKFILL. The first admin user was created BEFORE this migration, so the trigger
-- above never fired for them. Look them up by normalised email - never by a
-- hard-coded UUID, which would rot the moment the account is recreated.
-- -----------------------------------------------------------------------------
insert into public.profiles (user_id, email, role)
select
  u.id,
  lower(trim(u.email)),
  case
    when exists (
      select 1 from public.admin_allowlist a where a.email = lower(trim(u.email))
    ) then 'admin'
    else 'viewer'
  end
from auth.users u
where u.email is not null
  and trim(u.email) <> ''
on conflict (user_id) do update
  set email      = excluded.email,
      role       = excluded.role,
      updated_at = now();

-- -----------------------------------------------------------------------------
-- The single authorisation predicate used by every policy and every admin RPC.
-- -----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'admin'
  );
$$;

-- -----------------------------------------------------------------------------
-- RLS. Read-only policies; no write policy anywhere by design.
-- -----------------------------------------------------------------------------
alter table public.admin_allowlist enable row level security;
alter table public.profiles        enable row level security;

drop policy if exists profiles_read_self on public.profiles;
create policy profiles_read_self
  on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists admin_allowlist_admin_read on public.admin_allowlist;
create policy admin_allowlist_admin_read
  on public.admin_allowlist for select to authenticated
  using (public.is_admin());

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;
