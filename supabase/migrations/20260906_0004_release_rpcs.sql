begin;

-- =============================================================================
-- Circa Tool-tip · 0004 · Release RPC (publish, rollback, read)
--
-- Cần từ Batch 2 trở đi. Batch 1B dừng sau bước phân loại và không publish gì.
--
-- CHÍNH SÁCH CHECKSUM (đọc trước khi sửa bất cứ thứ gì):
--   Checksum tính trong SQL bằng sha256 trên `jsonb::text`. Postgres serialize jsonb
--   một cách xác định nên giá trị ổn định ở phía server — nhưng KHÔNG tái tạo được từ
--   JavaScript, vì canonical JSON của JS sắp key theo cách khác. Do đó extension KHÔNG
--   tính lại checksum. Nó kiểm tra release_heads.checksum bằng đúng checksum nhúng
--   trong payload tải về và so khớp revision — đúng lỗi cần bắt: head bị đổi trong lúc
--   payload đang truyền. Body cụt thì JSON.parse chết; body sai cấu trúc thì
--   validateReleasePayload() chặn.
--
-- KHÔNG có bảng guide_versions: release được build thẳng từ draft_steps của các guide
-- đang published. Vì snapshot và số revision sinh ra trong cùng một câu lệnh, không tồn
-- tại khe hở nào để payload chứa nội dung mới mà lại mang số version cũ (audit P0-2).
-- =============================================================================
--
-- Chạy trọn trong một transaction: dừng giữa chừng thì không để lại trạng thái
-- nửa vời. (SQL Editor có thể cảnh báo "transaction already in progress" — vô hại.)


-- =============================================================================
-- admin_publish_site
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
  v_bad         record;
begin
  perform public.require_admin();

  if not exists (select 1 from public.sites where code = p_site and enabled) then
    raise exception 'Site % không tồn tại hoặc đang tắt', p_site using errcode = '22023';
  end if;

  -- Hai lần publish đồng thời cùng một site sẽ cùng đọc max(revision). Unique constraint
  -- đã đủ để chặn hỏng dữ liệu, nhưng khoá này biến nó thành xếp hàng thay vì báo lỗi.
  perform pg_advisory_xact_lock(hashtext('circa_tooltip_release:' || p_site));

  -- Khoá luôn các dòng guide sắp đưa vào release. Advisory lock chỉ chặn publish khác;
  -- nếu không có FOR UPDATE thì admin_save_guide_steps vẫn có thể sửa draft ở khoảng
  -- giữa lúc validate và lúc đọc lại để build payload, làm release chứa dữ liệu chưa
  -- được validate. Khoá giữ tới hết transaction, tức là vài mili-giây.
  perform 1 from public.guides
   where site_code = p_site and status = 'published'
   for update;

  -- audit P0-3: không tạo ra release mà extension chắc chắn từ chối. Một guide hỏng làm
  -- cả site mất hướng dẫn, nên kiểm tra trước khi ghi bất cứ thứ gì.
  for v_bad in
    select id, name from public.guides
    where site_code = p_site and status = 'published'
    order by sort_order, name
  loop
    declare
      v_error text := public.guide_publish_error(v_bad.id);
    begin
      if v_error is not null then
        raise exception 'Không publish được site % — %', p_site, v_error using errcode = '22023';
      end if;
    end;
  end loop;

  -- site code -> origin cho MỌI site đang bật: release của POS phải gọi tên được origin
  -- của Admin thì bước cross-origin mới resolve được.
  select coalesce(jsonb_object_agg(code, origin), '{}'::jsonb) into v_sites
  from public.sites where enabled;

  select coalesce(jsonb_agg(distinct g.group_name order by g.group_name), '[]'::jsonb)
  into v_groups
  from public.guides g
  where g.site_code = p_site and g.status = 'published' and g.group_name <> '';

  -- Snapshot mọi guide đang published: materialize step.site và bỏ các trường chỉ dùng
  -- lúc soạn thảo (siteOverride, flags).
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
        'id',        g.id,
        'legacyId',  g.legacy_id,
        'name',      g.name,
        'site',      g.site_code,
        'group',     nullif(g.group_name, ''),
        'sortOrder', g.sort_order,
        'start',     jsonb_build_object('site', g.site_code, 'url', g.start_url),
        'steps',     coalesce((
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

  -- Đối soát trước khi ghi: payload phải chứa đúng những gì đã đếm, sai thì huỷ chứ
  -- không phát hành một release thiếu.
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
-- Không bao giờ hạ revision. Extension từ chối downgrade, nên trỏ head về revision cũ
-- sẽ làm kẹt vĩnh viễn mọi máy đã nhận bản cao hơn. Ta copy payload cũ sang một
-- revision MỚI cao hơn.
-- =============================================================================
create or replace function public.admin_rollback_site(p_site text, p_release_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old      public.releases%rowtype;
  v_revision bigint;
  v_payload  jsonb;
  v_checksum text;
  v_new_id   uuid;
  v_email    text;
  v_now      timestamptz := now();
  v_current  bigint;
begin
  perform public.require_admin();

  perform pg_advisory_xact_lock(hashtext('circa_tooltip_release:' || p_site));

  select * into v_old from public.releases where id = p_release_id and site_code = p_site;
  if not found then
    raise exception 'Không tìm thấy release % của site %', p_release_id, p_site using errcode = 'P0002';
  end if;

  select revision into v_current from public.release_heads where site_code = p_site;
  if v_current is not null and v_old.revision = v_current then
    raise exception 'Release này đang là bản hiện hành — không cần rollback' using errcode = '22023';
  end if;

  select coalesce(max(revision), 0) + 1 into v_revision from public.releases where site_code = p_site;

  v_payload := (v_old.payload - 'checksum')
    || jsonb_build_object(
         'revision', v_revision,
         'releasedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       );
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

  return jsonb_build_object('ok', true, 'site', p_site,
                            'head', coalesce(v_head, 'null'::jsonb), 'releases', v_rows);
end;
$$;

revoke all on function public.admin_list_releases(text) from public;
grant execute on function public.admin_list_releases(text) to authenticated;

-- =============================================================================
-- get_release  — đường tải payload của extension. anon + authenticated.
--
-- Trả về một hình dạng rỗng ổn định khi site chưa từng publish, để client chỉ có một
-- nhánh xử lý. `revision: 0` là quy ước "chưa có gì": client phải coi đây là "không có
-- release", không đưa nó qua validator như một release thật.
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

commit;
