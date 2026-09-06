-- =============================================================================
-- Circa Tool-tip - RPC test suite
--
-- Runs entirely inside ONE transaction and ROLLS BACK at the end, so it is safe to run
-- against the real project: it leaves nothing behind, not even the stubbed is_admin().
--
-- Run it in the Supabase SQL Editor AFTER 0001-0004. It is proof, not decoration: if
-- the final SELECT does not print PASSED, something is wrong and nothing should be
-- imported yet.
--
-- Adapted from circa-consult-salesup/supabase/tests/sales_up_rpc_test.sql.
-- Note the assertions are made with SELECTs and exceptions rather than NOTICEs: the
-- SQL Editor swallows NOTICE output, so a NOTICE-based test can pass silently while
-- failing.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Stub the authorisation predicate. Every admin RPC runs with `search_path = public`
-- so it resolves THIS definition. Rolled back with the transaction.
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

-- Asserts that a statement is rejected. Re-raises our own FAILED marker so a passing
-- statement cannot be mistaken for a rejected one.
create or replace function pg_temp.expect_reject(p_sql text, p_label text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception
    when others then
      if sqlerrm like 'FAILED:%' then raise; end if;
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

-- -----------------------------------------------------------------------------
-- 1. Import
-- -----------------------------------------------------------------------------
select public.admin_import_legacy(
  jsonb_build_object(
    'schemaVersion', 5,
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
  'sha256:test'
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

-- Reconciliation must fire when the payload lies about its own totals.
select pg_temp.expect_reject($$
  select public.admin_import_legacy(
    jsonb_build_object('schemaVersion', 5,
      'stats', jsonb_build_object('guides', 99, 'steps', 99),
      'guides', jsonb_build_array()),
    'bad.json', 'sha256:bad')
$$, 'import với stats sai phải bị từ chối');

-- A malformed step must not be accepted.
select pg_temp.expect_reject($$
  select public.admin_import_legacy(
    jsonb_build_object('schemaVersion', 5,
      'guides', jsonb_build_array(jsonb_build_object(
        'legacyId', 'test_bad', 'name', 'BAD', 'startUrl', '/x',
        'steps', jsonb_build_array(jsonb_build_object('id', 'st_x', 'selectors', jsonb_build_array()))))),
    'bad.json', 'sha256:bad')
$$, 'step thiếu action phải bị từ chối');

-- Re-import is idempotent and must not duplicate rows.
select public.admin_import_legacy(
  jsonb_build_object('schemaVersion', 5,
    'stats', jsonb_build_object('guides', 1, 'steps', 1),
    'guides', jsonb_build_array(jsonb_build_object(
      'legacyId', 'test_guide_b', 'name', 'GUIDE B', 'startUrl', '/tai-khoan',
      'steps', jsonb_build_array(jsonb_build_object(
        'id', 'st_b1', 'selectors', jsonb_build_array('a.voucher'),
        'matchText', 'Voucher', 'tag', 'a', 'title', 'b1', 'content', 'c1',
        'urlPattern', '/quan-ly-voucher', 'navigationUrl', '/quan-ly-voucher',
        'action', jsonb_build_object('type', 'highlight', 'expectedUrl', '', 'timeoutMs', 0)))))),
  'test-fixture.json', 'sha256:test');

select pg_temp.expect(
  (select count(*) from public.guides where legacy_id = 'test_guide_b') = 1,
  'import lại không nhân bản guide');

-- -----------------------------------------------------------------------------
-- 2. The unassigned CHECK constraint
-- -----------------------------------------------------------------------------
select pg_temp.expect_reject(
  format($$ update public.guides set status = 'published' where id = %L $$,
         (select id from public.guides where legacy_id = 'test_guide_a')),
  'CHECK: không thể publish guide chưa có site');

-- -----------------------------------------------------------------------------
-- 3. Triage
-- -----------------------------------------------------------------------------
select public.admin_assign_guide_site(
  (select id from public.guides where legacy_id = 'test_guide_a'), 'pos', null);

select pg_temp.expect(
  (select site_code = 'pos' and status = 'draft'
     from public.guides where legacy_id = 'test_guide_a'),
  'gán site chuyển guide từ unassigned sang draft');

select pg_temp.expect_reject(
  format($$ select public.admin_assign_guide_site(%L, 'khong-ton-tai', null) $$,
         (select id from public.guides where legacy_id = 'test_guide_b')),
  'gán site không tồn tại phải bị từ chối');

-- A group belongs to a site, so it cannot be attached to a guide on another site.
insert into public.guide_groups (id, site_code, name, sort_order)
values ('11111111-1111-1111-1111-111111111111', 'admin', 'Nhóm Admin', 1);

select pg_temp.expect_reject(
  format($$ select public.admin_assign_guide_site(%L, 'pos', '11111111-1111-1111-1111-111111111111') $$,
         (select id from public.guides where legacy_id = 'test_guide_a')),
  'nhóm của site khác phải bị từ chối');

-- -----------------------------------------------------------------------------
-- 4. Optimistic concurrency
-- -----------------------------------------------------------------------------
select pg_temp.expect_reject(
  format($$ select public.admin_save_guide_steps(%L, '[]'::jsonb, '{}'::jsonb, %L::timestamptz) $$,
         (select id from public.guides where legacy_id = 'test_guide_a'),
         '2000-01-01T00:00:00Z'),
  'ghi đè bằng updated_at cũ phải bị từ chối');

-- -----------------------------------------------------------------------------
-- 5. Publish
-- -----------------------------------------------------------------------------
select public.admin_set_guide_status(
  (select id from public.guides where legacy_id = 'test_guide_a'), 'published');

select pg_temp.expect_reject(
  $$ select public.admin_publish_site('admin', 'không có guide nào') $$,
  'publish site không có guide published phải bị từ chối');

select public.admin_publish_site('pos', 'release thử');

select pg_temp.expect(
  (select revision from public.release_heads where site_code = 'pos') = 1,
  'release đầu tiên có revision 1');

select pg_temp.expect(
  (select guide_count from public.release_heads where site_code = 'pos') = 1,
  'release chứa đúng 1 guide');

-- P0-5: every released step must name a site.
select pg_temp.expect(
  (select bool_and((s ->> 'site') = 'pos')
     from public.releases r,
          jsonb_array_elements(r.payload -> 'guides') g,
          jsonb_array_elements(g -> 'steps') s
    where r.site_code = 'pos'),
  'P0-5: mọi step trong release đều có site');

-- Authoring-only fields must not ship.
select pg_temp.expect(
  (select bool_and(not (s ? 'flags') and not (s ? 'siteOverride'))
     from public.releases r,
          jsonb_array_elements(r.payload -> 'guides') g,
          jsonb_array_elements(g -> 'steps') s
    where r.site_code = 'pos'),
  'release không mang theo flags/siteOverride');

-- The release must be able to name the other site's origin for cross-origin steps.
select pg_temp.expect(
  (select payload -> 'sites' ->> 'admin' = 'https://admin.v2.circa.vn'
     from public.releases where site_code = 'pos' and revision = 1),
  'release mang bản đồ origin của cả hai site');

select pg_temp.expect(
  (select checksum = 'sha256:' || encode(digest((payload - 'checksum')::text, 'sha256'), 'hex')
     from public.releases where site_code = 'pos' and revision = 1),
  'checksum khớp với payload đã bỏ trường checksum');

-- -----------------------------------------------------------------------------
-- 6. Publish again, then roll back - the revision must never go down
-- -----------------------------------------------------------------------------
select public.admin_publish_site('pos', 'release thứ hai');

select pg_temp.expect(
  (select revision from public.release_heads where site_code = 'pos') = 2,
  'release thứ hai có revision 2');

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

select pg_temp.expect_reject(
  format($$ select public.admin_rollback_site('pos', %L) $$,
         (select release_id from public.release_heads where site_code = 'pos')),
  'rollback về chính bản đang chạy phải bị từ chối');

-- -----------------------------------------------------------------------------
-- 7. get_release
-- -----------------------------------------------------------------------------
select pg_temp.expect(
  (public.get_release('pos') ->> 'revision')::bigint = 3,
  'get_release trả về bản đang chạy');

select pg_temp.expect(
  (public.get_release('khong-ton-tai') ->> 'revision')::bigint = 0,
  'get_release trả shape rỗng ổn định cho site chưa publish');

-- -----------------------------------------------------------------------------
-- 8. Delete guard
-- -----------------------------------------------------------------------------
select pg_temp.expect_reject(
  format($$ select public.admin_delete_guide(%L) $$,
         (select id from public.guides where legacy_id = 'test_guide_a')),
  'không xoá được guide đang published');

-- -----------------------------------------------------------------------------
-- 9. Authorisation - a non-admin must be refused
-- -----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select false $$;

select pg_temp.expect_reject(
  $$ select public.admin_list_guides(null, null, null) $$,
  'không phải admin thì admin_list_guides bị từ chối');

select pg_temp.expect_reject(
  $$ select public.admin_publish_site('pos', null) $$,
  'không phải admin thì admin_publish_site bị từ chối');

-- get_release stays open: it is the extension's anonymous read path.
select pg_temp.expect(
  (public.get_release('pos') ->> 'revision')::bigint = 3,
  'get_release vẫn đọc được khi không phải admin');

select 'ALL GUIDE RPC TESTS PASSED' as result;

rollback;
