-- =============================================================================
-- Circa Tool-tip · 0004 · Release RPCs (version, publish, rollback, read)
--
-- Needed from Batch 2 onward. Batch 1B stops after triage and publishes nothing.
--
-- CHECKSUM POLICY (read this before changing anything):
--   Checksums are computed in SQL as sha256 over `jsonb::text`. Postgres serialises a
--   jsonb value deterministically, so the value is stable server-side - but it is NOT
--   reproducible from JavaScript, whose canonical JSON orders keys differently.
--   Therefore the extension does NOT recompute the checksum. It verifies that
--   release_heads.checksum equals the checksum embedded in the downloaded payload and
--   that the revisions match, which is exactly the failure it needs to catch: the head
--   moving while a payload was in flight. A truncated or garbled body fails JSON.parse,
--   and a structurally wrong body fails validateReleasePayload().
-- =============================================================================

-- =============================================================================
-- admin_create_guide_version - immutable snapshot of one guide's current draft
-- =============================================================================
create or replace function public.admin_create_guide_version(
  p_guide_id uuid,
  p_note     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_site     text;
  v_steps    jsonb;
  v_count    integer;
  v_revision integer;
  v_checksum text;
  v_email    text;
  v_id       uuid;
begin
  perform public.require_admin();

  select site_code, draft_steps, step_count into v_site, v_steps, v_count
  from public.guides where id = p_guide_id;

  if not found then
    raise exception 'Không tìm thấy guide %', p_guide_id using errcode = 'P0002';
  end if;
  if v_site is null then
    raise exception 'Phải gán site trước khi tạo version' using errcode = '22023';
  end if;

  select coalesce(max(revision), 0) + 1 into v_revision
  from public.guide_versions where guide_id = p_guide_id;

  v_checksum := 'sha256:' || encode(digest(v_steps::text, 'sha256'), 'hex');
  select lower(trim(email)) into v_email from auth.users where id = auth.uid();

  insert into public.guide_versions (
    guide_id, revision, steps, step_count, site_code, checksum, note,
    created_by, created_by_email
  ) values (
    p_guide_id, v_revision, v_steps, v_count, v_site, v_checksum, p_note,
    auth.uid(), v_email
  )
  returning id into v_id;

  return jsonb_build_object(
    'ok', true, 'versionId', v_id, 'revision', v_revision, 'checksum', v_checksum
  );
end;
$$;

revoke all on function public.admin_create_guide_version(uuid, text) from public;
grant execute on function public.admin_create_guide_version(uuid, text) to authenticated;

-- =============================================================================
-- admin_publish_site
--
-- Builds an immutable snapshot of every guide currently marked `published` for the
-- site, materialises step.site (Plan v1.1 §P0-5), reconciles the counts and moves the
-- head. Deliberately does NOT block on auto-click risk flags: that warning belongs to
-- the portal, where an admin confirms it (Plan v1.1 §P0-7).
-- =============================================================================
create or replace function public.admin_publish_site(p_site text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sites       jsonb;
  v_groups      jsonb;
  v_guides      jsonb;
  v_guide_count integer;
  v_step_count  integer;
  v_revision    bigint;
  v_payload     jsonb;
  v_checksum    text;
  v_release_id  uuid;
  v_email       text;
  v_now         timestamptz := now();
begin
  perform public.require_admin();

  if not exists (select 1 from public.sites where code = p_site and enabled) then
    raise exception 'Site % không tồn tại hoặc đang tắt', p_site using errcode = '22023';
  end if;

  -- A guide can only be published from a site it actually belongs to. The table CHECK
  -- already forbids status <> 'unassigned' with a null site; this catches the rest.
  if exists (
    select 1 from public.guides g
    left join public.guide_groups gr on gr.id = g.group_id
    where g.site_code = p_site and g.status = 'published'
      and (g.site_code is null or (g.group_id is not null and gr.site_code <> g.site_code))
  ) then
    raise exception 'Có guide published nhưng nhóm không thuộc site %', p_site using errcode = '22023';
  end if;

  -- site code -> origin, for every enabled site: a POS release must be able to name the
  -- Admin origin so a cross-origin step can resolve.
  select coalesce(jsonb_object_agg(code, origin), '{}'::jsonb) into v_sites
  from public.sites where enabled;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', gr.id, 'name', gr.name, 'sortOrder', gr.sort_order
         ) order by gr.sort_order, gr.name), '[]'::jsonb)
  into v_groups
  from public.guide_groups gr where gr.site_code = p_site;

  -- Snapshot every published guide, materialising step.site and stripping the
  -- authoring-only fields (siteOverride, flags).
  select
    coalesce(jsonb_agg(guide_json order by sort_order, name), '[]'::jsonb),
    count(*),
    coalesce(sum(step_count), 0)
  into v_guides, v_guide_count, v_step_count
  from (
    select
      g.sort_order,
      g.name,
      g.step_count,
      jsonb_build_object(
        'id',            g.id,
        'legacyId',      g.legacy_id,
        'name',          g.name,
        'site',          g.site_code,
        'groupId',       g.group_id,
        'sortOrder',     g.sort_order,
        'guideRevision', coalesce(
                           (select max(v.revision) from public.guide_versions v where v.guide_id = g.id),
                           1
                         ),
        'start',         jsonb_build_object('site', g.site_code, 'url', g.start_url),
        'steps',         coalesce((
                           select jsonb_agg(
                             (step - 'siteOverride' - 'flags')
                             || jsonb_build_object('site', coalesce(step ->> 'siteOverride', g.site_code))
                             order by ord
                           )
                           from jsonb_array_elements(g.draft_steps) with ordinality as s(step, ord)
                         ), '[]'::jsonb)
      ) as guide_json
    from public.guides g
    where g.site_code = p_site and g.status = 'published'
  ) t;

  if v_guide_count = 0 then
    raise exception 'Không có guide nào ở trạng thái published cho site %', p_site using errcode = '22023';
  end if;

  select coalesce(max(revision), 0) + 1 into v_revision
  from public.releases where site_code = p_site;

  v_payload := jsonb_build_object(
    'schemaVersion', 5,
    'site',          p_site,
    'revision',      v_revision,
    'releasedAt',    to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'sites',         v_sites,
    'groups',        v_groups,
    'guides',        v_guides
  );

  -- Reconciliation before anything is written: the payload must contain exactly what
  -- we counted, or we abort rather than ship a partial release.
  if jsonb_array_length(v_payload -> 'guides') is distinct from v_guide_count then
    raise exception 'Sai lệch số guide trong payload: % vs %',
      jsonb_array_length(v_payload -> 'guides'), v_guide_count using errcode = '22023';
  end if;
  if (
    select coalesce(sum(jsonb_array_length(g -> 'steps')), 0)
    from jsonb_array_elements(v_payload -> 'guides') as g
  ) is distinct from v_step_count then
    raise exception 'Sai lệch số step trong payload' using errcode = '22023';
  end if;

  v_checksum := 'sha256:' || encode(digest(v_payload::text, 'sha256'), 'hex');
  v_payload  := v_payload || jsonb_build_object('checksum', v_checksum);

  select lower(trim(email)) into v_email from auth.users where id = auth.uid();

  insert into public.releases (
    site_code, revision, payload, checksum, guide_count, step_count, note,
    released_by, released_by_email, released_at
  ) values (
    p_site, v_revision, v_payload, v_checksum, v_guide_count, v_step_count, p_note,
    auth.uid(), v_email, v_now
  )
  returning id into v_release_id;

  insert into public.release_heads (
    site_code, release_id, revision, checksum, guide_count, step_count, released_at
  ) values (
    p_site, v_release_id, v_revision, v_checksum, v_guide_count, v_step_count, v_now
  )
  on conflict (site_code) do update set
    release_id  = excluded.release_id,
    revision    = excluded.revision,
    checksum    = excluded.checksum,
    guide_count = excluded.guide_count,
    step_count  = excluded.step_count,
    released_at = excluded.released_at;

  return jsonb_build_object(
    'ok', true, 'site', p_site, 'releaseId', v_release_id, 'revision', v_revision,
    'checksum', v_checksum, 'guides', v_guide_count, 'steps', v_step_count
  );
end;
$$;

revoke all on function public.admin_publish_site(text, text) from public;
grant execute on function public.admin_publish_site(text, text) to authenticated;

-- =============================================================================
-- admin_rollback_site
--
-- Never lowers the revision. The extension refuses downgrades, so re-pointing the head
-- at an older revision would strand every client that already holds a newer one. We
-- copy the old payload forward into a NEW higher revision instead.
-- =============================================================================
create or replace function public.admin_rollback_site(p_site text, p_release_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old         public.releases%rowtype;
  v_revision    bigint;
  v_payload     jsonb;
  v_checksum    text;
  v_new_id      uuid;
  v_email       text;
  v_now         timestamptz := now();
  v_current     bigint;
begin
  perform public.require_admin();

  select * into v_old from public.releases where id = p_release_id and site_code = p_site;
  if not found then
    raise exception 'Không tìm thấy release % của site %', p_release_id, p_site using errcode = 'P0002';
  end if;

  select revision into v_current from public.release_heads where site_code = p_site;
  if v_current is not null and v_old.revision = v_current then
    raise exception 'Release này đang là bản hiện hành — không cần rollback' using errcode = '22023';
  end if;

  select coalesce(max(revision), 0) + 1 into v_revision from public.releases where site_code = p_site;

  v_payload := v_old.payload
    || jsonb_build_object(
         'revision', v_revision,
         'releasedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       );
  v_payload := v_payload - 'checksum';
  v_checksum := 'sha256:' || encode(digest(v_payload::text, 'sha256'), 'hex');
  v_payload := v_payload || jsonb_build_object('checksum', v_checksum);

  select lower(trim(email)) into v_email from auth.users where id = auth.uid();

  insert into public.releases (
    site_code, revision, payload, checksum, guide_count, step_count,
    rolled_back_from, note, released_by, released_by_email, released_at
  ) values (
    p_site, v_revision, v_payload, v_checksum, v_old.guide_count, v_old.step_count,
    v_old.id, format('Rollback về revision %s', v_old.revision), auth.uid(), v_email, v_now
  )
  returning id into v_new_id;

  insert into public.release_heads (
    site_code, release_id, revision, checksum, guide_count, step_count, released_at
  ) values (
    p_site, v_new_id, v_revision, v_checksum, v_old.guide_count, v_old.step_count, v_now
  )
  on conflict (site_code) do update set
    release_id  = excluded.release_id,
    revision    = excluded.revision,
    checksum    = excluded.checksum,
    guide_count = excluded.guide_count,
    step_count  = excluded.step_count,
    released_at = excluded.released_at;

  return jsonb_build_object(
    'ok', true, 'site', p_site, 'releaseId', v_new_id, 'revision', v_revision,
    'rolledBackFrom', v_old.revision
  );
end;
$$;

revoke all on function public.admin_rollback_site(text, uuid) from public;
grant execute on function public.admin_rollback_site(text, uuid) to authenticated;

-- =============================================================================
-- admin_list_releases
-- =============================================================================
create or replace function public.admin_list_releases(p_site text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_head jsonb;
begin
  perform public.require_admin();

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'revision', r.revision, 'checksum', r.checksum,
           'guideCount', r.guide_count, 'stepCount', r.step_count,
           'rolledBackFrom', r.rolled_back_from, 'note', r.note,
           'releasedAt', r.released_at, 'releasedByEmail', r.released_by_email
         ) order by r.revision desc), '[]'::jsonb)
  into v_rows
  from public.releases r where r.site_code = p_site;

  select to_jsonb(h) into v_head from public.release_heads h where h.site_code = p_site;

  return jsonb_build_object('ok', true, 'site', p_site, 'head', coalesce(v_head, 'null'::jsonb),
                            'releases', v_rows);
end;
$$;

revoke all on function public.admin_list_releases(text) from public;
grant execute on function public.admin_list_releases(text) to authenticated;

-- =============================================================================
-- get_release  -- the extension's payload fetch. anon + authenticated.
--
-- Returns a stable empty shape when a site has never been published, so the client has
-- one code path rather than two.
-- =============================================================================
create or replace function public.get_release(p_site text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  select r.payload into v_payload
  from public.release_heads h
  join public.releases r on r.id = h.release_id
  where h.site_code = p_site;

  if v_payload is null then
    return jsonb_build_object(
      'schemaVersion', 5,
      'site', p_site,
      'revision', 0,
      'releasedAt', null,
      'checksum', null,
      'sites', coalesce((select jsonb_object_agg(code, origin) from public.sites where enabled), '{}'::jsonb),
      'groups', '[]'::jsonb,
      'guides', '[]'::jsonb
    );
  end if;

  return v_payload;
end;
$$;

revoke all on function public.get_release(text) from public;
grant execute on function public.get_release(text) to anon, authenticated;
