/**
 * Circa Tool-tip — schema v5 type definitions.
 *
 * Two step shapes exist on purpose (Plan v1.1 §P0-5):
 *   - DraftStep   : what the portal edits. Site is INHERITED from the guide.
 *   - ReleaseStep : what ships to the extension. Site is MATERIALIZED and REQUIRED.
 *
 * Only erasable TypeScript syntax is used anywhere in this package: Node 24 strips
 * types, it does not transform them. No enum, no namespace, no decorators.
 */

/** Site code, e.g. "pos" | "admin". Data-driven — comes from the `sites` table. */
export type SiteCode = string;

export type ActionType =
  | "highlight"
  | "click_next"
  | "click_wait_url"
  | "auto_click_next"
  | "auto_click_wait_url"
  | "wait_element"
  | "manual";

export type UrlMatchMode = "path" | "path_query" | "exact" | "wildcard";

export type Intent = "exact" | "first_item";

export type Position = "auto" | "top" | "bottom" | "left" | "right";

export type GuideStatus = "unassigned" | "draft" | "published" | "archived";

export interface StepAction {
  type: ActionType;
  /** Materialized at import: steps[i+1].urlPattern for wait-url actions. */
  expectedUrl: string;
  /** Only when the wait target lives on another site. */
  expectedSiteOverride?: SiteCode;
  /** 0 means "use the runtime default". */
  timeoutMs: number;
}

export interface DraftStep {
  id: string;
  /** Present ONLY when this step crosses to a different site than its guide. */
  siteOverride?: SiteCode;
  selectors: string[];
  matchText: string;
  matchTextStable?: boolean;
  tag: string;
  title: string;
  content: string;
  /** Omitted when "exact". */
  intent?: Intent;
  /** Omitted when "auto". */
  position?: Position;
  urlPattern: string;
  navigationUrl: string;
  /** Omitted when identical to inferUrlMatchMode(urlPattern). */
  urlMatchMode?: UrlMatchMode;
  action: StepAction;
  /** Authoring-only. Stripped from the release payload. */
  flags?: string[];
}

export interface ReleaseStep {
  id: string;
  /** REQUIRED in a release. Resolved as siteOverride ?? guide.site_code. */
  site: SiteCode;
  selectors: string[];
  matchText: string;
  matchTextStable?: boolean;
  tag: string;
  title: string;
  content: string;
  intent?: Intent;
  position?: Position;
  urlPattern: string;
  navigationUrl: string;
  urlMatchMode?: UrlMatchMode;
  action: StepAction;
}

/** Anything the URL matcher can accept: draft or release step. */
export type AnyStep = DraftStep | ReleaseStep;

export interface DraftGuide {
  id?: string;
  legacyId?: string;
  name: string;
  /** null while the guide is still unassigned. */
  siteCode: SiteCode | null;
  /** Plain label used to group guides in the menu. No separate table. */
  groupName?: string | null;
  status: GuideStatus;
  startUrl: string;
  sortOrder?: number;
  steps: DraftStep[];
  /** Importer heuristic. Never auto-applied — a human assigns siteCode. */
  siteGuess?: SiteCode | null;
  siteEvidence?: Record<string, unknown>;
  flags?: string[];
}

export interface ReleaseGuideStart {
  site: SiteCode;
  url: string;
}

export interface ReleaseGuide {
  id: string;
  legacyId: string | null;
  name: string;
  site: SiteCode;
  /** Menu grouping label, or null for "ungrouped". */
  group: string | null;
  sortOrder: number;
  start: ReleaseGuideStart;
  steps: ReleaseStep[];
}

export interface ReleasePayload {
  schemaVersion: number;
  site: SiteCode;
  revision: number;
  releasedAt: string;
  checksum: string;
  /** site code -> origin, e.g. { pos: "https://pos.v2.circa.vn" } */
  sites: Record<SiteCode, string>;
  /** Distinct group labels present in this release, in menu order. */
  groups: string[];
  guides: ReleaseGuide[];
}

/** The parts of `location` the URL matcher needs. Keeps the matcher DOM-free. */
export interface LocationParts {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
}

/** Context a step needs to be resolved against a real browser location. */
export interface MatchContext {
  sites: Record<SiteCode, string>;
  /** Site of the guide the step belongs to; used when the step has no own site. */
  guideSite?: SiteCode | null;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}
