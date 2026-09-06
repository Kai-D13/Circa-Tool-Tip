/**
 * Circa Tool-tip — validation.
 *
 * `validateDraftGuide` ports shared.js:92-149 `validateGuide` to the v5 shape and adds
 * the v5-only rules (step ids, known sites). Error vs warning is unchanged from v4:
 * an error is something that cannot run, a warning is something a human should look at.
 *
 * `validateReleasePayload` is the gate the extension runs BEFORE swapping a downloaded
 * release in. It is deliberately strict: a release that fails here is discarded and the
 * last-known-good stays in service.
 */

import { SCHEMA_VERSION, isActionType, isAutoClickAction, isWaitUrlAction } from "./constants.ts";
import { isUnmapped, looksBroadSelector, looksDynamicUrl } from "./normalize.ts";
import { normalizeText } from "./text.ts";
import { isWildcard, patternBase } from "./url-match.ts";
import type {
  DraftGuide,
  DraftStep,
  ReleasePayload,
  ReleaseStep,
  SiteCode,
  ValidationResult,
} from "./types.ts";

export interface ValidateGuideOptions {
  /** Known site codes. When given, siteOverride is checked against it. */
  knownSites?: SiteCode[];
  /** Require the guide to have a site (true once triage is done). */
  requireSite?: boolean;
}

export function validateDraftGuide(guide: DraftGuide, opts: ValidateGuideOptions = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const steps = (guide && guide.steps) || [];

  if (!String(guide?.name || "").trim()) errors.push("Bộ chưa có tên.");

  if (!steps.length) {
    errors.push("Bộ chưa có bước nào.");
    return { errors, warnings };
  }

  if (opts.requireSite && !guide.siteCode) {
    errors.push("Bộ chưa được gán site (POS hay Admin).");
  }

  const startUrl = String(guide.startUrl || "").trim();
  if (!startUrl && !String(steps[0].urlPattern || "").trim()) {
    errors.push("Chưa có 'URL bắt đầu' và bước 1 cũng chưa có URL — tour không biết mở trang nào.");
  }

  const seenIds = new Set<string>();

  steps.forEach((step, i) => {
    const n = i + 1;
    const label = "Bước " + n;
    const url = String(step.urlPattern || "").trim();
    const type = step.action?.type;

    if (!step.id) {
      errors.push(label + ": thiếu id.");
    } else if (seenIds.has(step.id)) {
      errors.push(label + ": id '" + step.id + "' bị trùng trong cùng bộ.");
    } else {
      seenIds.add(step.id);
    }

    if (!isActionType(type)) {
      errors.push(label + ": action '" + String(type) + "' không hợp lệ.");
      return;
    }

    if (step.siteOverride && opts.knownSites && opts.knownSites.indexOf(step.siteOverride) < 0) {
      errors.push(label + ": site '" + step.siteOverride + "' không tồn tại.");
    }

    if (!String(step.title || "").trim()) warnings.push(label + ": thiếu tiêu đề.");

    if (isUnmapped(step) && type !== "manual") {
      if (isAutoClickAction(type)) {
        errors.push(label + ": action TỰ click nhưng chưa chọn phần tử — không thể tự bấm.");
      } else {
        warnings.push(label + ": chưa chọn phần tử.");
      }
    }

    // A broad primary selector is only fatal when the step has nothing else to fall
    // back on. resolveTarget walks the candidate list and, for intent "exact", can also
    // re-anchor on matchText — so a broad selector plus a real text anchor still
    // resolves. Four legacy steps are exactly that case.
    const selectors = (step.selectors || []).filter((s) => !!String(s || "").trim());
    const primary = selectors[0] || "";
    if (looksBroadSelector(primary)) {
      const allBroad = selectors.length > 0 && selectors.every((s) => looksBroadSelector(s));
      const hasTextAnchor = !!normalizeText(step.matchText);
      if (allBroad && !hasTextAnchor) {
        errors.push(label + ": selector quá rộng (" + primary + ") và không có text để bám — chọn lại phần tử.");
      } else {
        warnings.push(
          label + ": selector chính quá rộng (" + primary + ") — đang dựa vào " +
            (hasTextAnchor ? "text anchor" : "candidate dự phòng") + ". Nên chọn lại phần tử.",
        );
      }
    }

    if (looksDynamicUrl(url)) {
      warnings.push(label + ": URL chứa ID cụ thể (" + truncate(url) + ") — nên dùng dạng * .");
    }

    // A wildcard step can only be reached by a preceding wait-url navigation, and that
    // navigation must aim at the same base path.
    if (isWildcard(url)) {
      const prev = steps[i - 1];
      const prevType = prev?.action?.type;
      const navOk = prevType === "click_wait_url" || prevType === "auto_click_wait_url";
      if (i === 0 || !navOk) {
        errors.push(
          label + " dùng URL động (" + truncate(url) + ") nhưng bước trước KHÔNG điều hướng tới nó. " +
            "Đặt action của bước " + (n - 1 || 1) + " là 'Click rồi chờ URL' hoặc 'Tự click rồi chờ URL'.",
        );
      } else {
        const dest = String(prev.action?.expectedUrl || url).trim();
        if (patternBase(dest) !== patternBase(url)) {
          errors.push(
            "Bước " + (n - 1) + " chờ URL '" + truncate(dest) + "' nhưng bước " + n + " là '" +
              truncate(url) + "' — đích KHÔNG khớp.",
          );
        }
      }
    }

    if (isWaitUrlAction(type)) {
      const explicit = String(step.action?.expectedUrl || "").trim();
      const nextUrl = String(steps[i + 1]?.urlPattern || "").trim();
      if (!explicit && !nextUrl) {
        errors.push(label + ": action 'chờ URL' thiếu 'URL trang đích' và bước sau cũng không có URL.");
      }
    }
  });

  return { errors, warnings };
}

function truncate(s: string, max = 120): string {
  const v = String(s || "");
  return v.length <= max ? v : v.slice(0, max) + "…(" + v.length + " ký tự)";
}

/**
 * Strict gate run by the extension before a downloaded release replaces the cached one.
 * Checksum verification is a separate async step (see checksum.ts) and is done by the
 * sync pipeline, not here, so this stays synchronous and usable in a validator loop.
 */
export function validateReleasePayload(payload: unknown, expectedSite?: SiteCode): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!payload || typeof payload !== "object") {
    return { errors: ["Release payload không phải object."], warnings };
  }
  const p = payload as Partial<ReleasePayload>;

  if (p.schemaVersion !== SCHEMA_VERSION) {
    errors.push("schemaVersion = " + String(p.schemaVersion) + ", cần " + SCHEMA_VERSION + ".");
  }
  if (!p.site) errors.push("Thiếu site.");
  if (expectedSite && p.site !== expectedSite) {
    errors.push("Release của site '" + String(p.site) + "' nhưng đang yêu cầu '" + expectedSite + "'.");
  }
  if (typeof p.revision !== "number" || !Number.isFinite(p.revision) || p.revision <= 0) {
    errors.push("revision không hợp lệ.");
  }
  if (!p.sites || typeof p.sites !== "object") {
    errors.push("Thiếu bản đồ sites (site -> origin).");
  }
  if (!Array.isArray(p.guides)) errors.push("guides không phải mảng.");
  if (!Array.isArray(p.groups)) errors.push("groups không phải mảng.");

  if (errors.length) return { errors, warnings };

  const sites = p.sites as Record<string, string>;
  for (const [code, origin] of Object.entries(sites)) {
    if (!/^https:\/\/[a-z0-9.-]+$/i.test(String(origin || ""))) {
      errors.push("Origin của site '" + code + "' không hợp lệ: " + String(origin));
    }
  }

  const groups = new Set(p.groups as string[]);
  const guideIds = new Set<string>();

  for (const guide of p.guides as ReleasePayload["guides"]) {
    const gLabel = "Guide '" + String(guide?.name || guide?.id || "?") + "'";
    if (!guide?.id) {
      errors.push(gLabel + ": thiếu id.");
      continue;
    }
    if (guideIds.has(guide.id)) errors.push(gLabel + ": id trùng.");
    guideIds.add(guide.id);

    if (!guide.site || !sites[guide.site]) {
      errors.push(gLabel + ": site '" + String(guide.site) + "' không có trong bản đồ sites.");
    }
    if (guide.group && !groups.has(guide.group)) {
      errors.push(gLabel + ": nhóm '" + guide.group + "' không có trong danh sách groups của release.");
    }
    if (!guide.start || !guide.start.site || !sites[guide.start.site]) {
      errors.push(gLabel + ": start.site không hợp lệ.");
    }
    if (!Array.isArray(guide.steps) || !guide.steps.length) {
      errors.push(gLabel + ": không có bước nào.");
      continue;
    }

    const stepIds = new Set<string>();
    guide.steps.forEach((step: ReleaseStep, i: number) => {
      const sLabel = gLabel + " bước " + (i + 1);
      if (!step?.id) errors.push(sLabel + ": thiếu id.");
      else if (stepIds.has(step.id)) errors.push(sLabel + ": id trùng.");
      else stepIds.add(step.id);

      // The v1.1 §P0-5 invariant: every released step names a real site.
      if (!step?.site || !sites[step.site]) {
        errors.push(sLabel + ": site '" + String(step?.site) + "' không hợp lệ.");
      }
      if (!isActionType(step?.action?.type)) {
        errors.push(sLabel + ": action không hợp lệ.");
      }
      if (!Array.isArray(step?.selectors)) {
        errors.push(sLabel + ": selectors không phải mảng.");
      }
    });
  }

  return { errors, warnings };
}

/** Convenience: does this draft step still need a human before it can be trusted? */
export function stepNeedsRepair(step: DraftStep): boolean {
  return (step.flags || []).length > 0;
}
