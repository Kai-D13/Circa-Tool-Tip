import { resolveStepUrl, type DraftStep } from "@circa/guide-schema";

import type { SiteOption } from "./types";

/**
 * Pure logic for the two on-page tools: checking a step's selectors, and walking a draft
 * guide. No React, no chrome APIs.
 *
 * The rule both tools obey, and the reason they live here rather than in a component:
 * **nothing is written anywhere.** A probe reads the page. A preview carries the draft in
 * the message it sends and reads nothing back. No Supabase call, no release, no save —
 * which is exactly what makes it safe to run against production POS while a guide is
 * still being written.
 */

/** One selector candidate, as the page actually found it. */
export interface ProbeCandidate {
  selector: string;
  count: number;
  textMatches: number;
  invalid: boolean;
}

export interface ProbeResult {
  ok: boolean;
  candidates: ProbeCandidate[];
  matchText: string;
  resolved: { selector: string; selectorIndex: number; via: string; count: number } | null;
  reason: string;
}

export function newToolSessionId(prefix: string, random: () => string = () => crypto.randomUUID()): string {
  return prefix + "_" + random().replace(/-/g, "").slice(0, 12);
}

/** site code -> origin, with any trailing slash removed. */
export function originsOf(sites: SiteOption[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sites) if (s.origin) out[s.code] = s.origin.replace(/\/+$/, "");
  return out;
}

/**
 * The page a step lives on.
 *
 * Resolved against the STEP's own site, not the guide's: an Admin step inside a POS guide
 * has to be probed on the Admin origin, or the probe reports "không tìm thấy" for a step
 * that is perfectly fine. A wildcard step describes a family of pages and cannot be opened
 * directly, so the guide's start URL is used instead.
 */
export function stepPageUrl(
  step: DraftStep,
  guideSite: string | null,
  startUrl: string,
  origins: Record<string, string>,
): string {
  const direct = resolveStepUrl(step, { sites: origins, guideSite });
  if (direct) return direct;

  const site = step.siteOverride || guideSite;
  const origin = site ? origins[site] : "";
  if (!origin) return "";
  const path = String(startUrl || "").trim() || "/";
  if (/^https?:\/\//i.test(path)) return path;
  return origin + (path.startsWith("/") ? path : "/" + path);
}

export interface ToolReadiness {
  ok: boolean;
  reason: string;
}

export function probeReadiness(opts: {
  extensionId: string | null;
  siteCode: string | null;
  step: DraftStep;
  url: string;
}): ToolReadiness {
  if (!opts.extensionId) return { ok: false, reason: "Chưa cài hoặc chưa cấu hình extension." };
  if (!opts.siteCode) return { ok: false, reason: "Gán site cho bộ này trước đã." };
  if (!opts.url) return { ok: false, reason: "Không xác định được trang để mở — bước chưa có URL." };
  if (!(opts.step.selectors || []).some((s) => String(s || "").trim())) {
    return { ok: false, reason: "Bước này chưa có selector nào để kiểm tra." };
  }
  return { ok: true, reason: "" };
}

export function previewReadiness(opts: {
  extensionId: string | null;
  siteCode: string | null;
  steps: DraftStep[];
  url: string;
}): ToolReadiness {
  if (!opts.extensionId) return { ok: false, reason: "Chưa cài hoặc chưa cấu hình extension." };
  if (!opts.siteCode) return { ok: false, reason: "Gán site cho bộ này trước đã." };
  if (!opts.steps.length) return { ok: false, reason: "Bộ này chưa có bước nào để chạy thử." };
  if (!opts.url) return { ok: false, reason: "Chưa xác định được trang bắt đầu." };
  return { ok: true, reason: "" };
}

/**
 * What to send for a probe. The step travels whole: the extension resolves it with the
 * SAME code the tour runtime uses, so a probe cannot report something the runtime would
 * then disagree with.
 */
export function probeRequest(opts: {
  sessionId: string;
  guideId: string;
  siteCode: string | null;
  step: DraftStep;
  url: string;
}) {
  return {
    v: 1,
    type: "PROBE_SELECTOR",
    payload: {
      sessionId: opts.sessionId,
      probeId: opts.step.id,
      guideId: opts.guideId,
      site: opts.siteCode,
      url: opts.url,
      step: opts.step,
    },
  };
}

/**
 * What to send for a preview. The draft goes in the message — that is the whole point:
 * the guide being rehearsed is the one on screen, unsaved, and no release is involved.
 */
export function previewRequest(opts: {
  sessionId: string;
  guideId: string;
  name: string;
  siteCode: string | null;
  steps: DraftStep[];
  url: string;
  origins: Record<string, string>;
}) {
  return {
    v: 1,
    type: "PREVIEW_GUIDE",
    payload: {
      sessionId: opts.sessionId,
      guideId: opts.guideId,
      site: opts.siteCode,
      url: opts.url,
      guide: { name: opts.name, site: opts.siteCode, steps: opts.steps },
      sites: opts.origins,
    },
  };
}

export type ProbeTone = "ok" | "warn" | "bad" | "idle";

export interface ProbeSummary {
  tone: ProbeTone;
  label: string;
  detail: string;
}

/**
 * A probe result in the words the person editing the step needs.
 *
 * "Resolved" is not the same as "healthy": a step found only through its text anchor, or
 * only by taking the first of several matches, will keep working right up until the day
 * it does not. Those are warnings, not passes.
 */
export function summarizeProbe(result: ProbeResult | null | undefined): ProbeSummary {
  if (!result) return { tone: "idle", label: "Chưa kiểm tra", detail: "" };

  const counts = result.candidates.map((c) => (c.invalid ? "lỗi cú pháp" : `${c.count}`)).join(" / ");
  const detail = `Khớp: ${counts || "—"}`;

  if (!result.ok) return { tone: "bad", label: "Không tìm được", detail: result.reason || detail };

  switch (result.resolved?.via) {
    case "text":
      return { tone: "ok", label: `Khớp ${result.resolved.count}, text lọc còn 1`, detail };
    case "text-fallback":
      return { tone: "warn", label: "Chỉ tìm được bằng text", detail: "Selector không dùng được — nên chọn lại phần tử." };
    case "first_item":
      return { tone: "warn", label: "Lấy phần tử đầu tiên", detail: "Nhiều element khớp; đang dựa vào intent first_item." };
    default:
      return { tone: "ok", label: "Khớp đúng 1 element", detail };
  }
}
