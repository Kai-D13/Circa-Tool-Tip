/**
 * Shapes returned by the admin RPCs in supabase/migrations/20260906_0003_guide_rpcs.sql
 * and 20260906_0004_release_rpcs.sql.
 */

export type GuideStatus = "unassigned" | "draft" | "published" | "archived";

export type SiteCode = "pos" | "admin";

export type Confidence = "high" | "medium" | "low" | "none";

export interface SiteEvidence {
  entrySegment?: string;
  entryVote?: string | null;
  posScore?: number;
  adminScore?: number;
  neutralScore?: number;
  confidence?: Confidence;
  reason?: string;
  prefixes?: Record<string, number>;
}

export interface GuideValidation {
  errors?: string[];
  warnings?: string[];
  /** Guide-level flags from the importer, e.g. GUIDE_HAS_AUTO_CLICK_UNANCHORED. */
  flags?: string[];
}

export interface GuideRow {
  id: string;
  legacy_id: string | null;
  site_code: string | null;
  group_name: string;
  name: string;
  status: GuideStatus;
  start_url: string;
  sort_order: number;
  step_count: number;
  validation: GuideValidation;
  site_guess: string | null;
  site_evidence: SiteEvidence;
  notes: string | null;
  updated_at: string;
}

export interface GuideCounts {
  total: number;
  unassigned: number;
  draft: number;
  published: number;
  archived: number;
}

export interface ListGuidesResult {
  ok: boolean;
  guides: GuideRow[];
  counts: GuideCounts;
}

export interface ImportResult {
  ok: boolean;
  sourceFilename: string;
  contentChecksum: string;
  guides: number;
  steps: number;
  inserted: number;
  updated: number;
  skippedBecauseTriaged: number;
  unassignedRemaining: number;
}

export interface AssignResult {
  ok: boolean;
  guideId: string;
  site: string;
  unassignedRemaining: number;
}

/** The full row returned by admin_get_guide, including the editable draft. */
export interface GuideDetailRow extends GuideRow {
  draft_steps: unknown[];
  created_at: string;
  created_by_email: string | null;
  updated_by_email: string | null;
}

export interface GuideDetailResult {
  ok: boolean;
  guide: GuideDetailRow;
  /** First reason this guide cannot go into a release, or null. From guide_publish_error(). */
  publishError: string | null;
}

export interface UpsertGuideResult {
  ok: boolean;
  guideId: string;
}

export interface SaveStepsResult {
  ok: boolean;
  guideId: string;
  stepCount: number;
  /** New updated_at — the caller must keep it for the next optimistic save. */
  updatedAt: string;
}

/** Result of the atomic save (migration 0005). */
export interface SaveGuideResult {
  ok: boolean;
  guideId: string;
  stepCount: number;
  /** Server-side status after the save; unassigned becomes draft once a site is set. */
  status: GuideStatus;
  updatedAt: string;
}

export interface SiteOption {
  code: string;
  label: string;
  /** scheme + host, no trailing slash. Guides store paths; this is what makes them absolute. */
  origin: string;
}

/* ------------------------------------------------- release RPCs (migration 0004) */

/**
 * The raw `release_heads` row. `admin_list_releases` returns it as `to_jsonb(h)`, so the
 * field names are the COLUMN names — snake_case, unlike everything else in this file.
 * Kept that way on purpose: renaming here would hide where the shape comes from.
 *
 * `null` when the site has never published.
 */
export interface ReleaseHeadRow {
  site_code: string;
  release_id: string;
  /** bigint in SQL, but revisions are small and arrive as a JSON number. */
  revision: number;
  checksum: string;
  guide_count: number;
  step_count: number;
  released_at: string;
}

/**
 * One row of `admin_list_releases.releases[]` — hand-built with jsonb_build_object, so
 * camelCase.
 *
 * CAREFUL: `rolledBackFrom` here is the `releases.rolled_back_from` UUID. The field of
 * the same name in `RollbackResult` is a REVISION NUMBER. They are not interchangeable —
 * resolve through `toHistoryRows()` in ./releases and use `rolledBackFromRevision`.
 */
export interface ReleaseListRow {
  id: string;
  revision: number;
  checksum: string;
  guideCount: number;
  stepCount: number;
  /** uuid of the release this one was copied from, or null. */
  rolledBackFrom: string | null;
  note: string | null;
  releasedAt: string;
  releasedByEmail: string | null;
}

export interface ListReleasesResult {
  ok: boolean;
  site: string;
  head: ReleaseHeadRow | null;
  releases: ReleaseListRow[];
}

export interface PublishResult {
  ok: boolean;
  site: string;
  releaseId: string;
  revision: number;
  /** Computed by SQL. The client never calculates this — see ./releases. */
  checksum: string;
  guides: number;
  steps: number;
}

export interface RollbackResult {
  ok: boolean;
  site: string;
  /** The NEW release, not the one rolled back to. */
  releaseId: string;
  /** The NEW revision — always higher than before. */
  revision: number;
  /** The revision NUMBER that was rolled back to (not a uuid). */
  rolledBackFrom: number;
}
