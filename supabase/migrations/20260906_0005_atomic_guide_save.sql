begin;

-- =============================================================================
-- Circa Tool-tip · 0005 · Lưu guide nguyên tử
--
-- 0001-0004 là baseline đã áp dụng, không sửa. File này chỉ THÊM một RPC.
--
-- Vì sao cần: editor từng lưu bằng hai lời gọi — admin_save_guide_steps rồi
-- admin_upsert_guide. Hai lời gọi là hai transaction, nên nếu lời thứ hai hỏng (tên
-- rỗng, mất mạng) thì steps đã commit còn metadata thì chưa, `updated_at` đã đổi trong
-- khi client vẫn giữ timestamp cũ, và lần lưu kế tiếp ăn 40001 vì chính lần lưu nửa
-- chừng đó. Một nút Save phải là một transaction.
--
-- admin_save_guide làm toàn bộ trong MỘT câu UPDATE, sau khi đã validate xong. Bất kỳ
-- raise nào cũng cuộn ngược cả hàm, nên không tồn tại trạng thái lưu một nửa.
-- =============================================================================

create or replace function public.admin_save_guide(
  p_guide_id            uuid,
  p_name                text,
  p_site                text,
  p_group_name          text,
  p_start_url           text,
  p_sort_order          integer,
  p_notes               text,
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
  v_current  public.guides%rowtype;
  v_shape    text;
  v_email    text;
  v_status   public.guide_status;
  v_new_time timestamptz;
  v_rows     integer;
begin
  perform public.require_admin();

  -- ------------------------------------------------------------------ validate
  -- Toàn bộ kiểm tra chạy TRƯỚC khi ghi. Nếu có gì sai thì không trường nào đổi.
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Tên bộ không được rỗng' using errcode = '22023';
  end if;

  v_shape := public.guide_steps_shape_error(p_steps);
  if v_shape is not null then
    raise exception '%', v_shape using errcode = '22023';
  end if;

  select * into v_current from public.guides where id = p_guide_id;
  if not found then
    raise exception 'Không tìm thấy guide %', p_guide_id using errcode = 'P0002';
  end if;

  if p_site is not null and not exists (select 1 from public.sites where code = p_site and enabled) then
    raise exception 'Site % không tồn tại hoặc đang tắt', p_site using errcode = '22023';
  end if;

  -- Đổi site của bộ đang published sẽ khiến release hiện hành mô tả sai nơi bộ đó chạy.
  if v_current.status = 'published' and p_site is distinct from v_current.site_code then
    raise exception 'Không đổi được site của bộ đang published — hãy chuyển về draft trước'
      using errcode = '22023';
  end if;

  -- Chỉ bộ còn trong hàng chờ phân loại mới được phép không có site (khớp CHECK
  -- guides_site_required). Bỏ site của một bộ đã phân loại là xoá thông tin, không phải
  -- sửa — muốn vậy phải chủ động chuyển về unassigned.
  if v_current.status <> 'unassigned' and p_site is null then
    raise exception 'Bộ đang ở trạng thái % nên bắt buộc phải có site', v_current.status
      using errcode = '22023';
  end if;

  -- Gán site chính là thứ đưa bộ ra khỏi hàng chờ phân loại.
  v_status := case
    when v_current.status = 'unassigned' and p_site is not null then 'draft'::public.guide_status
    else v_current.status
  end;

  select lower(trim(email)) into v_email from auth.users where id = auth.uid();

  -- ---------------------------------------------------------------- một UPDATE
  -- Điều kiện optimistic nằm ngay trong WHERE: không có khe hở giữa lúc so sánh và
  -- lúc ghi.
  update public.guides set
    name             = trim(p_name),
    site_code        = p_site,
    group_name       = coalesce(trim(p_group_name), ''),
    start_url        = coalesce(p_start_url, ''),
    sort_order       = coalesce(p_sort_order, 0),
    notes            = p_notes,
    status           = v_status,
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
    raise exception 'Bộ đã được người khác sửa lúc %. Hãy tải lại trước khi lưu.',
      (select updated_at from public.guides where id = p_guide_id)
      using errcode = '40001';
  end if;

  return jsonb_build_object(
    'ok', true,
    'guideId', p_guide_id,
    'stepCount', jsonb_array_length(p_steps),
    'status', v_status,
    'updatedAt', v_new_time
  );
end;
$$;

revoke all on function public.admin_save_guide(uuid, text, text, text, text, integer, text, jsonb, jsonb, timestamptz) from public;
grant execute on function public.admin_save_guide(uuid, text, text, text, text, integer, text, jsonb, jsonb, timestamptz) to authenticated;

commit;
