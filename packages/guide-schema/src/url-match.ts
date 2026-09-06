/**
 * Circa Tool-tip — the ONE URL matcher (Plan v1.1 §8).
 *
 * The v2.4.9 extension had two matchers that disagreed:
 *   - urlMatches(pattern)   content.js:147 — used for render/resume at 7 call sites
 *   - stepUrlMatches(step)  content.js:289 — honoured urlMatchMode, used at only 2
 * A step whose match depends on a query filter could therefore render against the wrong
 * POS state. This module replaces both. `urlMatches(pattern)` is deliberately NOT
 * exported: every caller passes a step-shaped object so the route guard, the render
 * check and the navigation poller all run identical logic.
 *
 * Two behaviour changes versus v4, both intentional:
 *   1. Origin is compared first, so a step on `admin` never matches while on `pos`
 *      even when the path coincides. This is what makes the POS->Admin handoff safe.
 *   2. Wildcard patterns are ANCHORED at the start of the path. In v4
 *      `wildcardToRegExp` was unanchored, so `/ban-hang*` also matched
 *      `/xx/ban-hang-online`. Affects the 91 wildcard steps -> must be evidenced by
 *      the Batch 4 replay before merging (Plan v1.1 R4).
 *
 * DOM-free by design so it is unit-testable in Node.
 */

import type {
  AnyStep,
  LocationParts,
  MatchContext,
  SiteCode,
  UrlMatchMode,
} from "./types.ts";

/* ------------------------------------------------------------------ wildcard */

export function isWildcard(pattern: string): boolean {
  return String(pattern || "").indexOf("*") >= 0;
}

/**
 * Anchored at the start of `pathname + search + hash`.
 * v4 built an unanchored regex (content.js:139-145); the leading `^` is the fix.
 */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = String(pattern || "")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$", "i");
}

/* --------------------------------------------------------------- match modes */

/**
 * Ported from shared.js:35 `inferUrlMatchMode` / content.js:271 `inferModeFromPattern`,
 * which were byte-identical duplicates. This is the single surviving copy.
 */
export function inferUrlMatchMode(urlPattern: string, explicit?: string): UrlMatchMode | "" {
  if (explicit === "path" || explicit === "path_query" || explicit === "exact" || explicit === "wildcard") {
    return explicit;
  }
  const u = String(urlPattern || "");
  if (!u) return "";
  if (u.indexOf("*") >= 0) return "wildcard";
  if (u.indexOf("?") >= 0) return "path_query";
  return "path";
}

export function resolveMatchMode(step: AnyStep): UrlMatchMode | "" {
  return inferUrlMatchMode(step.urlPattern, step.urlMatchMode);
}

/* ---------------------------------------------------------------- URL pieces */

export function pathOnly(url: string): string {
  let u = String(url || "");
  const h = u.indexOf("#");
  if (h >= 0) u = u.slice(0, h);
  const q = u.indexOf("?");
  if (q >= 0) u = u.slice(0, q);
  return u;
}

export function patternQuery(pattern: string): string {
  const p = String(pattern || "");
  const q = p.indexOf("?");
  if (q < 0) return "";
  const rest = p.slice(q + 1);
  const h = rest.indexOf("#");
  return h < 0 ? rest : rest.slice(0, h);
}

/** Query keys whose value changes on its own and must never gate a match. */
export function isVolatileKey(key: string): boolean {
  return /date|time|timestamp|^_/.test(key);
}

/** Decoded, lowercased, empty and volatile keys dropped. Ported from content.js:252. */
export function meaningfulParams(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = String(search || "").replace(/^[?]/, "");
  if (!raw) return out;
  for (const chunk of raw.split("&")) {
    if (!chunk) continue;
    const eq = chunk.indexOf("=");
    const rawKey = eq < 0 ? chunk : chunk.slice(0, eq);
    const rawVal = eq < 0 ? "" : chunk.slice(eq + 1);
    let key: string;
    let val: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, " ")).trim().toLowerCase();
    } catch {
      key = rawKey.trim().toLowerCase();
    }
    try {
      val = decodeURIComponent(rawVal.replace(/\+/g, " ")).trim().toLowerCase();
    } catch {
      val = rawVal.trim().toLowerCase();
    }
    if (!key || !val) continue;
    if (isVolatileKey(key)) continue;
    out[key] = val;
  }
  return out;
}

/** Path prefix before the first wildcard. Ported from shared.js:68 `patternBase`. */
export function patternBase(pattern: string): string {
  const p = pathOnly(pattern);
  const star = p.indexOf("*");
  const base = star < 0 ? p : p.slice(0, star);
  return base.replace(/\/+$/, "").toLowerCase();
}

/** Split an href, or a path-only string, into the parts the matcher needs. */
export function parseLocation(href: string, fallbackOrigin?: string): LocationParts {
  const s = String(href || "");
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    return { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash };
  }
  const hashIdx = s.indexOf("#");
  const hash = hashIdx >= 0 ? s.slice(hashIdx) : "";
  const noHash = hashIdx >= 0 ? s.slice(0, hashIdx) : s;
  const qIdx = noHash.indexOf("?");
  const search = qIdx >= 0 ? noHash.slice(qIdx) : "";
  const pathname = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
  return {
    origin: fallbackOrigin || "",
    pathname: pathname || "/",
    search,
    hash,
  };
}

export function normalizeOrigin(origin: string): string {
  return String(origin || "").trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * `/ban-hang` matches `/ban-hang` and `/ban-hang/123`, but NOT `/ban-hang-online`.
 * Ported from content.js:159-168.
 */
export function pathBoundaryMatches(pathname: string, patternPath: string): boolean {
  const p = String(pathname || "").toLowerCase().replace(/\/+$/, "") || "/";
  const q = String(patternPath || "").toLowerCase().replace(/\/+$/, "") || "/";
  if (q === "/") return true;
  if (p === q) return true;
  return p.startsWith(q + "/");
}

/* ------------------------------------------------------------------- site */

/**
 * Which site does this step belong to?
 * Release steps carry `site`; draft steps carry `siteOverride` only when they cross
 * sites, otherwise they inherit the guide's site (Plan v1.1 §P0-5).
 */
export function stepSite(step: AnyStep, ctx: MatchContext): SiteCode | null {
  const asRelease = step as { site?: SiteCode };
  const asDraft = step as { siteOverride?: SiteCode };
  return asRelease.site || asDraft.siteOverride || ctx.guideSite || null;
}

/* --------------------------------------------------------------- the matcher */

/**
 * The single source of truth for "is this step's page currently open?".
 * Used by the route guard, renderStep, the navigation poller and resume alike.
 */
export function stepMatchesLocation(step: AnyStep, loc: LocationParts, ctx: MatchContext): boolean {
  const site = stepSite(step, ctx);
  if (site) {
    const expected = ctx.sites ? ctx.sites[site] : undefined;
    // An unknown site can never match: better to stall visibly than to act on the
    // wrong origin with business auto-click enabled.
    if (!expected) return false;
    if (normalizeOrigin(loc.origin) !== normalizeOrigin(expected)) return false;
  }

  const pattern = String(step.urlPattern || "").trim();
  // No pattern means "anywhere on this site" — v4 behaviour (content.js:148-150).
  if (!pattern) return true;

  const mode = resolveMatchMode(step);

  if (mode === "wildcard") {
    const subject = String(loc.pathname || "") + String(loc.search || "") + String(loc.hash || "");
    return wildcardToRegExp(pattern).test(subject);
  }

  if (!pathBoundaryMatches(loc.pathname, pathOnly(pattern))) return false;
  if (mode === "path" || mode === "") return true;

  const want = meaningfulParams(patternQuery(pattern));
  const have = meaningfulParams(loc.search);
  const wantKeys = Object.keys(want);

  if (mode === "exact") {
    if (wantKeys.length !== Object.keys(have).length) return false;
    return wantKeys.every((k) => have[k] === want[k]);
  }

  // path_query: every pattern param must be present and equal; extras are allowed.
  return wantKeys.every((k) => have[k] === want[k]);
}

/* ------------------------------------------------------------- navigation */

/**
 * The URL to navigate to for this step, or "" when the step must not be navigated to
 * directly (wildcard patterns describe a family of pages, not one page).
 * Ported from content.js:314 `getStepNavigationUrl`.
 */
export function getStepNavigationPath(step: AnyStep): string {
  const nav = String(step.navigationUrl || "").trim();
  if (nav) return nav;
  const pattern = String(step.urlPattern || "").trim();
  if (pattern && !isWildcard(pattern)) return pattern;
  return "";
}

/**
 * Absolute URL for a step, resolved against ITS OWN site rather than location.origin.
 * v4 did `location.origin + path` (content.js:196-201), which silently kept an Admin
 * step on the POS origin. Returns "" when the step must not be navigated to.
 */
export function resolveStepUrl(step: AnyStep, ctx: MatchContext): string {
  const path = getStepNavigationPath(step);
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const site = stepSite(step, ctx);
  const origin = site && ctx.sites ? ctx.sites[site] : undefined;
  if (!origin) return "";
  return normalizeOrigin(origin) + (path.startsWith("/") ? path : "/" + path);
}

/**
 * Where a wait-url action should land. Falls back to the next step's pattern, which is
 * how v4 actually behaved (content.js:836) — expectedUrl is empty on all 409 legacy
 * steps, so reading it alone would hang every waiting step.
 */
export function resolveExpectedUrl(steps: AnyStep[], index: number): string {
  const step = steps[index];
  if (!step) return "";
  const explicit = String(step.action?.expectedUrl || "").trim();
  if (explicit) return explicit;
  const next = steps[index + 1];
  return next ? String(next.urlPattern || "").trim() : "";
}
