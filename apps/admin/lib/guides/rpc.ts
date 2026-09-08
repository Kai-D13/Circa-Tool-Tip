import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AssignResult,
  GuideDetailResult,
  GuideStatus,
  ImportResult,
  ListGuidesResult,
  ListReleasesResult,
  PublishResult,
  RollbackResult,
  SaveGuideResult,
  SaveStepsResult,
  UpsertGuideResult,
} from "./types";

/**
 * Thin wrappers over the admin RPCs. The `build*Args` functions are pure so a unit test
 * can prove the parameter names match the SQL signatures without a database.
 */

/** Carries the Postgres SQLSTATE through, so callers can recognise 40001 (conflict). */
export class RpcError extends Error {
  code: string;
  details: string;
  constructor(fn: string, message: string, code = "", details = "") {
    super(`${fn}: ${message}`);
    this.name = "RpcError";
    this.code = code;
    this.details = details;
  }
}

export const CONFLICT_SQLSTATE = "40001";
export const NOT_FOUND_SQLSTATE = "P0002";

export function isConflictError(err: unknown): boolean {
  return err instanceof RpcError && err.code === CONFLICT_SQLSTATE;
}

/** Only a genuine "row does not exist" may be turned into a 404 page. */
export function isNotFoundError(err: unknown): boolean {
  return err instanceof RpcError && err.code === NOT_FOUND_SQLSTATE;
}

export function buildImportArgs(payload: unknown, sourceFilename: string, contentChecksum: string) {
  return { p_payload: payload, p_source_filename: sourceFilename, p_checksum: contentChecksum };
}

export function buildListArgs(filter: { site?: string | null; group?: string | null; status?: GuideStatus | null } = {}) {
  return { p_site: filter.site ?? null, p_group: filter.group ?? null, p_status: filter.status ?? null };
}

export function buildAssignArgs(guideId: string, site: string, groupName: string) {
  return { p_guide_id: guideId, p_site: site, p_group_name: groupName.trim() };
}

export function buildGetGuideArgs(guideId: string) {
  return { p_guide_id: guideId };
}

export interface UpsertGuideInput {
  guideId: string | null;
  name: string;
  site: string | null;
  groupName: string;
  startUrl: string;
  sortOrder: number;
  notes: string | null;
}

/**
 * Always sends every field. `admin_upsert_guide` is not a partial patch: p_group_name
 * defaults to null meaning "keep", so omitting a field would silently keep a stale value
 * while the operator believes they cleared it.
 */
export function buildUpsertGuideArgs(input: UpsertGuideInput) {
  return {
    p_guide_id: input.guideId,
    p_name: input.name.trim(),
    p_site: input.site,
    p_group_name: input.groupName.trim(),
    p_start_url: input.startUrl.trim(),
    p_sort_order: input.sortOrder,
    p_notes: input.notes,
  };
}

export function buildSaveStepsArgs(
  guideId: string,
  steps: unknown[],
  validation: unknown,
  expectedUpdatedAt: string | null,
) {
  return {
    p_guide_id: guideId,
    p_steps: steps,
    p_validation: validation,
    p_expected_updated_at: expectedUpdatedAt,
  };
}

export interface SaveGuideInput extends UpsertGuideInput {
  guideId: string;
  steps: unknown[];
  validation: unknown;
  /** Required, not nullable: the RPC refuses a save that carries no baseline. */
  expectedUpdatedAt: string;
}

/**
 * One Save button = one transaction. `admin_save_guide` (migration 0005) writes metadata
 * and steps in a single UPDATE behind one optimistic guard, so a rejected save cannot
 * leave steps committed with the metadata missing.
 */
export function buildSaveGuideArgs(input: SaveGuideInput) {
  return {
    p_guide_id: input.guideId,
    p_name: input.name.trim(),
    p_site: input.site,
    p_group_name: input.groupName.trim(),
    p_start_url: input.startUrl.trim(),
    p_sort_order: input.sortOrder,
    p_notes: input.notes,
    p_steps: input.steps,
    p_validation: input.validation,
    p_expected_updated_at: input.expectedUpdatedAt,
  };
}

export function buildSetStatusArgs(guideId: string, status: GuideStatus) {
  return { p_guide_id: guideId, p_status: status };
}

export function buildPublishArgs(site: string, note: string) {
  return { p_site: site, p_note: note.trim() };
}

/**
 * No note parameter, deliberately. `admin_rollback_site` writes its own
 * (`format('Rollback về revision %s', old.revision)`) and has no `p_note` — adding one
 * here would be a parameter the database refuses.
 */
export function buildRollbackArgs(site: string, releaseId: string) {
  return { p_site: site, p_release_id: releaseId };
}

export function buildListReleasesArgs(site: string) {
  return { p_site: site };
}

export function buildDeleteGuideArgs(guideId: string) {
  return { p_guide_id: guideId };
}

function unwrap<T>(
  result: { data: unknown; error: { message: string; code?: string; details?: string } | null },
  what: string,
): T {
  if (result.error) throw new RpcError(what, result.error.message, result.error.code ?? "", result.error.details ?? "");
  if (result.data === null || result.data === undefined) throw new RpcError(what, "không có dữ liệu trả về");
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

export async function rpcGetGuide(supabase: SupabaseClient, guideId: string): Promise<GuideDetailResult> {
  const r = await supabase.rpc("admin_get_guide", buildGetGuideArgs(guideId));
  return unwrap<GuideDetailResult>(r, "admin_get_guide");
}

export async function rpcUpsertGuide(supabase: SupabaseClient, input: UpsertGuideInput): Promise<UpsertGuideResult> {
  const r = await supabase.rpc("admin_upsert_guide", buildUpsertGuideArgs(input));
  return unwrap<UpsertGuideResult>(r, "admin_upsert_guide");
}

export async function rpcSaveGuideSteps(
  supabase: SupabaseClient,
  guideId: string,
  steps: unknown[],
  validation: unknown,
  expectedUpdatedAt: string | null,
): Promise<SaveStepsResult> {
  const r = await supabase.rpc(
    "admin_save_guide_steps",
    buildSaveStepsArgs(guideId, steps, validation, expectedUpdatedAt),
  );
  return unwrap<SaveStepsResult>(r, "admin_save_guide_steps");
}

export async function rpcSaveGuide(supabase: SupabaseClient, input: SaveGuideInput): Promise<SaveGuideResult> {
  const r = await supabase.rpc("admin_save_guide", buildSaveGuideArgs(input));
  return unwrap<SaveGuideResult>(r, "admin_save_guide");
}

export async function rpcSetGuideStatus(
  supabase: SupabaseClient,
  guideId: string,
  status: GuideStatus,
): Promise<{ ok: boolean; guideId: string; status: string }> {
  const r = await supabase.rpc("admin_set_guide_status", buildSetStatusArgs(guideId, status));
  return unwrap(r, "admin_set_guide_status");
}

export async function rpcDeleteGuide(
  supabase: SupabaseClient,
  guideId: string,
): Promise<{ ok: boolean; guideId: string; name: string }> {
  const r = await supabase.rpc("admin_delete_guide", buildDeleteGuideArgs(guideId));
  return unwrap(r, "admin_delete_guide");
}

/* ------------------------------------------------------------------- releases */

export async function rpcListReleases(supabase: SupabaseClient, site: string): Promise<ListReleasesResult> {
  const r = await supabase.rpc("admin_list_releases", buildListReleasesArgs(site));
  return unwrap<ListReleasesResult>(r, "admin_list_releases");
}

/**
 * Build and publish a release for one site.
 *
 * Everything that decides WHAT ships is server-side: the payload is assembled from
 * `draft_steps` inside the same statement that mints the revision number, and the
 * checksum is `sha256(payload::text)` computed in SQL. The client sends a site and a
 * note, nothing else — it cannot reproduce that checksum (Postgres and JavaScript
 * serialise JSON differently) and must never try.
 */
export async function rpcPublishSite(supabase: SupabaseClient, site: string, note: string): Promise<PublishResult> {
  const r = await supabase.rpc("admin_publish_site", buildPublishArgs(site, note));
  return unwrap<PublishResult>(r, "admin_publish_site");
}

/**
 * Roll a site back to an earlier release by minting a NEW, higher revision that carries
 * the old payload. Revisions never go down: the extension refuses a downgrade, so a
 * lowered number would strand every machine that already has the higher one.
 */
export async function rpcRollbackSite(
  supabase: SupabaseClient,
  site: string,
  releaseId: string,
): Promise<RollbackResult> {
  const r = await supabase.rpc("admin_rollback_site", buildRollbackArgs(site, releaseId));
  return unwrap<RollbackResult>(r, "admin_rollback_site");
}
