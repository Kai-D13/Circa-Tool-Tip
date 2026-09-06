/** Circa Tool-tip — schema v5 constants. */

import type { ActionType, UrlMatchMode } from "./types.ts";

export const SCHEMA_VERSION = 5;

/** Legacy export envelope this package can import from. */
export const LEGACY_SCHEMA_VERSION = 4;
export const LEGACY_ENVELOPE_TYPE = "tooltip-guide-config";

export const ACTION_TYPES: ActionType[] = [
  "highlight",
  "click_next",
  "click_wait_url",
  "auto_click_next",
  "auto_click_wait_url",
  "wait_element",
  "manual",
];

/** Actions that arm a navigation wait and therefore need an expectedUrl. */
export const WAIT_URL_ACTIONS: ActionType[] = ["click_wait_url", "auto_click_wait_url"];

/** Actions the extension performs without the user clicking. */
export const AUTO_CLICK_ACTIONS: ActionType[] = ["auto_click_next", "auto_click_wait_url"];

/** Actions that require a resolvable target element. */
export const TARGET_REQUIRED_ACTIONS: ActionType[] = [
  "highlight",
  "click_next",
  "click_wait_url",
  "auto_click_next",
  "auto_click_wait_url",
  "wait_element",
];

export const URL_MATCH_MODES: UrlMatchMode[] = ["path", "path_query", "exact", "wildcard"];

export const DEFAULT_INTENT = "exact";
export const DEFAULT_POSITION = "auto";

/** Runtime waits, ported from content.js:44 and content.js:1031. */
export const DEFAULT_WAIT_TIMEOUT_MS = 7000;
export const WAIT_ELEMENT_TIMEOUT_MS = 15000;
export const DEFAULT_NAV_TIMEOUT_MS = 9000;
/** Cross-origin hops may land on a login screen first (Plan v1.1 §7, R8). */
export const CROSS_SITE_NAV_TIMEOUT_MS = 300000;

/** Longest urlPattern in the legacy corpus is 1101 chars; warn past this. */
export const URL_LENGTH_WARN = 512;

export function isActionType(v: unknown): v is ActionType {
  return typeof v === "string" && ACTION_TYPES.indexOf(v as ActionType) >= 0;
}

export function isWaitUrlAction(t: ActionType): boolean {
  return WAIT_URL_ACTIONS.indexOf(t) >= 0;
}

export function isAutoClickAction(t: ActionType): boolean {
  return AUTO_CLICK_ACTIONS.indexOf(t) >= 0;
}

export function requiresTarget(t: ActionType): boolean {
  return TARGET_REQUIRED_ACTIONS.indexOf(t) >= 0;
}
