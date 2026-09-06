/** Shapes returned by the admin RPCs in supabase/migrations/20260906_0003_guide_rpcs.sql. */

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
