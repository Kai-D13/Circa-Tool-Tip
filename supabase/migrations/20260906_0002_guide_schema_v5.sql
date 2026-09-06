-- =============================================================================
-- Circa Tool-tip · 0002 · Schema v5
--
-- Design decisions carried from Plan v1.1:
--   §P0-4  `releases` is immutable and has NO status column. There is no
--          release_status enum. `release_heads` is the single source of truth for
--          "which release is live". Rollback mints a NEW higher revision.
--   §P0-5  A guide's site may be null while unassigned; a RELEASED step always names
--          a site. The draft/release split is enforced by admin_publish_site, and the
--          CHECK below stops an unassigned guide from ever being marked published.
--   §P0-7  No hard gate on auto-click risk lives here. Flags are advisory metadata in
--          `guides.validation`; the portal warns and the admin confirms.
--
-- RLS: SELECT policies only.
--   * admin tables  -> authenticated + is_admin()
--   * releases/heads -> anon + authenticated, using (true). This IS the extension's
--     data plane: the extension ships only the publishable key and reads these two
--     tables with it. Everything published here is world-readable to anyone holding
--     that key, which is why the importer scrubs PII before anything is imported.
-- =============================================================================

create type public.guide_status as enum ('unassigned', 'draft', 'published', 'archived');

-- -----------------------------------------------------------------------------
-- sites: the web apps the extension injects into.
-- -----------------------------------------------------------------------------
create table if not exists public.sites (
  code       text primary key check (code = lower(code) and code ~ '^[a-z][a-z0-9_-]*$'),
  label      text not null check (length(trim(label)) > 0),
  -- Origin only: scheme + host, no trailing slash, no path.
  origin     text not null unique check (origin ~ '^https://[a-z0-9.-]+$'),
  sort_order integer not null default 0,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- guide_groups: the business grouping shown in the guide menu, per site.
-- -----------------------------------------------------------------------------
create table if not exists public.guide_groups (
  id         uuid primary key default gen_random_uuid(),
  site_code  text not null references public.sites(code) on delete restrict,
  name       text not null check (length(trim(name)) > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (site_code, name)
);

-- -----------------------------------------------------------------------------
-- guides: metadata plus the working copy of the steps.
-- -----------------------------------------------------------------------------
create table if not exists public.guides (
  id            uuid primary key default gen_random_uuid(),
  -- 13-char base36 id from the v4 export. Makes admin_import_legacy idempotent.
  legacy_id     text unique,
  site_code     text references public.sites(code) on delete restrict,
  group_id      uuid references public.guide_groups(id) on delete set null,
  name          text not null check (length(trim(name)) > 0),
  status        public.guide_status not null default 'unassigned',
  start_url     text not null default '' check (length(start_url) <= 4096),
  sort_order    integer not null default 0,

  draft_steps   jsonb not null default '[]'::jsonb,
  step_count    integer not null default 0 check (step_count >= 0),
  -- { errors: [], warnings: [], flags: [] } from packages/guide-schema
  validation    jsonb not null default '{}'::jsonb,

  -- Importer heuristic + its evidence. Advisory only; a human assigns site_code.
  site_guess    text,
  site_evidence jsonb not null default '{}'::jsonb,
  notes         text,

  created_by       uuid references auth.users(id),
  created_by_email text,
  created_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id),
  updated_by_email text,
  updated_at       timestamptz not null default now(),

  -- The Batch 1 acceptance rule, enforced by the database rather than by app code:
  -- a guide may only stay site-less while it is still unassigned.
  constraint guides_site_required check (status = 'unassigned' or site_code is not null),
  -- A group always belongs to a site, so a grouped guide must have one too.
  constraint guides_group_needs_site check (group_id is null or site_code is not null)
);

create index if not exists guides_by_site on public.guides (site_code, status, sort_order);
create index if not exists guides_unassigned on public.guides (status) where status = 'unassigned';
create index if not exists guides_by_group on public.guides (group_id);

-- -----------------------------------------------------------------------------
-- guide_versions: immutable snapshot of ONE guide.
-- -----------------------------------------------------------------------------
create table if not exists public.guide_versions (
  id         uuid primary key default gen_random_uuid(),
  guide_id   uuid not null references public.guides(id) on delete cascade,
  revision   integer not null check (revision > 0),
  steps      jsonb not null,
  step_count integer not null check (step_count >= 0),
  site_code  text not null references public.sites(code),
  checksum   text not null,
  note       text,

  created_by       uuid references auth.users(id),
  created_by_email text,
  created_at       timestamptz not null default now(),

  unique (guide_id, revision)
);

create index if not exists guide_versions_by_guide on public.guide_versions (guide_id, revision desc);

-- -----------------------------------------------------------------------------
-- releases: immutable snapshot of ONE SITE. Never updated after insert.
--
-- `revision` is strictly monotonic per site and never reused. The extension refuses
-- to move backwards (a downgrade would let a stale release overwrite a newer one), so
-- a rollback that re-pointed the head at a LOWER revision would leave every client
-- that already holds the higher one stuck forever. admin_rollback_site therefore
-- copies the old payload into a new, higher revision.
-- -----------------------------------------------------------------------------
create table if not exists public.releases (
  id               uuid primary key default gen_random_uuid(),
  site_code        text not null references public.sites(code) on delete restrict,
  revision         bigint not null check (revision > 0),
  payload          jsonb not null,
  checksum         text not null,
  guide_count      integer not null check (guide_count >= 0),
  step_count       integer not null check (step_count >= 0),
  rolled_back_from uuid references public.releases(id),
  note             text,

  released_by       uuid references auth.users(id),
  released_by_email text,
  released_at       timestamptz not null default now(),

  unique (site_code, revision)
);

create index if not exists releases_by_site on public.releases (site_code, revision desc);

-- -----------------------------------------------------------------------------
-- release_heads: exactly one row per site - what the extension should be running.
-- The extension probes this table first and only downloads a payload when the
-- revision differs from its cache.
-- -----------------------------------------------------------------------------
create table if not exists public.release_heads (
  site_code   text primary key references public.sites(code) on delete restrict,
  release_id  uuid not null references public.releases(id) on delete restrict,
  revision    bigint not null,
  checksum    text not null,
  guide_count integer not null,
  step_count  integer not null,
  released_at timestamptz not null
);

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.sites          enable row level security;
alter table public.guide_groups   enable row level security;
alter table public.guides         enable row level security;
alter table public.guide_versions enable row level security;
alter table public.releases       enable row level security;
alter table public.release_heads  enable row level security;

drop policy if exists sites_admin_read on public.sites;
create policy sites_admin_read on public.sites
  for select to authenticated using (public.is_admin());

drop policy if exists guide_groups_admin_read on public.guide_groups;
create policy guide_groups_admin_read on public.guide_groups
  for select to authenticated using (public.is_admin());

drop policy if exists guides_admin_read on public.guides;
create policy guides_admin_read on public.guides
  for select to authenticated using (public.is_admin());

drop policy if exists guide_versions_admin_read on public.guide_versions;
create policy guide_versions_admin_read on public.guide_versions
  for select to authenticated using (public.is_admin());

-- The extension's data plane. Anonymous read is intentional and is the reason the
-- importer scrubs PII before import.
drop policy if exists releases_public_read on public.releases;
create policy releases_public_read on public.releases
  for select to anon, authenticated using (true);

drop policy if exists release_heads_public_read on public.release_heads;
create policy release_heads_public_read on public.release_heads
  for select to anon, authenticated using (true);

-- Table privileges must be granted as well as policies: a policy narrows access, it
-- does not grant it, and a missing grant is just as effective a denial.
revoke all on public.sites, public.guide_groups, public.guides, public.guide_versions,
              public.releases, public.release_heads from public;

grant select on public.sites, public.guide_groups, public.guides, public.guide_versions
  to authenticated;
grant select on public.releases, public.release_heads to anon, authenticated;

-- =============================================================================
-- Shared validation helper.
--
-- Every jsonb type gate uses `is distinct from`, never `<>`: jsonb_typeof(NULL) is SQL
-- NULL, and `NULL <> 'array'` evaluates to NULL, which IF silently treats as false -
-- so a missing key would sail straight through a naive check.
-- =============================================================================
create or replace function public.guide_steps_shape_error(p_steps jsonb)
returns text
language plpgsql
immutable
as $$
declare
  item     jsonb;
  idx      integer := 0;
  seen_ids text[] := array[]::text[];
  step_id  text;
begin
  if jsonb_typeof(p_steps) is distinct from 'array' then
    return 'steps phải là mảng JSON';
  end if;

  for item in select * from jsonb_array_elements(p_steps) loop
    idx := idx + 1;

    if jsonb_typeof(item) is distinct from 'object' then
      return format('Bước %s không phải object', idx);
    end if;

    step_id := item ->> 'id';
    if step_id is null or length(trim(step_id)) = 0 then
      return format('Bước %s thiếu id', idx);
    end if;
    if step_id = any (seen_ids) then
      return format('Bước %s có id trùng: %s', idx, step_id);
    end if;
    seen_ids := seen_ids || step_id;

    if jsonb_typeof(item -> 'selectors') is distinct from 'array' then
      return format('Bước %s: selectors phải là mảng', idx);
    end if;

    if jsonb_typeof(item -> 'action') is distinct from 'object' then
      return format('Bước %s: thiếu action', idx);
    end if;

    if (item -> 'action' ->> 'type') is null
       or (item -> 'action' ->> 'type') not in (
         'highlight', 'click_next', 'click_wait_url', 'auto_click_next',
         'auto_click_wait_url', 'wait_element', 'manual'
       ) then
      return format('Bước %s: action.type không hợp lệ', idx);
    end if;
  end loop;

  return null;
end;
$$;
