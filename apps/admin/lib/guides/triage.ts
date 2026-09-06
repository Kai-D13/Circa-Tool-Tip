import { normalizeSearchText } from "@circa/guide-schema";

import type { Confidence, GuideRow } from "./types";

/**
 * Pure helpers behind the triage screen. No React, no Supabase — unit-tested with
 * `node --test`, and the board component just wires them to state.
 */

export type Scope = "unassigned" | "pos" | "admin" | "all";
export type ConfidenceFilter = "any" | Confidence;

export interface TriageFilter {
  scope: Scope;
  confidence: ConfidenceFilter;
  onlyWarnings: boolean;
  query: string;
}

export const DEFAULT_FILTER: TriageFilter = { scope: "unassigned", confidence: "any", onlyWarnings: false, query: "" };

const CONFIDENCE_RANK: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 };

export function confidenceOf(guide: GuideRow): Confidence {
  const c = guide.site_evidence?.confidence;
  return c === "high" || c === "medium" || c === "low" ? c : "none";
}

export function hasWarnings(guide: GuideRow): boolean {
  const v = guide.validation || {};
  return (v.warnings?.length ?? 0) > 0 || (v.flags?.length ?? 0) > 0 || (v.errors?.length ?? 0) > 0;
}

/** Guides a human cannot get a hint for come first, then low → medium → high. */
export function unknownFirst(guides: GuideRow[]): GuideRow[] {
  return [...guides].sort((a, b) => {
    const r = CONFIDENCE_RANK[confidenceOf(a)] - CONFIDENCE_RANK[confidenceOf(b)];
    if (r !== 0) return r;
    return a.sort_order - b.sort_order || a.name.localeCompare(b.name);
  });
}

export function filterGuides(guides: GuideRow[], filter: TriageFilter): GuideRow[] {
  const q = normalizeSearchText(filter.query);
  return guides.filter((g) => {
    if (filter.scope === "unassigned" && g.status !== "unassigned") return false;
    if (filter.scope === "pos" && g.site_code !== "pos") return false;
    if (filter.scope === "admin" && g.site_code !== "admin") return false;
    if (filter.confidence !== "any" && confidenceOf(g) !== filter.confidence) return false;
    if (filter.onlyWarnings && !hasWarnings(g)) return false;
    if (q && !normalizeSearchText(g.name).includes(q)) return false;
    return true;
  });
}

/** Local state update after admin_assign_guide_site succeeds. Never mutates input. */
export function applyAssignment(guides: GuideRow[], guideId: string, site: string, groupName: string): GuideRow[] {
  return guides.map((g) =>
    g.id === guideId
      ? { ...g, site_code: site, group_name: groupName.trim(), status: g.status === "unassigned" ? "draft" : g.status }
      : g,
  );
}

export interface Progress {
  total: number;
  assigned: number;
  unassigned: number;
}

export function progressOf(guides: GuideRow[]): Progress {
  const unassigned = guides.filter((g) => g.status === "unassigned").length;
  return { total: guides.length, assigned: guides.length - unassigned, unassigned };
}

/** Only high-confidence, still-unassigned guides with a concrete guess qualify for bulk apply. */
export function highConfidenceSuggestions(guides: GuideRow[]): GuideRow[] {
  return guides.filter(
    (g) => g.status === "unassigned" && confidenceOf(g) === "high" && (g.site_guess === "pos" || g.site_guess === "admin"),
  );
}
