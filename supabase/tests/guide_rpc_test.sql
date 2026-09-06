-- =============================================================================
-- Circa Tool-tip - RPC test suite
--
-- Chạy trọn trong MỘT transaction và ROLLBACK ở cuối, nên an toàn để chạy trên chính
-- project thật: không để lại gì, kể cả bản is_admin() bị stub.
--
-- Chạy trong Supabase SQL Editor SAU 0001-0004. Đây là bằng chứng, không phải trang
-- trí: nếu SELECT cuối cùng không in PASSED thì có gì đó sai và chưa được import gì cả.
--
-- expect_reject kiểm tra SQLSTATE mong đợi chứ không chấp nhận mọi exception - nếu
-- không, một lỗi cú pháp trong chính câu test cũng sẽ được tính là pass.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Stub predicate phân quyền. Mọi admin RPC chạy với `search_path = public` nên chúng
-- resolve đúng định nghĩa này. Được hoàn tác cùng transaction.
-- -----------------------------------------------------------------------------
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

-- =============================================================================
-- 1. Import
-- =============================================================================
select public.admin_import_legacy(
  jsonb_build_object(
    'schemaVersion', 5,
    'contentChecksum', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'stats', jsonb_build_object('guides', 2, 'steps', 3),
    'guides', jsonb_build_array(
      jsonb_build_object(
        'legacyId', 'test_guide_a', 'name', 'GUIDE A', 'startUrl', '/trang-chu',
        'sortOrder', 10, 'siteGuess', 'pos',
        'siteEvidence', jsonb_build_object('confidence', 'high'),
        'flags', jsonb_build_array('SEL_NTH_OF_TYPE'),
        'validation', jsonb_build_object('errors', jsonb_build_array(), 'warnings', jsonb_build_array()),
        'steps', jsonb_build_array(
          jsonb_build_object(
            'id', 'st_a1', 'selectors', jsonb_build_array('button.primary'),
            'matchText', 'Ban tai quay', 'tag', 'button', 'title', 'b1', 'content', 'c1',
            'urlPattern', '/trang-chu', 'navigationUrl', '/trang-chu',
            'action', jsonb_build_object('type', 'auto_click_wait_url', 'expectedUrl', '/ban-hang', 'timeoutMs', 0)
          ),
          jsonb_build_object(
            'id', 'st_a2', 'selectors', jsonb_build_array('#san-pham'),
            'matchText', '', 'tag', 'input', 'title', 'b2', 'content', 'c2',
            'urlPattern', '/ban-hang', 'navigationUrl', '/ban-hang',
            'action', jsonb_build_object('type', 'highlight', 'expectedUrl', '', 'timeoutMs', 0)
          )
        )
      ),
      jsonb_build_object(
        'legacyId', 'test_guide_b', 'name', 'GUIDE B', 'startUrl', '/tai-khoan',
        'sortOrder', 20, 'siteGuess', 'admin',
        'siteEvidence', jsonb_build_object('confidence', 'high'),
        'validation', jsonb_build_object('errors', jsonb_build_array(), 'warnings', jsonb_build_array()),
        'steps', jsonb_build_array(
          jsonb_build_object(
            'id', 'st_b1', 'selectors', jsonb_build_array('a.voucher'),
            'matchText', 'Voucher', 'tag', 'a', 'title', 'b1', 'content', 'c1',
            'urlPattern', '/quan-ly-voucher', 'navigationUrl', '/quan-ly-voucher',
            'action', jsonb_build_object('type', 'highlight', 'expectedUrl', '', 'timeoutMs', 0)
          )
        )
      )
    )
  ),
  'test-fixture.json',
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);

select pg_temp.expect(
  (select count(*) from public.guides where legacy_id in ('test_guide_a', 'test_guide_b')) = 2,
  'import tạo đúng 2 guide');

select pg_temp.expect(
  (select count(*) from public.guides
    where legacy_id in ('test_guide_a', 'test_guide_b') and status = 'unassigned' and site_code is null) = 2,
  'P0-5: guide nhập vào phải unassigned và chưa có site');

select pg_temp.expect(
  (select step_count from public.guides where legacy_id = 'test_guide_a') = 2,
  'step_count được tính đúng');

-- P1: checksum truyền vào phải khớp checksum nhúng trong artifact.
select pg_temp.expect_reject($$
  select public.admin_import_legacy(
    jsonb_build_object('schemaVersion', 5, 'contentChecksum', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'stats', jsonb_build_object('guides', 0, 'steps', 0),
      'guides', jsonb_build_array()),
    'x.json', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
$$, 'import với checksum lệch phải bị từ chối', '22023');

select pg_temp.expect_reject($$
  select public.admin_import_legacy(
    jsonb_build_object('schemaVersion', 5, 'guides', jsonb_build_array()),
    'x.json', null)
$$, 'thiếu p_checksum phải bị từ chối', '22023');

select pg_temp.expect_reject($$
  select public.admin_import_legacy(
    jsonb_build_object('schemaVersion', 5, 'guides', jsonb_build_array()),
    'x.json', 'khong-phai-sha256')
$$, 'p_checksum sai định dạng phải bị từ chối', '22023');

select pg_temp.expect_reject($$
  select public.admin_import_legacy(
    jsonb_build_object('schemaVersion', 5, 'contentChecksum', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'stats', jsonb_build_object('guides', 99, 'steps', 99),
      'guides', jsonb_build_array()),
    'bad.json', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
$$, 'import với stats sai phải bị từ chối', '22023');

select pg_temp.expect_reject($$
  select public.admin_import_legacy(
    jsonb_build_object('schemaVersion', 5, 'contentChecksum', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'guides', jsonb_build_array(jsonb_build_object(
        'legacyId', 'test_bad', 'name', 'BAD', 'startUrl', '/x',
        'steps', jsonb_build_array(jsonb_build_object('id', 'st_x', 'selectors', jsonb_build_array()))))),
    'bad.json', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
$$, 'step thiếu action phải bị từ chối', '22023');

-- Chạy lại import không được nhân bản.
select public.admin_import_legacy(
  jsonb_build_object('schemaVersion', 5, 'contentChecksum', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'stats', jsonb_build_object('guides', 1, 'steps', 1),
    'guides', jsonb_build_array(jsonb_build_object(
      'legacyId', 'test_guide_b', 'name', 'GUIDE B', 'startUrl', '/tai-khoan',
      'steps', jsonb_build_array(jsonb_build_object(
        'id', 'st_b1', 'selectors', jsonb_build_array('a.voucher'),
        'matchText', 'Voucher', 'tag', 'a', 'title', 'b1', 'content', 'c1',
        'urlPattern', '/quan-ly-voucher', 'navigationUrl', '/quan-ly-voucher',
        'action', jsonb_build_object('type', 'highlight', 'expectedUrl', '', 'timeoutMs', 0)))))),
  'test-fixture.json', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

select pg_temp.expect(
  (select count(*) from public.guides where legacy_id = 'test_guide_b') = 1,
  'import lại không nhân bản guide');

-- =============================================================================
-- 2. CHECK constraint về site
-- =============================================================================
select pg_temp.expect_reject(
  format($$ update public.guides set status = 'published' where id = %L $$,
         (select id from public.guides where legacy_id = 'test_guide_a')),
  'CHECK: không thể publish guide chưa có site', '23514');

-- =============================================================================
-- 3. Triage
-- =============================================================================
select public.admin_assign_guide_site(
  (select id from public.guides where legacy_id = 'test_guide_a'), 'pos', 'Bán hàng');

select pg_temp.expect(
  (select site_code = 'pos' and status = 'draft' and group_name = 'Bán hàng'
     from public.guides where legacy_id = 'test_guide_a'),
  'gán site chuyển guide từ unassigned sang draft');

select pg_temp.expect_reject(
  format($$ select public.admin_assign_guide_site(%L, 'khong-ton-tai', '') $$,
         (select id from public.guides where legacy_id = 'test_guide_b')),
  'gán site không tồn tại phải bị từ chối', '22023');

-- =============================================================================
-- 4. P0-1 - optimistic concurrency phải ATOMIC
-- =============================================================================
-- Kịch bản thật: A và B cùng đọc guide, A lưu trước, rồi B lưu bằng timestamp mà B đã
-- đọc. Phải GIỮ LẠI timestamp thật - dùng một giá trị cứng thì bản SELECT-rồi-UPDATE cũ
-- cũng "pass" và test chẳng chứng minh được gì.
--
-- guides.updated_at ghi bằng clock_timestamp() chứ không phải now(): now() cố định suốt
-- một transaction, nên hai lần lưu trong cùng transaction sẽ trùng timestamp và phép
-- kiểm tra xung đột trở nên vô nghĩa.
create temp table tg_seen (label text primary key, ts timestamptz) on commit drop;

insert into tg_seen
select 'B_doc_luc_dau', updated_at from public.guides where legacy_id = 'test_guide_a';

select pg_temp.expect_reject(
  format($$ select public.admin_save_guide_steps(%L, '[]'::jsonb, '{}'::jsonb, %L::timestamptz) $$,
         (select id from public.guides where legacy_id = 'test_guide_a'),
         '2000-01-01T00:00:00Z'),
  'ghi đè bằng updated_at cũ phải bị từ chối', '40001');

-- A lưu trước, bằng đúng timestamp đang có.
select public.admin_save_guide_steps(
  (select id from public.guides where legacy_id = 'test_guide_a'),
  (select draft_steps from public.guides where legacy_id = 'test_guide_a'),
  jsonb_build_object('errors', jsonb_build_array(), 'warnings', jsonb_build_array()),
  (select updated_at from public.guides where legacy_id = 'test_guide_a'));

select pg_temp.expect(
  (select step_count from public.guides where legacy_id = 'test_guide_a') = 2,
  'lưu với updated_at đúng thì thành công');

select pg_temp.expect(
  (select updated_at from public.guides where legacy_id = 'test_guide_a')
    > (select ts from tg_seen where label = 'B_doc_luc_dau'),
  'updated_at thực sự tăng sau khi lưu (clock_timestamp, không phải now)');

-- B lưu bằng timestamp đã đọc lúc đầu -> phải bị từ chối.
select pg_temp.expect_reject(
  format($$ select public.admin_save_guide_steps(%L, '[]'::jsonb, '{}'::jsonb, %L::timestamptz) $$,
         (select id from public.guides where legacy_id = 'test_guide_a'),
         (select ts from tg_seen where label = 'B_doc_luc_dau')),
  'P0-1: lưu bằng timestamp đã đọc trước đó phải bị từ chối', '40001');

select pg_temp.expect(
  (select step_count from public.guides where legacy_id = 'test_guide_a') = 2,
  'P0-1: lần lưu bị từ chối không được ghi đè dữ liệu');

select pg_temp.expect_reject(
  format($$ select public.admin_save_guide_steps(%L, '[]'::jsonb, '{}'::jsonb, null) $$,
         '00000000-0000-0000-0000-000000000000'),
  'lưu vào guide không tồn tại phải báo not found', 'P0002');

-- =============================================================================
-- 5. P0-3 - publish phải từ chối dữ liệu mà extension sẽ không nhận
-- =============================================================================
-- Guide không có bước nào.
select public.admin_upsert_guide(null, 'GUIDE RỖNG', 'pos', '', '/trang-chu', 30, null);

select pg_temp.expect_reject(
  format($$ select public.admin_set_guide_status(%L, 'published') $$,
         (select id from public.guides where name = 'GUIDE RỖNG')),
  'P0-3: không publish được guide không có bước', '22023');

-- Guide còn lỗi validate.
select public.admin_save_guide_steps(
  (select id from public.guides where name = 'GUIDE RỖNG'),
  jsonb_build_array(jsonb_build_object(
    'id', 'st_e1', 'selectors', jsonb_build_array('button.x'),
    'matchText', 'X', 'tag', 'button', 'title', 't', 'content', 'c',
    'urlPattern', '/trang-chu', 'navigationUrl', '/trang-chu',
    'action', jsonb_build_object('type', 'highlight', 'expectedUrl', '', 'timeoutMs', 0))),
  jsonb_build_object('errors', jsonb_build_array('Bước 1: hỏng'), 'warnings', jsonb_build_array()),
  null);

select pg_temp.expect_reject(
  format($$ select public.admin_set_guide_status(%L, 'published') $$,
         (select id from public.guides where name = 'GUIDE RỖNG')),
  'P0-3: không publish được guide còn lỗi validate', '22023');

-- Guide có step trỏ tới site không tồn tại.
select public.admin_save_guide_steps(
  (select id from public.guides where name = 'GUIDE RỖNG'),
  jsonb_build_array(jsonb_build_object(
    'id', 'st_e1', 'siteOverride', 'khong-co-that',
    'selectors', jsonb_build_array('button.x'),
    'matchText', 'X', 'tag', 'button', 'title', 't', 'content', 'c',
    'urlPattern', '/trang-chu', 'navigationUrl', '/trang-chu',
    'action', jsonb_build_object('type', 'highlight', 'expectedUrl', '', 'timeoutMs', 0))),
  jsonb_build_object('errors', jsonb_build_array(), 'warnings', jsonb_build_array()),
  null);

select pg_temp.expect_reject(
  format($$ select public.admin_set_guide_status(%L, 'published') $$,
         (select id from public.guides where name = 'GUIDE RỖNG')),
  'P0-3: không publish được guide có siteOverride không tồn tại', '22023');

select public.admin_delete_guide((select id from public.guides where name = 'GUIDE RỖNG'));

-- =============================================================================
-- 6. Publish
-- =============================================================================
select public.admin_set_guide_status(
  (select id from public.guides where legacy_id = 'test_guide_a'), 'published');

select pg_temp.expect_reject(
  $$ select public.admin_publish_site('admin', 'không có guide nào') $$,
  'publish site không có guide published phải bị từ chối', '22023');

select public.admin_publish_site('pos', 'release thử');

select pg_temp.expect(
  (select revision from public.release_heads where site_code = 'pos') = 1,
  'release đầu tiên có revision 1');

select pg_temp.expect(
  (select guide_count from public.release_heads where site_code = 'pos') = 1,
  'release chứa đúng 1 guide');

-- P0-5: mọi step trong release phải có site.
select pg_temp.expect(
  (select bool_and((s ->> 'site') = 'pos')
     from public.releases r,
          jsonb_array_elements(r.payload -> 'guides') g,
          jsonb_array_elements(g -> 'steps') s
    where r.site_code = 'pos'),
  'P0-5: mọi step trong release đều có site');

select pg_temp.expect(
  (select bool_and(not (s ? 'flags') and not (s ? 'siteOverride'))
     from public.releases r,
          jsonb_array_elements(r.payload -> 'guides') g,
          jsonb_array_elements(g -> 'steps') s
    where r.site_code = 'pos'),
  'release không mang theo flags/siteOverride');

select pg_temp.expect(
  (select payload -> 'sites' ->> 'admin' = 'https://admin.v2.circa.vn'
     from public.releases where site_code = 'pos' and revision = 1),
  'release mang bản đồ origin của cả hai site');

select pg_temp.expect(
  (select payload -> 'groups' = jsonb_build_array('Bán hàng')
     from public.releases where site_code = 'pos' and revision = 1),
  'nhóm được gom từ nhãn group_name');

select pg_temp.expect(
  (select checksum = 'sha256:' || encode(sha256(convert_to((payload - 'checksum')::text, 'UTF8')), 'hex')
     from public.releases where site_code = 'pos' and revision = 1),
  'checksum khớp với payload đã bỏ trường checksum');

-- P0-2 không còn tồn tại: release build thẳng từ draft nên nội dung mới luôn đi kèm
-- revision mới. Sửa draft rồi publish lại phải cho ra payload khác.
select public.admin_save_guide_steps(
  (select id from public.guides where legacy_id = 'test_guide_a'),
  jsonb_build_array(jsonb_build_object(
    'id', 'st_a1', 'selectors', jsonb_build_array('button.doi-roi'),
    'matchText', 'Đã đổi', 'tag', 'button', 'title', 'b1', 'content', 'c1',
    'urlPattern', '/trang-chu', 'navigationUrl', '/trang-chu',
    'action', jsonb_build_object('type', 'highlight', 'expectedUrl', '', 'timeoutMs', 0))),
  jsonb_build_object('errors', jsonb_build_array(), 'warnings', jsonb_build_array()),
  null);

select public.admin_publish_site('pos', 'release sau khi sửa draft');

select pg_temp.expect(
  (select revision from public.release_heads where site_code = 'pos') = 2,
  'release thứ hai có revision 2');

select pg_temp.expect(
  (select payload -> 'guides' -> 0 -> 'steps' -> 0 ->> 'matchText'
     from public.releases where site_code = 'pos' and revision = 2) = 'Đã đổi',
  'release mới chứa đúng nội dung draft mới nhất');

-- =============================================================================
-- 7. Rollback - revision không bao giờ lùi
-- =============================================================================
select public.admin_rollback_site(
  'pos', (select id from public.releases where site_code = 'pos' and revision = 1));

select pg_temp.expect(
  (select revision from public.release_heads where site_code = 'pos') = 3,
  'P0-4: rollback tạo revision MỚI CAO HƠN, không lùi số');

select pg_temp.expect(
  (select rolled_back_from is not null from public.releases where site_code = 'pos' and revision = 3),
  'release rollback ghi lại nguồn gốc');

select pg_temp.expect(
  (select (payload ->> 'revision')::bigint from public.releases where site_code = 'pos' and revision = 3) = 3,
  'revision bên trong payload khớp với cột revision');

select pg_temp.expect(
  (select payload -> 'guides' -> 0 -> 'steps' -> 0 ->> 'matchText'
     from public.releases where site_code = 'pos' and revision = 3) = 'Ban tai quay',
  'rollback thực sự khôi phục nội dung cũ');

select pg_temp.expect_reject(
  format($$ select public.admin_rollback_site('pos', %L) $$,
         (select release_id from public.release_heads where site_code = 'pos')),
  'rollback về chính bản đang chạy phải bị từ chối', '22023');

-- =============================================================================
-- 8. get_release
-- =============================================================================
select pg_temp.expect(
  (public.get_release('pos') ->> 'revision')::bigint = 3,
  'get_release trả về bản đang chạy');

select pg_temp.expect(
  (public.get_release('khong-ton-tai') ->> 'revision')::bigint = 0,
  'get_release trả shape rỗng ổn định cho site chưa publish');

-- =============================================================================
-- 9. Guard xoá và đổi site khi đang published
-- =============================================================================
select pg_temp.expect_reject(
  format($$ select public.admin_delete_guide(%L) $$,
         (select id from public.guides where legacy_id = 'test_guide_a')),
  'không xoá được guide đang published', '22023');

select pg_temp.expect_reject(
  format($$ select public.admin_assign_guide_site(%L, 'admin', '') $$,
         (select id from public.guides where legacy_id = 'test_guide_a')),
  'không đổi được site của guide đang published', '22023');

-- =============================================================================
-- 10. Phân quyền
-- =============================================================================
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select false $$;

select pg_temp.expect_reject(
  $$ select public.admin_list_guides(null, null, null) $$,
  'không phải admin thì admin_list_guides bị từ chối', '42501');

select pg_temp.expect_reject(
  $$ select public.admin_publish_site('pos', null) $$,
  'không phải admin thì admin_publish_site bị từ chối', '42501');

-- get_release vẫn mở: đây là đường đọc ẩn danh của extension.
select pg_temp.expect(
  (public.get_release('pos') ->> 'revision')::bigint = 3,
  'get_release vẫn đọc được khi không phải admin');

select 'ALL GUIDE RPC TESTS PASSED' as result;

rollback;
