import type { SupabaseClient } from "@supabase/supabase-js";

import type { SiteOption } from "./types";

/**
 * The enabled sites, for the site pickers. `sites` is admin-readable through RLS
 * (sites_admin_read), so this needs no privileged key.
 */
export async function fetchSites(supabase: SupabaseClient): Promise<SiteOption[]> {
  const { data, error } = await supabase.from("sites").select("code,label,origin").eq("enabled", true).order("sort_order");
  if (error) throw new Error(`Không đọc được danh sách site: ${error.message}`);
  return (data ?? []) as SiteOption[];
}
