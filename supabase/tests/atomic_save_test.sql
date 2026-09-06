-- =============================================================================
-- Circa Tool-tip - test cho admin_save_guide (migration 0005)
--
-- Chạy trọn trong MỘT transaction và ROLLBACK ở cuối: an toàn trên project thật, không
-- để lại gì, kể cả bản is_admin() bị stub.
--
-- Chạy trong Supabase SQL Editor SAU khi đã chạy 0005. Nếu SELECT cuối không in PASSED
-- thì đừng dùng editor để sửa dữ liệu thật.
--
-- Trọng tâm: mỗi lần lưu là một transaction. Khi validate hỏng, KHÔNG cột nào được đổi.
-- Ảnh chụp so sánh nguyên cả dòng bằng to_jsonb(), không chỉ vài cột, nên nếu RPC lỡ
-- ghi site/group/sort_order/notes/validation/audit thì test vẫn bắt được.
-- =============================================================================

begin;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select true $$;

create or replace function pg_temp.expect(p_cond boolean, p_label text)
returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then
    raise exception 'FAILED: %', p_label;
  end if;
end;
$$;

create or replace function pg_temp.expect_reject(p_sql text, p_label text, p_sqlstate text default null)
returns void language plpgsql as $$
declare
  v_state text;
  v_msg   text;
begin
  begin
    execute p_sql;
  exception
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_msg like 'FAILED:%' then raise; end if;
      if p_sqlstate is not null and v_state is distinct from p_sqlstate then
        raise exception 'FAILED: % - mong SQLSTATE %, nhận % (%)', p_label, p_sqlstate, v_state, v_msg;
      end if;
      return;
  end;
  raise exception 'FAILED: % (lẽ ra phải bị từ chối)', p_label;
end;
$$;

-- -----------------------------------------------------------------------------
-- Fixtures
-- -----------------------------------------------------------------------------
insert into public.sites (code, label, origin, sort_order) values
  ('pos',   'POS',   'https://pos.v2.circa.vn',   1),
  ('admin', 'Admin', 'https://admin.v2.circa.vn', 2)
on conflict (code) do nothing;

create temp table tg_ids (label text primary key, id uuid) on commit drop;
-- Lưu NGUYÊN dòng dưới dạng jsonb: mọi cột đều được so sánh, kể cả audit fields.
create temp table tg_before (label text primary key, row_json jsonb) on commit drop;

insert into public.guides (legacy_id, site_code, group_name, name, status, start_url, sort_order, notes, draft_steps, step_count)
values (
  'atomic_a', 'pos', 'Bán hàng', 'GUIDE ATOMIC A', 'draft', '/trang-chu', 10, 'ghi chú gốc',
  jsonb_build_array(
    jsonb_build_object('id','st_1','selectors',jsonb_build_array('button.a'),'matchText','A','tag','button',
      'title','b1','content','c1','urlPattern','/trang-chu','navigationUrl','/trang-chu',
      'action',jsonb_build_object('type','highlight','expectedUrl','','timeoutMs',0)),
    jsonb_build_object('id','st_2','selectors',jsonb_build_array('button.b'),'matchText','B','tag','button',
      'title','b2','content','c2','urlPattern','/ban-hang','navigationUrl','/ban-hang',
      'action',jsonb_build_object('type','highlight','expectedUrl','','timeoutMs',0))),
  2);

insert into public.guides (legacy_id, site_code, name, status, start_url, draft_steps, step_count)
values ('atomic_b', null, 'GUIDE ATOMIC B', 'unassigned', '/tai-khoan',
  jsonb_build_array(jsonb_build_object('id','st_b1','selectors',jsonb_build_array('a.x'),'matchText','X','tag','a',
    'title','t','content','c','urlPattern','/tai-khoan','navigationUrl','/tai-khoan',
    'action',jsonb_build_object('type','highlight','expectedUrl','','timeoutMs',0))), 1);

insert into tg_ids select 'a', id from public.guides where legacy_id = 'atomic_a';
insert into tg_ids select 'b', id from public.guides where legacy_id = 'atomic_b';

create or replace function pg_temp.snapshot(p_label text, p_id uuid)
returns void language plpgsql as $$
begin
  delete from tg_before where label = p_label;
  insert into tg_before select p_label, to_jsonb(g) from public.guides g where g.id = p_id;
end;
$$;

/** Đúng nghĩa "không đổi gì": so sánh toàn bộ cột của dòng. */
create or replace function pg_temp.unchanged(p_label text, p_id uuid)
returns boolean language sql stable as $$
  select b.row_json = to_jsonb(g) from tg_before b, public.guides g
  where b.label = p_label and g.id = p_id;
$$;

/** updated_at hiện tại, dùng làm baseline hợp lệ cho mỗi lời gọi. */
create or replace function pg_temp.ts(p_legacy text)
returns timestamptz language sql stable as $$
  select updated_at from public.guides where legacy_id = p_legacy;
$$;

-- Chứng minh chính bộ so sánh có tác dụng: đổi một cột KHÔNG nằm trong nhóm hay quên
-- (notes) thì unchanged() phải trả false.
select pg_temp.snapshot('selfcheck', (select id from tg_ids where label = 'a'));
update public.guides set notes = 'đổi tạm' where legacy_id = 'atomic_a';
select pg_temp.expect(not pg_temp.unchanged('selfcheck', (select id from tg_ids where label = 'a')),
  'bộ so sánh phát hiện được thay đổi ở cột notes');
update public.guides set notes = 'ghi chú gốc' where legacy_id = 'atomic_a';

-- =============================================================================
-- 1. Đường thành công: metadata và steps cùng được ghi
-- =============================================================================
select public.admin_save_guide(
  (select id from tg_ids where label = 'a'),
  '  GUIDE ATOMIC A ĐÃ SỬA  ', 'pos', '  Kho hàng  ', '/trang-chu-moi', 20, 'ghi chú QA',
  jsonb_build_array(jsonb_build_object('id','st_1','selectors',jsonb_build_array('button.moi'),
    'matchText','Mới','tag','button','title','b1 mới','content','c1','urlPattern','/trang-chu',
    'navigationUrl','/trang-chu','action',jsonb_build_object('type','highlight','expectedUrl','','timeoutMs',0))),
  jsonb_build_object('errors', jsonb_build_array(), 'warnings', jsonb_build_array(), 'flags', jsonb_build_array()),
  pg_temp.ts('atomic_a'));

select pg_temp.expect(
  (select name = 'GUIDE ATOMIC A ĐÃ SỬA' and group_name = 'Kho hàng' and start_url = '/trang-chu-moi'
          and sort_order = 20 and notes = 'ghi chú QA' and step_count = 1
          and jsonb_array_length(draft_steps) = 1
     from public.guides where legacy_id = 'atomic_a'),
  'metadata và steps cùng được ghi trong một lời gọi');

-- =============================================================================
-- 2. Timestamp cũ: KHÔNG cột nào đổi
-- =============================================================================
select pg_temp.snapshot('a2', (select id from tg_ids where label = 'a'));

select pg_temp.expect_reject(
  format($$ select public.admin_save_guide(%L, 'TÊN KHÁC', 'admin', 'Nhóm khác', '/x', 99, 'ghi chú khác',
              jsonb_build_array(), '{}'::jsonb, %L::timestamptz) $$,
         (select id from tg_ids where label = 'a'), '2020-01-01T00:00:00Z'),
  'lưu với timestamp cũ phải bị từ chối', '40001');

select pg_temp.expect(pg_temp.unchanged('a2', (select id from tg_ids where label = 'a')),
  'P0: timestamp cũ -> toàn bộ dòng KHÔNG đổi');

-- =============================================================================
-- 3. Timestamp null: bị từ chối, không phải bỏ qua guard
-- =============================================================================
select pg_temp.snapshot('a3', (select id from tg_ids where label = 'a'));

select pg_temp.expect_reject(
  format($$ select public.admin_save_guide(%L, 'GHI ĐÈ KHÔNG BASELINE', 'pos', '', '/x', 0, null,
              jsonb_build_array(), '{}'::jsonb, null) $$,
         (select id from tg_ids where label = 'a')),
  'P0: truyền timestamp null phải bị từ chối, không được ghi đè', '22023');

select pg_temp.expect(pg_temp.unchanged('a3', (select id from tg_ids where label = 'a')),
  'P0: timestamp null -> toàn bộ dòng KHÔNG đổi');

-- =============================================================================
-- 4. Tên rỗng: KHÔNG cột nào đổi (kịch bản partial save cũ)
-- =============================================================================
select pg_temp.snapshot('a4', (select id from tg_ids where label = 'a'));

select pg_temp.expect_reject(
  format($$ select public.admin_save_guide(%L, '   ', 'pos', '', '/x', 0, null,
              jsonb_build_array(jsonb_build_object('id','st_moi','selectors',jsonb_build_array('b.c'),
                'matchText','','tag','button','title','t','content','c','urlPattern','/x','navigationUrl','/x',
                'action',jsonb_build_object('type','highlight','expectedUrl','','timeoutMs',0))),
              '{}'::jsonb, (select updated_at from public.guides where legacy_id = 'atomic_a')) $$,
         (select id from tg_ids where label = 'a')),
  'tên rỗng phải bị từ chối', '22023');

select pg_temp.expect(pg_temp.unchanged('a4', (select id from tg_ids where label = 'a')),
  'P0: tên rỗng -> steps KHÔNG bị ghi trước, cả dòng giữ nguyên');

-- =============================================================================
-- 5. Step sai hình dạng: metadata không đổi
-- =============================================================================
select pg_temp.snapshot('a5', (select id from tg_ids where label = 'a'));

select pg_temp.expect_reject(
  format($$ select public.admin_save_guide(%L, 'TÊN HỢP LỆ', 'pos', 'Nhóm mới', '/khac', 7, 'note',
              jsonb_build_array(jsonb_build_object('id','st_hong','selectors',jsonb_build_array())),
              '{}'::jsonb, (select updated_at from public.guides where legacy_id = 'atomic_a')) $$,
         (select id from tg_ids where label = 'a')),
  'step thiếu action phải bị từ chối', '22023');

select pg_temp.expect(pg_temp.unchanged('a5', (select id from tg_ids where label = 'a')),
  'P0: step sai hình dạng -> metadata KHÔNG bị đổi');

-- =============================================================================
-- 6. unassigned + gán site -> draft
-- =============================================================================
select public.admin_save_guide(
  (select id from tg_ids where label = 'b'),
  'GUIDE ATOMIC B', 'admin', 'Quản trị', '/tai-khoan', 0, null,
  (select draft_steps from public.guides where legacy_id = 'atomic_b'),
  '{}'::jsonb, pg_temp.ts('atomic_b'));

select pg_temp.expect(
  (select status = 'draft' and site_code = 'admin' and group_name = 'Quản trị'
     from public.guides where legacy_id = 'atomic_b'),
  'gán site cho bộ unassigned thì chuyển sang draft');

-- =============================================================================
-- 7. Bộ đã phân loại không được bỏ trống site
-- =============================================================================
select pg_temp.snapshot('b7', (select id from tg_ids where label = 'b'));

select pg_temp.expect_reject(
  format($$ select public.admin_save_guide(%L, 'GUIDE ATOMIC B', null, '', '/tai-khoan', 0, null,
              (select draft_steps from public.guides where legacy_id = 'atomic_b'), '{}'::jsonb,
              (select updated_at from public.guides where legacy_id = 'atomic_b')) $$,
         (select id from tg_ids where label = 'b')),
  'bộ draft không được bỏ trống site', '22023');

select pg_temp.expect(pg_temp.unchanged('b7', (select id from tg_ids where label = 'b')),
  'bỏ trống site bị từ chối và không đổi gì');

-- =============================================================================
-- 8. Bộ published không được đổi site
-- =============================================================================
update public.guides set status = 'published' where legacy_id = 'atomic_a';
select pg_temp.snapshot('a8', (select id from tg_ids where label = 'a'));

select pg_temp.expect_reject(
  format($$ select public.admin_save_guide(%L, 'GUIDE ATOMIC A ĐÃ SỬA', 'admin', '', '/x', 0, null,
              (select draft_steps from public.guides where legacy_id = 'atomic_a'), '{}'::jsonb,
              (select updated_at from public.guides where legacy_id = 'atomic_a')) $$,
         (select id from tg_ids where label = 'a')),
  'bộ published không được đổi site', '22023');

select pg_temp.expect(pg_temp.unchanged('a8', (select id from tg_ids where label = 'a')),
  'đổi site bị từ chối và không đổi gì');

-- Vẫn sửa được nội dung của bộ published miễn là giữ nguyên site.
select public.admin_save_guide(
  (select id from tg_ids where label = 'a'),
  'GUIDE ATOMIC A PUBLISHED', 'pos', '', '/trang-chu', 0, null,
  (select draft_steps from public.guides where legacy_id = 'atomic_a'), '{}'::jsonb,
  pg_temp.ts('atomic_a'));

select pg_temp.expect(
  (select name = 'GUIDE ATOMIC A PUBLISHED' and status = 'published' and site_code = 'pos'
     from public.guides where legacy_id = 'atomic_a'),
  'bộ published vẫn sửa được nội dung khi giữ nguyên site');

-- =============================================================================
-- 9. Không tìm thấy, và phân quyền
-- =============================================================================
select pg_temp.expect_reject(
  $$ select public.admin_save_guide('00000000-0000-0000-0000-000000000000', 'X', 'pos', '', '/x', 0, null,
       jsonb_build_array(), '{}'::jsonb, now()) $$,
  'guide không tồn tại phải báo P0002', 'P0002');

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select false $$;

select pg_temp.expect_reject(
  format($$ select public.admin_save_guide(%L, 'X', 'pos', '', '/x', 0, null,
              jsonb_build_array(), '{}'::jsonb, now()) $$,
         (select id from tg_ids where label = 'a')),
  'không phải admin thì admin_save_guide bị từ chối', '42501');

select 'ALL ATOMIC SAVE TESTS PASSED' as result;

rollback;
