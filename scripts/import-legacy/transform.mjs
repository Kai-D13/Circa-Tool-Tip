/**
 * Step 4 of the legacy import: v4 guide -> v5 DraftGuide.
 *
 * Ordering matters and is deliberate:
 *   scrub URLs  ->  materialize expectedUrl  ->  normalize  ->  flag  ->  validate
 *
 * expectedUrl must be computed from the SCRUBBED next-step pattern, otherwise a wait
 * target would point at a URL that no longer exists after scrubbing.
 */

import { createHash } from "node:crypto";

import { computeGuideFlags, computeStepFlags } from "../../packages/guide-schema/src/flags.ts";
import { normalizeDraftStep } from "../../packages/guide-schema/src/normalize.ts";
import { validateDraftGuide } from "../../packages/guide-schema/src/validate.ts";
import { isWaitUrlAction, isActionType } from "../../packages/guide-schema/src/constants.ts";
import { classifyGuide } from "./classify.mjs";
import { scrubStepUrls } from "./scrub.mjs";

/**
 * Deterministic step id: the same source file always produces the same ids, so a re-run
 * is diffable and `admin_import_legacy` stays idempotent.
 */
export function legacyStepId(legacyGuideId, index) {
  const hash = createHash("sha256").update(`${legacyGuideId}:${index}`).digest("hex");
  return "st_" + hash.slice(0, 10);
}

export function transformGuide(legacyGuide, opts = {}) {
  const legacySteps = legacyGuide.steps || [];

  // 1. Scrub every URL first.
  const scrubbed = legacySteps.map((step) => ({
    raw: step,
    ...scrubStepUrls(step),
  }));

  // 2. Materialize wait targets from the SCRUBBED next-step pattern.
  const steps = scrubbed.map((entry, i) => {
    const type = entry.raw?.action?.type;
    const expectedUrl = isActionType(type) && isWaitUrlAction(type)
      ? scrubbed[i + 1]?.urlPattern || ""
      : undefined;

    const draft = normalizeDraftStep(
      { ...entry.raw, urlPattern: entry.urlPattern, navigationUrl: entry.navigationUrl },
      { id: legacyStepId(legacyGuide.id, i), expectedUrl },
    );
    return { draft, scrubFlags: entry.flags, rawMatchText: String(entry.raw?.matchText ?? "") };
  });

  const draftSteps = steps.map((s) => s.draft);

  // 3. Flag each step now that the whole (scrubbed) list exists.
  steps.forEach((entry, i) => {
    entry.draft.flags = computeStepFlags(entry.draft, {
      index: i,
      steps: draftSteps,
      rawMatchText: entry.rawMatchText,
      extra: entry.scrubFlags,
    });
    if (!entry.draft.flags.length) delete entry.draft.flags;
  });

  const scrubbedStartUrl = scrubStepUrls({ urlPattern: legacyGuide.startUrl, navigationUrl: "" }).urlPattern;

  const guide = {
    legacyId: legacyGuide.id,
    name: String(legacyGuide.name || "").trim(),
    siteCode: null,
    groupName: "",
    status: "unassigned",
    startUrl: scrubbedStartUrl,
    sortOrder: opts.sortOrder ?? 0,
    steps: draftSteps,
  };

  const { siteGuess, siteEvidence } = classifyGuide({
    name: guide.name,
    startUrl: guide.startUrl,
    steps: draftSteps,
  });
  guide.siteGuess = siteGuess;
  guide.siteEvidence = siteEvidence;

  guide.flags = computeGuideFlags(guide, { duplicateNames: opts.duplicateNames });
  if (!guide.flags.length) delete guide.flags;

  // requireSite is intentionally false: the whole point of the import is that the site
  // is not known yet. The database CHECK enforces it before publish instead.
  guide.validation = validateDraftGuide(guide, { requireSite: false });

  return guide;
}

export function findDuplicateNames(legacyGuides) {
  const seen = new Map();
  for (const g of legacyGuides) {
    const key = String(g.name || "").trim().toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
}
