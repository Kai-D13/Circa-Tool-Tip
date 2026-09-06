import {
  normalizeDraftStep,
  validateDraftGuide,
  type DraftGuide,
  type DraftStep,
  type ValidationResult,
} from "@circa/guide-schema";

import type { GuideDetailRow, GuideValidation } from "./types";

/**
 * Pure editor logic. No React, no Supabase — everything here is unit-tested with
 * `node --test`, and the components only wire it to state.
 *
 * The load -> edit -> save round trip goes through `normalizeDraftStep`, the SAME
 * function the legacy importer used. That is deliberate: one definition of the step
 * shape means opening a guide and saving it back cannot quietly drop a field or change
 * how a default is represented.
 */

export interface GuideMetadata {
  name: string;
  siteCode: string | null;
  groupName: string;
  startUrl: string;
  sortOrder: number;
  notes: string;
}

export function metadataOf(guide: GuideDetailRow): GuideMetadata {
  return {
    name: guide.name,
    siteCode: guide.site_code,
    groupName: guide.group_name ?? "",
    startUrl: guide.start_url ?? "",
    sortOrder: guide.sort_order ?? 0,
    notes: guide.notes ?? "",
  };
}

/** Step ids keep the importer's `st_` + 10 hex shape so both sources look alike. */
export function newStepId(random: () => string = () => crypto.randomUUID()): string {
  return "st_" + random().replace(/-/g, "").slice(0, 10);
}

export function blankStep(id: string): DraftStep {
  return {
    id,
    selectors: [],
    matchText: "",
    tag: "",
    title: "",
    content: "",
    urlPattern: "",
    navigationUrl: "",
    action: { type: "highlight", expectedUrl: "", timeoutMs: 0 },
  };
}

/* ------------------------------------------------------------------ step list ops */

export function patchStep(steps: DraftStep[], id: string, patch: Partial<DraftStep>): DraftStep[] {
  return steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

export function removeStep(steps: DraftStep[], id: string): DraftStep[] {
  return steps.filter((s) => s.id !== id);
}

export function insertStepAfter(steps: DraftStep[], index: number, step: DraftStep): DraftStep[] {
  const next = steps.slice();
  next.splice(index + 1, 0, step);
  return next;
}

/** Move by a signed offset; out-of-range moves are a no-op rather than an error. */
export function moveStep(steps: DraftStep[], index: number, delta: number): DraftStep[] {
  const to = index + delta;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) return steps;
  const next = steps.slice();
  const [moved] = next.splice(index, 1);
  next.splice(to, 0, moved);
  return next;
}

/* ---------------------------------------------------------------- serialisation */

/**
 * Editor state -> exactly what goes into `guides.draft_steps`.
 *
 * Order is preserved. Defaults are re-omitted (intent "exact", position "auto", a
 * urlMatchMode equal to the inferred one) so a save does not inflate the row with values
 * that carry no information. Importer flags are carried through untouched: they are not
 * editable, and the repair queue reads them.
 */
export function serializeSteps(steps: DraftStep[]): DraftStep[] {
  return steps.map((step) =>
    normalizeDraftStep(step, {
      id: step.id,
      siteOverride: step.siteOverride ?? null,
      flags: step.flags,
    }),
  );
}

/** A comma/newline separated textarea <-> the selectors array. */
export function parseSelectors(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text || "").split("\n")) {
    const s = line.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function formatSelectors(selectors: string[]): string {
  return (selectors || []).join("\n");
}

/* ------------------------------------------------------------------ validation */

export function draftGuideOf(meta: GuideMetadata, steps: DraftStep[], status: GuideDetailRow["status"]): DraftGuide {
  return {
    name: meta.name,
    siteCode: meta.siteCode,
    groupName: meta.groupName,
    status,
    startUrl: meta.startUrl,
    sortOrder: meta.sortOrder,
    steps,
  };
}

export function validateForEditor(
  meta: GuideMetadata,
  steps: DraftStep[],
  status: GuideDetailRow["status"],
  knownSites: string[],
): ValidationResult {
  return validateDraftGuide(draftGuideOf(meta, steps, status), { knownSites, requireSite: status !== "unassigned" });
}

export interface StepIssues {
  errors: string[];
  warnings: string[];
}

export interface GroupedIssues {
  /** Messages that are not about a specific step. */
  guide: StepIssues;
  /** Keyed by 1-based step number, matching the validator's own wording. */
  byStep: Record<number, StepIssues>;
}

const STEP_PREFIX = /^Bước (\d+)/;

/**
 * Split validator output per step so the UI can show a message next to the field that
 * caused it. The validator emits "Bước N: ..." / "Bước N ..." and that prefix is our own
 * format, defined in packages/guide-schema.
 */
export function groupIssues(result: ValidationResult): GroupedIssues {
  const grouped: GroupedIssues = { guide: { errors: [], warnings: [] }, byStep: {} };

  const put = (message: string, kind: "errors" | "warnings") => {
    const m = STEP_PREFIX.exec(message);
    if (!m) {
      grouped.guide[kind].push(message);
      return;
    }
    const n = Number(m[1]);
    grouped.byStep[n] ??= { errors: [], warnings: [] };
    grouped.byStep[n][kind].push(message);
  };

  result.errors.forEach((e) => put(e, "errors"));
  result.warnings.forEach((w) => put(w, "warnings"));
  return grouped;
}

/**
 * What gets written to `guides.validation`.
 *
 * Importer flags live in the same column and must survive an edit — they are what the
 * repair queue and the publish-time warning read.
 */
export function buildValidationPayload(result: ValidationResult, existing: GuideValidation | null): GuideValidation {
  return {
    errors: result.errors,
    warnings: result.warnings,
    flags: existing?.flags ?? [],
  };
}

/** Errors block publishing; warnings never do. */
export function canPublish(result: ValidationResult, siteCode: string | null): boolean {
  return result.errors.length === 0 && !!siteCode;
}

/* --------------------------------------------------------------------- dirty */

export function isDirty(
  a: { meta: GuideMetadata; steps: DraftStep[] },
  b: { meta: GuideMetadata; steps: DraftStep[] },
): boolean {
  return (
    JSON.stringify(a.meta) !== JSON.stringify(b.meta) ||
    JSON.stringify(serializeSteps(a.steps)) !== JSON.stringify(serializeSteps(b.steps))
  );
}
