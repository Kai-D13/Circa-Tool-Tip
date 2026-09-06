begin;

-- =============================================================================
-- Circa Tool-tip · 0003 · Guide RPC (import, triage, CRUD)
--
-- Quy ước chung, kế thừa từ bộ RPC đã chạy production của circa-consult:
--   * language plpgsql, security definer, set search_path = public
--   * câu lệnh đầu tiên là guard is_admin(), raise errcode 42501
--   * type gate jsonb dùng `is distinct from`
--   * revoke from public, grant execute cho đúng role cần
-- =============================================================================
--
-- Chạy trọn trong một transaction: dừng giữa chừng thì không để lại trạng thái
-- nửa vời. (SQL Editor có thể cảnh báo "transaction already in progress" — vô hại.)


create or replace function public.require_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admin permission required' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.require_admin() from public;
grant execute on function public.require_admin() to authenticated;

-- =============================================================================
-- admin_import_legacy
--
-- Idempotent theo legacy_id. Guide đã được người duyệt phân loại (status khác
-- 'unassigned') thì BỎ QUA, không ghi đè: chạy lại importer không được phép xoá công
-- sức triage.
-- =============================================================================
create or replace function public.admin_import_legacy(
  p_payload         jsonb,
  p_source_filename text,
  p_checksum        text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guide       jsonb;
  v_legacy_id   text;
  v_steps       jsonb;
  v_step_count  integer;
  v_shape_error text;
  v_existing_id uuid;
  v_status      public.guide_status;
  v_inserted    integer := 0;
  v_updated     integer := 0;
  v_skipped     integer := 0;
  v_total_steps integer := 0;
  v_guide_count integer := 0;
  v_email       text;
begin
  perform public.require_admin();

  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'payload phải là object' using errcode = '22023';
  end if;
  if (p_payload ->> 'schemaVersion')::int is distinct from 5 then
    raise exception 'schemaVersion phải là 5' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload -> 'guides') is distinct from 'array' then
    raise exception 'payload.guides phải là mảng' using errcode = '22023';
  end if;

  -- Người gọi phải nói trước họ nghĩ mình đang import cái gì, và điều đó phải khớp với
  -- checksum nhúng trong chính artifact. BẮT BUỘC: truyền null sẽ không bỏ qua được
  -- kiểm tra, vì đây chính là thứ chứng minh ta đang import đúng file.
  if p_checksum is null or length(trim(p_checksum)) = 0 then
    raise exception 'Thiếu p_checksum — phải truyền contentChecksum của artifact'
      using errcode = '22023';
  end if;
  if p_checksum !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'p_checksum sai định dạng, cần sha256:<64 ký tự hex>' using errcode = '22023';
  end if;
  if (p_payload ->> 'contentChecksum') is distinct from p_checksum then
    raise exception 'contentChecksum không khớp: artifact ghi %, tham số truyền vào %',
      coalesce(p_payload ->> 'contentChecksum', '(thiếu)'), p_checksum using errcode = '22023';
  end if;

  select lower(trim(email)) into v_email from auth.users where id = auth.uid();

  for v_guide in select * from jsonb_array_elements(p_payload -> 'guides') loop
    v_guide_count := v_guide_count + 1;

    v_legacy_id := v_guide ->> 'legacyId';
    if v_legacy_id is null or length(trim(v_legacy_id)) = 0 then
      raise exception 'Guide thứ % thiếu legacyId', v_guide_count using errcode = '22023';
    end if;

    v_steps := coalesce(v_guide -> 'steps', '[]'::jsonb);
    v_shape_error := public.guide_steps_shape_error(v_steps);
    if v_shape_error is not null then
      raise exception 'Guide % (%): %', v_guide_count, v_guide ->> 'name', v_shape_error
        using errcode = '22023';
    end if;

    v_step_count := jsonb_array_length(v_steps);
    v_total_steps := v_total_steps + v_step_count;

    select id, status into v_existing_id, v_status
    from public.guides where legacy_id = v_legacy_id;

    if v_existing_id is null then
      insert into public.guides (
        legacy_id, site_code, group_name, name, status, start_url, sort_order,
        draft_steps, step_count, validation, site_guess, site_evidence,
        created_by, created_by_email, updated_by, updated_by_email
      ) values (
        v_legacy_id,
        null,                                   -- Plan v1.1 §P0-5: người duyệt gán site
        '',
        coalesce(nullif(trim(v_guide ->> 'name'), ''), 'Bộ không tên ' || v_legacy_id),
        'unassigned',
        coalesce(v_guide ->> 'startUrl', ''),
        coalesce((v_guide ->> 'sortOrder')::int, 0),
        v_steps,
        v_step_count,
        coalesce(v_guide -> 'validation', '{}'::jsonb)
          || jsonb_build_object('flags', coalesce(v_guide -> 'flags', '[]'::jsonb)),
        v_guide ->> 'siteGuess',
        coalesce(v_guide -> 'siteEvidence', '{}'::jsonb),
        auth.uid(), v_email, auth.uid(), v_email
      );
      v_inserted := v_inserted + 1;

    elsif v_status = 'unassigned' then
      update public.guides set
        name          = coalesce(nullif(trim(v_guide ->> 'name'), ''), name),
        start_url     = coalesce(v_guide ->> 'startUrl', start_url),
        sort_order    = coalesce((v_guide ->> 'sortOrder')::int, sort_order),
        draft_steps   = v_steps,
        step_count    = v_step_count,
        validation    = coalesce(v_guide -> 'validation', '{}'::jsonb)
                          || jsonb_build_object('flags', coalesce(v_guide -> 'flags', '[]'::jsonb)),
        site_guess    = v_guide ->> 'siteGuess',
        site_evidence = coalesce(v_guide -> 'siteEvidence', '{}'::jsonb),
        updated_by    = auth.uid(),
        updated_by_email = v_email,
        updated_at    = clock_timestamp()
      where id = v_existing_id;
      v_updated := v_updated + 1;

    else
      v_skipped := v_skipped + 1;   -- đã được người duyệt xử lý, không đụng vào
    end if;
  end loop;

  -- Đối soát: artifact khai bao nhiêu thì phải ghi đúng bấy nhiêu.
  if (p_payload -> 'stats' ->> 'guides') is not null
     and (p_payload -> 'stats' ->> 'guides')::int is distinct from v_guide_count then
    raise exception 'Sai lệch số guide: payload nói %, xử lý %',
      p_payload -> 'stats' ->> 'guides', v_guide_count using errcode = '22023';
  end if;
  if (p_payload -> 'stats' ->> 'steps') is not null
     and (p_payload -> 'stats' ->> 'steps')::int is distinct from v_total_steps then
    raise exception 'Sai lệch số step: payload nói %, xử lý %',
      p_payload -> 'stats' ->> 'steps', v_total_steps using errcode = '22023';
  end if;

  return jsonb_build_object(
    'ok', true,
    'sourceFilename', p_source_filename,
    'contentChecksum', p_payload ->> 'contentChecksum',
    'guides', v_guide_count,
    'steps', v_total_steps,
    'inserted', v_inserted,
    'updated', v_updated,
    'skippedBecauseTriaged', v_skipped,
    'unassignedRemaining', (select count(*) from public.guides where status = 'unassigned')
  );
end;
$$;

revoke all on function public.admin_import_legacy(jsonb, text, text) from public;
grant execute on function public.admin_import_legacy(jsonb, text, text) to authenticated;

-- =============================================================================
-- admin_list_guides
-- =============================================================================
create or replace function public.admin_list_guides(
  p_site   text default null,
  p_group  text default null,
  p_status text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.require_admin();

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.sort_order, t.name), '[]'::jsonb)
  into v_rows
  from (
    select
      g.id, g.legacy_id, g.site_code, g.group_name, g.name, g.status,
      g.start_url, g.sort_order, g.step_count, g.validation,
      g.site_guess, g.site_evidence, g.notes, g.updated_at
    from public.guides g
    where (p_site   is null or g.site_code = p_site)
      and (p_group  is null or g.group_name = p_group)
      and (p_status is null or g.status = p_status::public.guide_status)
  ) t;

  return jsonb_build_object(
    'ok', true,
    'guides', v_rows,
    'counts', jsonb_build_object(
      'total',      (select count(*) from public.guides),
      'unassigned', (select count(*) from public.guides where status = 'unassigned'),
      'draft',      (select count(*) from public.guides where status = 'draft'),
      'published',  (select count(*) from public.guides where status = 'published'),
      'archived',   (select count(*) from public.guides where status = 'archived')
    )
  );
end;
$$;

revoke all on function public.admin_list_guides(text, text, text) from public;
grant execute on function public.admin_list_guides(text, text, text) to authenticated;

-- =============================================================================
-- admin_get_guide
-- =============================================================================
create or replace function public.admin_get_guide(p_guide_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_guide jsonb;
begin
  perform public.require_admin();

  select row_to_json(g)::jsonb into v_guide from public.guides g where g.id = p_guide_id;
  if v_guide is null then
    raise exception 'Không tìm thấy guide %', p_guide_id using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'ok', true,
    'guide', v_guide,
    'publishError', public.guide_publish_error(p_guide_id)
  );
end;
$$;

revoke all on function public.admin_get_guide(uuid) from public;
grant execute on function public.admin_get_guide(uuid) to authenticated;

-- =============================================================================
-- admin_upsert_guide  (metadata; step đi qua admin_save_guide_steps)
-- =============================================================================
create or replace function public.admin_upsert_guide(
  p_guide_id   uuid,
  p_name       text,
  p_site       text default null,
  -- null nghĩa là "giữ nguyên nhóm hiện tại"; truyền '' để xoá nhóm. Mặc định '' sẽ
  -- lặng lẽ xoá nhóm mỗi lần sửa metadata mà không gửi kèm trường này.
  p_group_name text default null,
  p_start_url  text default '',
  p_sort_order integer default 0,
  p_notes      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_email   text;
  v_status  public.guide_status;
  v_current text;
begin
  perform public.require_admin();

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Tên bộ không được rỗng' using errcode = '22023';
  end if;
  if p_site is not null and not exists (select 1 from public.sites where code = p_site and enabled) then
    raise exception 'Site % không tồn tại hoặc đang tắt', p_site using errcode = '22023';
  end if;

  select lower(trim(email)) into v_email from auth.users where id = auth.uid();

  if p_guide_id is null then
    insert into public.guides (
      name, site_code, group_name, start_url, sort_order, notes,
      status, created_by, created_by_email, updated_by, updated_by_email
    ) values (
      trim(p_name), p_site, coalesce(trim(p_group_name), ''), coalesce(p_start_url, ''),
      coalesce(p_sort_order, 0), p_notes,
      -- Cả hai nhánh phải được ép kiểu tường minh: nếu cả hai đều là literal `unknown`,
      -- Postgres suy ra `text` và INSERT vào cột enum sẽ hỏng với 42804.
      case
        when p_site is null then 'unassigned'::public.guide_status
        else 'draft'::public.guide_status
      end,
      auth.uid(), v_email, auth.uid(), v_email
    )
    returning id into v_id;
  else
    select status, site_code into v_status, v_current from public.guides where id = p_guide_id;
    if not found then
      raise exception 'Không tìm thấy guide %', p_guide_id using errcode = 'P0002';
    end if;

    -- Đổi site của một guide đang published sẽ khiến release hiện hành mô tả sai nơi
    -- guide đó chạy. Bắt archive hoặc hạ về draft trước.
    if v_status = 'published' and p_site is not null and p_site is distinct from v_current then
      raise exception 'Không đổi được site của bộ đang published — hãy chuyển về draft trước'
        using errcode = '22023';
    end if;

    update public.guides set
      name       = trim(p_name),
      site_code  = coalesce(p_site, site_code),
      group_name = coalesce(trim(p_group_name), group_name),
      start_url  = coalesce(p_start_url, start_url),
      sort_order = coalesce(p_sort_order, sort_order),
      notes      = p_notes,
      updated_by = auth.uid(),
      updated_by_email = v_email,
      updated_at = clock_timestamp()
    where id = p_guide_id
    returning id into v_id;
  end if;

  return jsonb_build_object('ok', true, 'guideId', v_id);
end;
$$;

revoke all on function public.admin_upsert_guide(uuid, text, text, text, text, integer, text) from public;
grant execute on function public.admin_upsert_guide(uuid, text, text, text, text, integer, text) to authenticated;

-- =============================================================================
-- admin_save_guide_steps
--
-- Optimistic concurrency phải ATOMIC (audit P0-1). Bản trước SELECT rồi so sánh rồi
-- UPDATE theo id — hai request đồng thời cùng vượt qua bước so sánh và request sau ghi
-- đè request trước. Điều kiện updated_at nằm ngay trong mệnh đề WHERE của UPDATE, và
-- kết quả được xác nhận bằng ROW_COUNT.
-- =============================================================================
create or replace function public.admin_save_guide_steps(
  p_guide_id            uuid,
  p_steps               jsonb,
  p_validation          jsonb default '{}'::jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shape    text;
  v_email    text;
  v_new_time timestamptz;
  v_rows     integer;
  v_current  timestamptz;
begin
  perform public.require_admin();

  v_shape := public.guide_steps_shape_error(p_steps);
  if v_shape is not null then
    raise exception '%', v_shape using errcode = '22023';
  end if;

  select lower(trim(email)) into v_email from auth.users where id = auth.uid();

  update public.guides set
    draft_steps      = p_steps,
    step_count       = jsonb_array_length(p_steps),
    validation       = coalesce(p_validation, '{}'::jsonb),
    updated_by       = auth.uid(),
    updated_by_email = v_email,
    updated_at       = clock_timestamp()
  where id = p_guide_id
    and (p_expected_updated_at is null or updated_at = p_expected_updated_at)
  returning updated_at into v_new_time;

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    select updated_at into v_current from public.guides where id = p_guide_id;
    if v_current is null then
      raise exception 'Không tìm thấy guide %', p_guide_id using errcode = 'P0002';
    end if;
    raise exception 'Bộ đã được người khác sửa lúc %. Hãy tải lại trước khi lưu.', v_current
      using errcode = '40001';
  end if;

  return jsonb_build_object(
    'ok', true, 'guideId', p_guide_id,
    'stepCount', jsonb_array_length(p_steps),
    'updatedAt', v_new_time
  );
end;
$$;

revoke all on function public.admin_save_guide_steps(uuid, jsonb, jsonb, timestamptz) from public;
grant execute on function public.admin_save_guide_steps(uuid, jsonb, jsonb, timestamptz) to authenticated;

-- =============================================================================
-- admin_assign_guide_site  — một lời gọi hẹp cho màn triage
-- =============================================================================
create or replace function public.admin_assign_guide_site(
  p_guide_id   uuid,
  p_site       text,
  p_group_name text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email  text;
  v_status public.guide_status;
begin
  perform public.require_admin();

  if not exists (select 1 from public.sites where code = p_site and enabled) then
    raise exception 'Site % không tồn tại hoặc đang tắt', p_site using errcode = '22023';
  end if;

  select status into v_status from public.guides where id = p_guide_id;
  if v_status is null then
    raise exception 'Không tìm thấy guide %', p_guide_id using errcode = 'P0002';
  end if;
  if v_status = 'published' then
    raise exception 'Không đổi được site của bộ đang published — hãy chuyển về draft trước'
      using errcode = '22023';
  end if;

  select lower(trim(email)) into v_email from auth.users where id = auth.uid();

  update public.guides set
    site_code  = p_site,
    group_name = coalesce(trim(p_group_name), ''),
    -- Gán site chính là thứ đưa guide ra khỏi hàng chờ phân loại.
    status     = case when status = 'unassigned' then 'draft'::public.guide_status else status end,
    updated_by = auth.uid(),
    updated_by_email = v_email,
    updated_at = clock_timestamp()
  where id = p_guide_id;

  return jsonb_build_object(
    'ok', true,
    'guideId', p_guide_id,
    'site', p_site,
    'unassignedRemaining', (select count(*) from public.guides where status = 'unassigned')
  );
end;
$$;

revoke all on function public.admin_assign_guide_site(uuid, text, text) from public;
grant execute on function public.admin_assign_guide_site(uuid, text, text) to authenticated;

-- =============================================================================
-- admin_set_guide_status
-- =============================================================================
create or replace function public.admin_set_guide_status(p_guide_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_error text;
  v_email text;
begin
  perform public.require_admin();

  if p_status not in ('unassigned', 'draft', 'published', 'archived') then
    raise exception 'Trạng thái % không hợp lệ', p_status using errcode = '22023';
  end if;

  if not exists (select 1 from public.guides where id = p_guide_id) then
    raise exception 'Không tìm thấy guide %', p_guide_id using errcode = 'P0002';
  end if;

  -- Đánh dấu published nghĩa là "cho vào release lần tới", nên kiểm tra ngay tại đây
  -- thay vì để publish cả site đổ vỡ sau (audit P0-3).
  if p_status = 'published' then
    v_error := public.guide_publish_error(p_guide_id);
    if v_error is not null then
      raise exception 'Chưa thể publish — %', v_error using errcode = '22023';
    end if;
  end if;

  select lower(trim(email)) into v_email from auth.users where id = auth.uid();

  update public.guides set
    status = p_status::public.guide_status,
    updated_by = auth.uid(), updated_by_email = v_email, updated_at = clock_timestamp()
  where id = p_guide_id;

  return jsonb_build_object('ok', true, 'guideId', p_guide_id, 'status', p_status);
end;
$$;

revoke all on function public.admin_set_guide_status(uuid, text) from public;
grant execute on function public.admin_set_guide_status(uuid, text) to authenticated;

-- =============================================================================
-- admin_delete_guide  — từ chối khi đang published
-- =============================================================================
create or replace function public.admin_delete_guide(p_guide_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.guide_status;
  v_name   text;
begin
  perform public.require_admin();

  select status, name into v_status, v_name from public.guides where id = p_guide_id;
  if v_status is null then
    raise exception 'Không tìm thấy guide %', p_guide_id using errcode = 'P0002';
  end if;
  if v_status = 'published' then
    raise exception 'Bộ "%" đang published — hãy archive trước khi xoá', v_name using errcode = '22023';
  end if;

  delete from public.guides where id = p_guide_id;
  return jsonb_build_object('ok', true, 'guideId', p_guide_id, 'name', v_name);
end;
$$;

revoke all on function public.admin_delete_guide(uuid) from public;
grant execute on function public.admin_delete_guide(uuid) to authenticated;

commit;
