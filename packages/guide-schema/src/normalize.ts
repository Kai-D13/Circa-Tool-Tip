/**
 * Circa Tool-tip — v4 -> v5 normalisation.
 *
 * Replaces shared.js:21 `normalizeAction`, shared.js:44 `normalizeStep` and their
 * duplicate content.js:768 `getAction`. One copy, used by the importer, the portal and
 * the extension alike.
 */

import { DEFAULT_INTENT, DEFAULT_POSITION, isActionType, isWaitUrlAction } from "./constants.ts";
import { normalizeText } from "./text.ts";
import { inferUrlMatchMode } from "./url-match.ts";
import type {
  ActionType,
  DraftStep,
  Intent,
  Position,
  ReleaseStep,
  SiteCode,
  StepAction,
} from "./types.ts";

/**
 * v4 action shape is {type, expectedUrl, timeoutMs}. v3 used a boolean `advanceOnClick`.
 * Unknown types degrade to "highlight" — never to an auto-click.
 */
export function normalizeAction(raw: unknown): StepAction {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const actionObj = (src.action && typeof src.action === "object" ? src.action : src) as Record<string, unknown>;

  let type = actionObj.type as ActionType | undefined;
  if (!type) type = src.advanceOnClick ? "click_next" : "highlight";
  if (!isActionType(type)) type = "highlight";

  const out: StepAction = {
    type,
    expectedUrl: String(actionObj.expectedUrl || ""),
    timeoutMs: Number(actionObj.timeoutMs || 0) || 0,
  };
  const override = actionObj.expectedSiteOverride;
  if (typeof override === "string" && override) out.expectedSiteOverride = override;
  return out;
}

function normalizeIntent(v: unknown): Intent {
  return v === "first_item" ? "first_item" : "exact";
}

function normalizePosition(v: unknown): Position {
  const s = String(v || "");
  if (s === "top" || s === "bottom" || s === "left" || s === "right") return s;
  return "auto";
}

function normalizeSelectors(raw: Record<string, unknown>): string[] {
  const list: string[] = [];
  const push = (v: unknown) => {
    const s = String(v || "").trim();
    if (s && list.indexOf(s) < 0) list.push(s);
  };
  // v4 kept `selector` and `selectorCandidates[0]` as duplicate strings on all 409 steps.
  push(raw.selector);
  const cands = raw.selectorCandidates ?? raw.selectors ?? raw.candidates;
  if (Array.isArray(cands)) for (const c of cands) push(c);
  return list;
}

export interface NormalizeStepOptions {
  /** Stable id to assign when the source has none. */
  id: string;
  /** Only set when this step genuinely crosses to another site. */
  siteOverride?: SiteCode | null;
  /** Materialized wait target, normally steps[i+1].urlPattern. */
  expectedUrl?: string;
  flags?: string[];
}

/**
 * v4 step -> v5 DraftStep.
 *
 * Drops `selector` (always identical to selectorCandidates[0]) and omits
 * intent/position/urlMatchMode when they equal their default or inferred value, which
 * they do on every one of the 409 legacy steps.
 */
export function normalizeDraftStep(raw: unknown, opts: NormalizeStepOptions): DraftStep {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const action = normalizeAction(src);
  if (opts.expectedUrl !== undefined && isWaitUrlAction(action.type) && !action.expectedUrl) {
    action.expectedUrl = String(opts.expectedUrl || "");
  }

  const urlPattern = String(src.urlPattern || "");
  const explicitMode = src.urlMatchMode as string | undefined;
  const inferred = inferUrlMatchMode(urlPattern, undefined);
  const effective = inferUrlMatchMode(urlPattern, explicitMode);

  const step: DraftStep = {
    id: opts.id,
    selectors: normalizeSelectors(src),
    matchText: normalizeText(String(src.matchText || "")),
    tag: String(src.tag || ""),
    title: String(src.title || ""),
    content: String(src.content || ""),
    urlPattern,
    navigationUrl: String(src.navigationUrl || ""),
    action,
  };

  if (opts.siteOverride) step.siteOverride = opts.siteOverride;

  if (typeof src.matchTextStable === "boolean") step.matchTextStable = src.matchTextStable;

  const intent = normalizeIntent(src.intent);
  if (intent !== DEFAULT_INTENT) step.intent = intent;

  const position = normalizePosition(src.position);
  if (position !== DEFAULT_POSITION) step.position = position;

  // Only carry urlMatchMode when it is NOT what would be inferred.
  if (effective && effective !== inferred) step.urlMatchMode = effective;

  if (opts.flags && opts.flags.length) step.flags = opts.flags.slice();

  return step;
}

/**
 * DraftStep -> ReleaseStep. Materializes the required `site` (Plan v1.1 §P0-5) and
 * strips authoring-only fields.
 */
export function materializeReleaseStep(step: DraftStep, guideSite: SiteCode): ReleaseStep {
  const site = step.siteOverride || guideSite;
  if (!site) throw new Error("materializeReleaseStep: step " + step.id + " has no site");

  const out: ReleaseStep = {
    id: step.id,
    site,
    selectors: step.selectors.slice(),
    matchText: step.matchText,
    tag: step.tag,
    title: step.title,
    content: step.content,
    urlPattern: step.urlPattern,
    navigationUrl: step.navigationUrl,
    action: { ...step.action },
  };
  if (typeof step.matchTextStable === "boolean") out.matchTextStable = step.matchTextStable;
  if (step.intent) out.intent = step.intent;
  if (step.position) out.position = step.position;
  if (step.urlMatchMode) out.urlMatchMode = step.urlMatchMode;
  return out;
}

/** True when a step has nothing to resolve a target with. shared.js:63 `isUnmapped`. */
export function isUnmapped(step: DraftStep | ReleaseStep): boolean {
  const hasSelector = Array.isArray(step.selectors) && step.selectors.some((s) => !!String(s || "").trim());
  const hasText = !!normalizeText(step.matchText);
  return !hasSelector && !hasText;
}

/** Selector so broad it would spotlight the page. shared.js:76 `looksBroadSelector`. */
export function looksBroadSelector(selector: string): boolean {
  const s = String(selector || "").trim().toLowerCase();
  if (!s) return false;
  if (s === "body" || s === "html" || s === "*") return true;
  if (/^(html|body)\b/.test(s)) return true;
  // A root-level structural path with no id/class/attribute hook.
  return !/[#.[]/.test(s) && /^(div|main|section|header|footer)(\s*>\s*\w+(:nth-of-type\(\d+\))?)?$/.test(s);
}

/** URL pinned to one concrete record. shared.js:86 `looksDynamicUrl`. */
export function looksDynamicUrl(url: string): boolean {
  const u = String(url || "");
  if (!u || u.indexOf("*") >= 0) return false;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  return UUID.test(u) || /\/\d{3,}(\/|\?|$)/.test(u);
}
