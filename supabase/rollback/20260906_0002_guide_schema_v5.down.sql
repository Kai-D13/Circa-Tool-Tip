-- Rollback 0002. DESTRUCTIVE: drops every guide, version and release.
-- Run 0004.down and 0003.down first (the functions reference these tables).
-- Take a backup before running this on anything that matters.

drop function if exists public.guide_steps_shape_error(jsonb);

drop table if exists public.release_heads;
drop table if exists public.releases;
drop table if exists public.guide_versions;
drop table if exists public.guides;
drop table if exists public.guide_groups;
drop table if exists public.sites;

drop type if exists public.guide_status;
