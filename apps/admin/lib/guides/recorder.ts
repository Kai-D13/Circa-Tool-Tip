import { normalizeDraftStep, type DraftStep } from "@circa/guide-schema";

import { newStepId } from "./editor.ts";
import type { SiteOption } from "./types";

/**
 * Pure recorder logic. No React, no chrome APIs — the panel only wires this to state,
 * and everything here is unit-tested with `node --test`.
 *
 * The extension records what it can actually observe in the page: an element, its text,
 * and the path it was on. Everything that needs to know about the GUIDE — which site a
 * step belongs to, whether a click navigates, what a wait should wait for — is decided
 * here, because only the Portal has the guide and the sites table.
 */

/** Exactly what the content script captures, before it means anything to a guide. */
export interface RecordedStep {
  selectors: string[];
  matchText: string;
  tag: string;
  urlPattern: string;
  /** Origin of the page the click happened on; maps back to a site code. */
  origin: string;
  at?: string;
}

export interface RecorderSession {
  id: string;
  guideId: string;
  site: string;
  startUrl: string;
  tabId: number | null;
  mode: string;
  status: "recording" | "done";
  steps: RecordedStep[];
  startedAt: string;
  stoppedAt?: string;
}

/** A Chrome extension id: 32 letters in a-p. */
const EXTENSION_ID = /^[a-p]{32}$/;

/**
 * Which extension the Portal talks to.
 *
 * The build-time value is the answer in production. A localStorage override exists only
 * so a developer can point a local Portal at their own unpacked build without editing
 * .env and restarting — allowing it in production would let anything that can write to
 * localStorage redirect the Portal at an extension of its choosing.
 */
export function resolveExtensionId(
  configured: string | undefined,
  override: string | null,
  isProduction: boolean,
): string | null {
  if (!isProduction && override && EXTENSION_ID.test(override)) return override;
  return configured && EXTENSION_ID.test(configured) ? configured : null;
}

export function newRecordingId(random: () => string = () => crypto.randomUUID()): string {
  return "rec_" + random().replace(/-/g, "").slice(0, 12);
}

export function siteOrigins(sites: SiteOption[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sites) if (s.origin) out[s.code] = s.origin.replace(/\/+$/, "");
  return out;
}

/** origin -> site code, for turning a recorded step back into a site. */
export function originToSite(sites: SiteOption[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sites) if (s.origin) out[s.origin.replace(/\/+$/, "")] = s.code;
  return out;
}

/**
 * The absolute URL the extension should open.
 *
 * Guides store a PATH (`/trang-chu`); the origin comes from the site. Returns "" when
 * the guide has no site yet or the site has no origin — the caller must not start a
 * recording it cannot point anywhere.
 */
export function recordingStartUrl(siteCode: string | null, path: string, origins: Record<string, string>): string {
  if (!siteCode) return "";
  const origin = origins[siteCode];
  if (!origin) return "";
  const p = String(path || "").trim() || "/";
  if (/^https?:\/\//i.test(p)) return p;
  return origin + (p.startsWith("/") ? p : "/" + p);
}

export interface RecordReadiness {
  ok: boolean;
  /** Why the button is disabled, in the words the operator needs. */
  reason: string;
}

export function recordReadiness(opts: {
  extensionId: string | null;
  siteCode: string | null;
  startUrl: string;
  dirty: boolean;
}): RecordReadiness {
  if (!opts.extensionId) {
    return { ok: false, reason: "Chưa cấu hình extension (NEXT_PUBLIC_EXTENSION_ID) hoặc chưa cài extension." };
  }
  if (!opts.siteCode) return { ok: false, reason: "Gán site cho bộ này trước khi ghi." };
  if (!opts.startUrl) return { ok: false, reason: "Site của bộ này chưa có origin trong bảng sites." };
  // Recording ends by inserting steps into the editor. Starting with unsaved edits in
  // the form is fine — it is the same editing session — but the operator should know
  // the recorded steps land on top of what is already there.
  return { ok: true, reason: opts.dirty ? "Bộ đang có thay đổi chưa lưu; bước ghi mới sẽ nối vào cuối." : "" };
}

/**
 * Recorded clicks -> draft steps.
 *
 * Two things are decided here that the extension cannot know:
 *
 *  - **Does this click navigate?** If the next step was captured somewhere else — a
 *    different path, OR the same path on the other site — then it did, and the step
 *    becomes `click_wait_url` aimed at that page. Comparing paths alone is not enough:
 *    `/dashboard` exists on both POS and Admin, so a POS -> Admin hop that keeps the
 *    path would be filed as "stayed put" and the tour would never wait for the jump.
 *  - **Which site is this step on?** Only steps that left the guide's own site get a
 *    `siteOverride`; a step on the guide's site inherits it, per schema v5.
 *
 * The action is never an auto-click. Auto-click is the single biggest risk in the legacy
 * corpus (360 of 409 steps, firing at elements that may resolve wrong) and nothing that
 * generates guides should be adding more of it on its own.
 */
export function recordedToDraftSteps(
  recorded: RecordedStep[],
  opts: { guideSite: string | null; originSite: Record<string, string>; newId?: () => string },
): DraftStep[] {
  const newId = opts.newId ?? newStepId;
  const siteOf = (step: RecordedStep) => opts.originSite[String(step.origin || "").replace(/\/+$/, "")] ?? null;

  const originOf = (step: RecordedStep) => String(step.origin || "").replace(/\/+$/, "");

  return recorded.map((step, i) => {
    const next = recorded[i + 1];
    const site = siteOf(step);
    const nextSite = next ? siteOf(next) : null;
    // Origin, not site: two steps on origins that map to no known site are still two
    // different places, and comparing raw origins can never be wrong where sites differ.
    const navigates = !!next && (next.urlPattern !== step.urlPattern || originOf(next) !== originOf(step));

    const action: Record<string, unknown> = {
      type: navigates ? "click_wait_url" : "click_next",
      expectedUrl: navigates ? next.urlPattern : "",
      timeoutMs: 0,
    };
    // A hop to another site needs to say so, or the wait compares the new URL against
    // the wrong origin and never completes.
    if (navigates && nextSite && nextSite !== site) action.expectedSiteOverride = nextSite;

    return normalizeDraftStep(
      {
        selectors: step.selectors,
        matchText: step.matchText,
        tag: step.tag,
        title: "",
        content: "",
        urlPattern: step.urlPattern,
        navigationUrl: step.urlPattern,
        action,
      },
      {
        id: newId(),
        siteOverride: site && site !== opts.guideSite ? site : null,
      },
    );
  });
}

/**
 * Append mode: recorded steps go on the END of what the editor already has.
 *
 * Never a replacement. A recording is one pass over part of a workflow, and silently
 * discarding the rest of the guide because someone recorded three steps would destroy
 * work that took far longer to make than it takes to record.
 */
export function appendRecorded(
  existing: DraftStep[],
  recorded: RecordedStep[],
  opts: { guideSite: string | null; originSite: Record<string, string>; newId?: () => string },
): DraftStep[] {
  return [...existing, ...recordedToDraftSteps(recorded, opts)];
}
