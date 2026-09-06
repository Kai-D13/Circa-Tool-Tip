-- Circa Tool-tip - seed the two production sites.
-- Idempotent: safe to re-run.

insert into public.sites (code, label, origin, sort_order, enabled) values
  ('pos',   'POS',   'https://pos.v2.circa.vn',   1, true),
  ('admin', 'Admin', 'https://admin.v2.circa.vn', 2, true)
on conflict (code) do update
  set label      = excluded.label,
      origin     = excluded.origin,
      sort_order = excluded.sort_order,
      enabled    = excluded.enabled;

select code, label, origin, enabled from public.sites order by sort_order;
