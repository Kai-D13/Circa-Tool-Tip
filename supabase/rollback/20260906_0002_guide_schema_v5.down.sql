-- Rollback 0002. PHÁ HUỶ DỮ LIỆU: xoá toàn bộ guide và release.
-- Chạy 0004.down và 0003.down trước (function tham chiếu các bảng này).
-- Backup trước khi chạy trên dữ liệu thật.

drop function if exists public.guide_publish_error(uuid);
drop function if exists public.guide_steps_shape_error(jsonb);

drop table if exists public.release_heads;
drop table if exists public.releases;
drop table if exists public.guides;
drop table if exists public.sites;

drop type if exists public.guide_status;
