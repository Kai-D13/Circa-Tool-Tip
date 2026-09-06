/**
 * Circa Tool-tip — repair flags.
 *
 * Flags are advisory metadata, never a hard gate (Plan v1.1 §P0-7). They drive the
 * portal's repair queue and the publish-time warning. Nothing here blocks a publish and
 * nothing here changes runtime behaviour.
 *
 * The combination that matters most is AUTO_CLICK_UNANCHORED: an action the extension
 * fires by itself, whose only locator is a positional DOM path with no text to confirm
 * it landed on the right element. In the legacy corpus that is 72 steps across 24 of
 * the 48 guides.
 */

import { URL_LENGTH_WARN, isAutoClickAction, isWaitUrlAction } from "./constants.ts";
import { isUnmapped, looksBroadSelector, looksDynamicUrl } from "./normalize.ts";
import { isBlankAnchor, stripZeroWidth } from "./text.ts";
import type { DraftGuide, DraftStep } from "./types.ts";

export const FLAGS = {
  /** Selector has no id, class or attribute hook - position in the tree is all it has. */
  SEL_STRUCTURAL_ONLY: "SEL_STRUCTURAL_ONLY",
  SEL_NTH_OF_TYPE: "SEL_NTH_OF_TYPE",
  /** Selector uses an id that is known to repeat on the live page. */
  SEL_KNOWN_DUPLICATE_ID: "SEL_KNOWN_DUPLICATE_ID",
  SEL_BROAD: "SEL_BROAD",
  UNMAPPED: "UNMAPPED",
  /** No usable text to confirm the resolved element. */
  NO_TEXT_ANCHOR: "NO_TEXT_ANCHOR",
  /** matchText was non-empty in v4 but contains only zero-width/whitespace. */
  MATCH_TEXT_ZERO_WIDTH_ONLY: "MATCH_TEXT_ZERO_WIDTH_ONLY",
  SEL_STRUCTURAL_AND_NO_TEXT: "SEL_STRUCTURAL_AND_NO_TEXT",
  /** The publish-time warning condition. */
  AUTO_CLICK_UNANCHORED: "AUTO_CLICK_UNANCHORED",
  URL_HARDCODED_UUID: "URL_HARDCODED_UUID",
  URL_UUID_STRIPPED: "URL_UUID_STRIPPED",
  URL_STALE_QUERY_STRIPPED: "URL_STALE_QUERY_STRIPPED",
  PII_SCRUBBED: "PII_SCRUBBED",
  URL_TOO_LONG: "URL_TOO_LONG",
  WAIT_URL_ON_LAST_STEP: "WAIT_URL_ON_LAST_STEP",
  WAIT_URL_NO_TARGET: "WAIT_URL_NO_TARGET",
  START_URL_MISMATCH: "START_URL_MISMATCH",
  DUP_STEP_TITLE: "DUP_STEP_TITLE",
  DUP_GUIDE_NAME: "DUP_GUIDE_NAME",
  GUIDE_HAS_AUTO_CLICK_UNANCHORED: "GUIDE_HAS_AUTO_CLICK_UNANCHORED",
} as const;

/** Ids measured as non-unique on POS production (#basic-button appears 9 times). */
export const KNOWN_DUPLICATE_IDS = ["basic-button"];

export function isStructuralSelector(selector: string): boolean {
  const s = String(selector || "").trim();
  if (!s) return false;
  return !/[#.[]/.test(s);
}

export function usesKnownDuplicateId(selector: string, ids: string[] = KNOWN_DUPLICATE_IDS): boolean {
  const s = String(selector || "");
  return ids.some((id) => s.indexOf("#" + id) >= 0);
}

export interface StepFlagContext {
  index: number;
  steps: DraftStep[];
  /** Raw v4 matchText, before zero-width stripping. */
  rawMatchText?: string;
  /** Flags contributed by the scrubber (PII, UUID, stale query). */
  extra?: string[];
  duplicateIds?: string[];
}

export function computeStepFlags(step: DraftStep, ctx: StepFlagContext): string[] {
  const flags = new Set<string>(ctx.extra || []);
  const primary = step.selectors[0] || "";

  if (isUnmapped(step)) flags.add(FLAGS.UNMAPPED);
  if (looksBroadSelector(primary)) flags.add(FLAGS.SEL_BROAD);
  if (primary.indexOf(":nth-of-type") >= 0) flags.add(FLAGS.SEL_NTH_OF_TYPE);
  if (isStructuralSelector(primary)) flags.add(FLAGS.SEL_STRUCTURAL_ONLY);
  if (usesKnownDuplicateId(primary, ctx.duplicateIds)) flags.add(FLAGS.SEL_KNOWN_DUPLICATE_ID);

  const noText = isBlankAnchor(step.matchText);
  if (noText) flags.add(FLAGS.NO_TEXT_ANCHOR);

  // Non-empty in v4 but invisible in practice: the trap a naive truthiness check falls into.
  if (typeof ctx.rawMatchText === "string") {
    const raw = ctx.rawMatchText;
    if (raw !== "" && stripZeroWidth(raw).trim() === "") flags.add(FLAGS.MATCH_TEXT_ZERO_WIDTH_ONLY);
  }

  if (flags.has(FLAGS.SEL_STRUCTURAL_ONLY) && noText) flags.add(FLAGS.SEL_STRUCTURAL_AND_NO_TEXT);

  const type = step.action.type;
  if (isAutoClickAction(type) && flags.has(FLAGS.SEL_STRUCTURAL_AND_NO_TEXT)) {
    flags.add(FLAGS.AUTO_CLICK_UNANCHORED);
  }

  for (const url of [step.urlPattern, step.navigationUrl]) {
    if (!url) continue;
    if (looksDynamicUrl(url)) flags.add(FLAGS.URL_HARDCODED_UUID);
    if (url.length > URL_LENGTH_WARN) flags.add(FLAGS.URL_TOO_LONG);
  }

  if (isWaitUrlAction(type)) {
    const isLast = ctx.index === ctx.steps.length - 1;
    if (isLast) flags.add(FLAGS.WAIT_URL_ON_LAST_STEP);
    const target = String(step.action.expectedUrl || "").trim();
    if (!target) flags.add(FLAGS.WAIT_URL_NO_TARGET);
  }

  return [...flags].sort();
}

export interface GuideFlagContext {
  /** Guide names seen more than once across the whole corpus. */
  duplicateNames?: Set<string>;
}

export function computeGuideFlags(guide: DraftGuide, ctx: GuideFlagContext = {}): string[] {
  const flags = new Set<string>();
  const steps = guide.steps || [];

  const first = steps[0];
  const start = String(guide.startUrl || "").trim();
  if (first && start && String(first.urlPattern || "").trim() && start !== first.urlPattern) {
    flags.add(FLAGS.START_URL_MISMATCH);
  }

  const titles = new Map<string, number>();
  for (const s of steps) {
    const key = String(s.title || "").trim().toLowerCase();
    if (!key) continue;
    titles.set(key, (titles.get(key) || 0) + 1);
  }
  for (const count of titles.values()) {
    if (count > 1) {
      flags.add(FLAGS.DUP_STEP_TITLE);
      break;
    }
  }

  if (ctx.duplicateNames && ctx.duplicateNames.has(String(guide.name || "").trim().toLowerCase())) {
    flags.add(FLAGS.DUP_GUIDE_NAME);
  }

  if (steps.some((s) => (s.flags || []).indexOf(FLAGS.AUTO_CLICK_UNANCHORED) >= 0)) {
    flags.add(FLAGS.GUIDE_HAS_AUTO_CLICK_UNANCHORED);
  }

  return [...flags].sort();
}

/**
 * The condition the portal warns on before publishing (Plan v1.1 §P0-7).
 * Advisory: the admin can confirm and publish anyway.
 */
export function needsPublishConfirmation(guide: DraftGuide): boolean {
  return (guide.flags || []).indexOf(FLAGS.GUIDE_HAS_AUTO_CLICK_UNANCHORED) >= 0;
}
