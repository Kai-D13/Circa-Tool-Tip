begin;

-- =============================================================================
-- Circa Tool-tip · 0002 · Schema v5
--
-- Bốn bảng. Đây là feature nội bộ hiển thị hướng dẫn thao tác cho ~25 máy POS, không
-- phải CMS — mọi thứ không phục vụ trực tiếp việc đó đã bị bỏ:
--   * KHÔNG có bảng guide_versions. Lịch sử cần thiết là lịch sử RELEASE (thứ nhân viên
--     thực sự nhận), không phải version của từng guide. Bỏ nó cũng loại luôn được lỗi
--     "payload chứa draft mới nhưng ghi guideRevision cũ" (audit P0-2).
--   * KHÔNG có bảng guide_groups. Nhóm chỉ là nhãn gom menu -> một cột text trên guides.
--
-- Giữ nguyên các quyết định đã chốt:
--   §P0-4  `releases` immutable, KHÔNG có cột status, không có enum release_status.
--          `release_heads` là nguồn sự thật duy nhất. Rollback mint revision mới cao hơn.
--   §P0-5  Guide chưa gán site thì site null; step trong RELEASE luôn có site.
--   §P0-7  Không có hard gate về auto-click ở đây. Flag là metadata tư vấn.
--
-- RLS: chỉ có policy SELECT.
--   * bảng admin      -> authenticated + is_admin()
--   * releases/heads  -> anon + authenticated. Đây LÀ data plane của extension: nó chỉ
--     mang publishable key. Mọi thứ đã publish là đọc được với key đó, nên importer
--     phải scrub PII trước khi có gì được import.
-- =============================================================================
--
-- Chạy trọn trong một transaction: dừng giữa chừng thì không để lại trạng thái
-- nửa vời. (SQL Editor có thể cảnh báo "transaction already in progress" — vô hại.)


-- CREATE TYPE không idempotent, mà migration này có thể phải chạy lại sau một lần dừng
-- giữa chừng. Bọc lại để chạy lần hai không chết.
do $$ begin
  create type public.guide_status as enum ('unassigned', 'draft', 'published', 'archived');
exception when duplicate_object then null;
end $$;

-- -----------------------------------------------------------------------------
-- sites: hai web app mà extension chèn UI vào.
-- -----------------------------------------------------------------------------
create table if not exists public.sites (
  code       text primary key check (code = lower(code) and code ~ '^[a-z][a-z0-9_-]*$'),
  label      text not null check (length(trim(label)) > 0),
  -- Chỉ origin: scheme + host, không dấu / cuối, không path.
  origin     text not null unique check (origin ~ '^https://[a-z0-9.-]+$'),
  sort_order integer not null default 0,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- guides: metadata + bản draft đang sửa.
-- -----------------------------------------------------------------------------
create table if not exists public.guides (
  id            uuid primary key default gen_random_uuid(),
  -- id 13 ký tự base36 từ bản export v4. Làm admin_import_legacy idempotent.
  legacy_id     text unique,
  site_code     text references public.sites(code) on delete restrict,
  -- Nhãn gom menu. Rỗng nghĩa là chưa phân nhóm.
  group_name    text not null default '',
  name          text not null check (length(trim(name)) > 0),
  status        public.guide_status not null default 'unassigned',
  start_url     text not null default '' check (length(start_url) <= 4096),
  sort_order    integer not null default 0,

  draft_steps   jsonb not null default '[]'::jsonb,
  step_count    integer not null default 0 check (step_count >= 0),
  -- { errors: [], warnings: [], flags: [] } sinh bởi packages/guide-schema
  validation    jsonb not null default '{}'::jsonb,

  -- Gợi ý của importer + bằng chứng. Chỉ để tham khảo; người duyệt gán site_code.
  site_guess    text,
  site_evidence jsonb not null default '{}'::jsonb,
  notes         text,

  created_by       uuid references auth.users(id),
  created_by_email text,
  created_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id),
  updated_by_email text,
  updated_at       timestamptz not null default now(),

  -- Tiêu chí "48/48 phải có site trước khi publish", đặt ở database chứ không ở app:
  -- guide chỉ được phép không có site khi còn nằm trong hàng chờ phân loại.
  constraint guides_site_required check (status = 'unassigned' or site_code is not null)
);

create index if not exists guides_by_site on public.guides (site_code, status, sort_order);
create index if not exists guides_unassigned on public.guides (status) where status = 'unassigned';

-- -----------------------------------------------------------------------------
-- releases: snapshot immutable của MỘT SITE. Không bao giờ update sau khi insert.
--
-- `revision` tăng đơn điệu theo từng site và không tái sử dụng. Extension từ chối lùi
-- version (nếu không, một release cũ có thể đè lên bản mới hơn), nên rollback mà trỏ
-- head về revision THẤP hơn sẽ khiến mọi máy đã nhận bản cao hơn đứng vĩnh viễn.
-- admin_rollback_site vì thế copy payload cũ sang revision mới cao hơn.
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
-- release_heads: đúng một dòng mỗi site — bản extension nên đang chạy.
-- Extension probe bảng này trước và chỉ tải payload khi revision khác cache.
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
alter table public.sites         enable row level security;
alter table public.guides        enable row level security;
alter table public.releases      enable row level security;
alter table public.release_heads enable row level security;

drop policy if exists sites_admin_read on public.sites;
create policy sites_admin_read on public.sites
  for select to authenticated using (public.is_admin());

drop policy if exists guides_admin_read on public.guides;
create policy guides_admin_read on public.guides
  for select to authenticated using (public.is_admin());

-- Data plane của extension. Anonymous read là có chủ đích và là lý do importer scrub PII.
drop policy if exists releases_public_read on public.releases;
create policy releases_public_read on public.releases
  for select to anon, authenticated using (true);

drop policy if exists release_heads_public_read on public.release_heads;
create policy release_heads_public_read on public.release_heads
  for select to anon, authenticated using (true);

-- Phải cấp quyền bảng chứ không chỉ policy: policy thu hẹp quyền truy cập, nó không
-- cấp quyền, và thiếu grant thì cũng chặn y như bị từ chối.
revoke all on public.sites, public.guides, public.releases, public.release_heads from public;

grant select on public.sites, public.guides to authenticated;
grant select on public.releases, public.release_heads to anon, authenticated;

-- =============================================================================
-- Helper: kiểm tra hình dạng mảng step.
--
-- Mọi type gate jsonb dùng `is distinct from`, không dùng `<>`: jsonb_typeof(NULL) là
-- SQL NULL, và `NULL <> 'array'` cho ra NULL, mà IF coi NULL là false — nên một key bị
-- thiếu sẽ lọt thẳng qua nếu kiểm tra ngây thơ.
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

-- =============================================================================
-- Helper: guide này đã đủ điều kiện đưa vào release chưa? (audit P0-3)
--
-- Đây là kiểm tra TÍNH HỢP LỆ DỮ LIỆU, không phải security guard và cũng không phải
-- guard nghiệp vụ auto-click. Mục đích: không tạo ra release mà extension chắc chắn sẽ
-- từ chối, vì lúc đó cả site mất hướng dẫn chứ không riêng một guide.
-- =============================================================================
create or replace function public.guide_publish_error(p_guide_id uuid)
returns text
language plpgsql
stable
as $$
declare
  g            public.guides%rowtype;
  v_shape      text;
  v_override   text;
begin
  select * into g from public.guides where id = p_guide_id;
  if not found then
    return format('Không tìm thấy guide %s', p_guide_id);
  end if;

  if g.site_code is null then
    return format('"%s": chưa gán site', g.name);
  end if;

  if jsonb_typeof(g.draft_steps) is distinct from 'array'
     or jsonb_array_length(g.draft_steps) = 0 then
    return format('"%s": không có bước nào', g.name);
  end if;

  v_shape := public.guide_steps_shape_error(g.draft_steps);
  if v_shape is not null then
    return format('"%s": %s', g.name, v_shape);
  end if;

  -- Mọi siteOverride phải trỏ tới site có thật và đang bật, nếu không thì bước đó không
  -- bao giờ khớp được URL nào (matcher so origin trước tiên).
  for v_override in
    select distinct s ->> 'siteOverride'
    from jsonb_array_elements(g.draft_steps) as s
    where (s ->> 'siteOverride') is not null
  loop
    if not exists (select 1 from public.sites where code = v_override and enabled) then
      return format('"%s": có bước trỏ tới site "%s" không tồn tại hoặc đang tắt', g.name, v_override);
    end if;
  end loop;

  if jsonb_typeof(g.validation -> 'errors') is not distinct from 'array'
     and jsonb_array_length(g.validation -> 'errors') > 0 then
    return format('"%s": còn %s lỗi validate chưa sửa', g.name, jsonb_array_length(g.validation -> 'errors'));
  end if;

  return null;
end;
$$;

commit;
