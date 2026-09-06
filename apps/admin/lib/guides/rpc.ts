import type { SupabaseClient } from "@supabase/supabase-js";

import type { AssignResult, GuideStatus, ImportResult, ListGuidesResult } from "./types";

/**
 * Thin wrappers over the admin RPCs. The `build*Args` functions are pure so a unit test
 * can prove the parameter names match the SQL signatures without a database.
 */

export function buildImportArgs(payload: unknown, sourceFilename: string, contentChecksum: string) {
  return { p_payload: payload, p_source_filename: sourceFilename, p_checksum: contentChecksum };
}

export function buildListArgs(filter: { site?: string | null; group?: string | null; status?: GuideStatus | null } = {}) {
  return { p_site: filter.site ?? null, p_group: filter.group ?? null, p_status: filter.status ?? null };
}

export function buildAssignArgs(guideId: string, site: string, groupName: string) {
  return { p_guide_id: guideId, p_site: site, p_group_name: groupName.trim() };
}

function unwrap<T>(result: { data: unknown; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.data === null || result.data === undefined) throw new Error(`${what}: không có dữ liệu trả về`);
  return result.data as T;
}

export async function rpcImportLegacy(
  supabase: SupabaseClient,
  payload: unknown,
  sourceFilename: string,
  contentChecksum: string,
): Promise<ImportResult> {
  const r = await supabase.rpc("admin_import_legacy", buildImportArgs(payload, sourceFilename, contentChecksum));
  return unwrap<ImportResult>(r, "admin_import_legacy");
}

export async function rpcListGuides(
  supabase: SupabaseClient,
  filter: Parameters<typeof buildListArgs>[0] = {},
): Promise<ListGuidesResult> {
  const r = await supabase.rpc("admin_list_guides", buildListArgs(filter));
  return unwrap<ListGuidesResult>(r, "admin_list_guides");
}

export async function rpcAssignSite(
  supabase: SupabaseClient,
  guideId: string,
  site: string,
  groupName: string,
): Promise<AssignResult> {
  const r = await supabase.rpc("admin_assign_guide_site", buildAssignArgs(guideId, site, groupName));
  return unwrap<AssignResult>(r, "admin_assign_guide_site");
}
