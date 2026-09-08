import { FLAGS } from "@circa/guide-schema";

import { hasWarnings } from "./triage.ts";
import type {
  GuideRow,
  GuideStatus,
  ListReleasesResult,
  PublishResult,
  ReleaseHeadRow,
  RollbackResult,
} from "./types";

/**
 * Publishing and rolling back a site, as pure logic.
 *
 * Shaped after `runBulkAssign` in ./bulk-assign: plain functions plus one async
 * orchestrator whose side effects are injected. No React, no Supabase — so every claim
 * the stakeholder asked to see proven is a real behavioural test rather than a grep for
 * `disabled={...}` in a component.
 *
 * Three things live here that could not be checked if they lived in a component:
 *
 *   - the publish gate runs BEFORE the RPC, so "locked when nothing is approved" and
 *     "the note is mandatory" are provable by call count;
 *   - the single-flight guard is a mutable box, not React state, because two clicks in
 *     one tick both read the same stale `useState` value;
 *   - a failure leaves `head` and `history` exactly as they were, so "keep the screen as
 *     it was" is an assertion and not a promise.
 */

/* ------------------------------------------------------------------ view model */

export interface ApprovedGuide {
  id: string;
  name: string;
  stepCount: number;
  /** Carries GUIDE_HAS_AUTO_CLICK_UNANCHORED — the biggest risk in the legacy corpus. */
  hasAutoClickFlag: boolean;
  hasWarnings: boolean;
}

export interface HistoryRow {
  id: string;
  revision: number;
  checksum: string;
  guideCount: number;
  stepCount: number;
  /** The uuid from the RPC, already resolved to the revision number it refers to. */
  rolledBackFromRevision: number | null;
  note: string | null;
  releasedAt: string;
  releasedByEmail: string | null;
  /** This is the release the extension is actually running. */
  isHead: boolean;
}

export interface SiteReleaseState {
  site: string;
  head: ReleaseHeadRow | null;
  history: HistoryRow[];
  approved: ApprovedGuide[];
  draftCount: number;
  approvedStepTotal: number;
  /** Raw message from the last failed RPC, or null. */
  error: string | null;
  /** The last successful publish/rollback, for showing the server's real numbers. */
  lastResult: PublishResult | RollbackResult | null;
}

export const EMPTY_RELEASE_TEXT = "Chưa có bản phát hành";

/**
 * Resolve `rolledBackFrom` from a uuid to the revision it points at, and mark the head.
 *
 * Done once, here, rather than in JSX: `admin_list_releases` returns every release of the
 * site, so the lookup is complete by construction, and after this no downstream code
 * holds a `rolledBackFrom` that might be either a uuid or a number. A uuid that cannot be
 * resolved becomes null and renders as "—" — never `undefined`, never a throw.
 */
export function toHistoryRows(list: ListReleasesResult): HistoryRow[] {
  const rows = list.releases ?? [];
  const revisionById = new Map(rows.map((r) => [r.id, r.revision]));
  const headId = list.head?.release_id ?? null;

  return rows.map((r) => ({
    id: r.id,
    revision: r.revision,
    checksum: r.checksum,
    guideCount: r.guideCount,
    stepCount: r.stepCount,
    rolledBackFromRevision: r.rolledBackFrom ? (revisionById.get(r.rolledBackFrom) ?? null) : null,
    note: r.note,
    releasedAt: r.releasedAt,
    releasedByEmail: r.releasedByEmail,
    isHead: headId !== null && r.id === headId,
  }));
}

/**
 * Count guides by status from the rows of ONE site.
 *
 * `admin_list_guides.counts` cannot be used here: its sub-selects have no site filter, so
 * it reports the same global totals whatever `p_site` was passed.
 */
export function countByStatus(guides: GuideRow[]): Record<GuideStatus, number> {
  const counts: Record<GuideStatus, number> = { unassigned: 0, draft: 0, published: 0, archived: 0 };
  for (const g of guides) {
    if (g.status in counts) counts[g.status] += 1;
  }
  return counts;
}

function approvedFrom(guides: GuideRow[]): ApprovedGuide[] {
  // Already ordered by sort_order, name from SQL — no client sort.
  return guides
    .filter((g) => g.status === "published")
    .map((g) => ({
      id: g.id,
      name: g.name,
      stepCount: g.step_count,
      hasAutoClickFlag: (g.validation?.flags ?? []).includes(FLAGS.GUIDE_HAS_AUTO_CLICK_UNANCHORED),
      hasWarnings: hasWarnings(g),
    }));
}

export function siteStateFrom(site: string, releases: ListReleasesResult, guides: GuideRow[]): SiteReleaseState {
  const approved = approvedFrom(guides);
  return {
    site,
    head: releases.head ?? null,
    history: toHistoryRows(releases),
    approved,
    draftCount: countByStatus(guides).draft,
    approvedStepTotal: approved.reduce((sum, g) => sum + g.stepCount, 0),
    error: null,
    lastResult: null,
  };
}

/* ------------------------------------------------------------------ derivations */

/**
 * True when nothing has ever shipped for this site.
 *
 * Two shapes mean this, and both are accepted so the conventions cannot drift apart:
 * `admin_list_releases` returns `head: null`, while `get_release` — the extension's data
 * plane — returns `revision: 0`.
 */
export function isUnreleased(head: ReleaseHeadRow | null): boolean {
  return !head || !(head.revision > 0);
}

export function currentRevision(head: ReleaseHeadRow | null): number {
  return isUnreleased(head) ? 0 : head!.revision;
}

/**
 * The revision a publish would mint.
 *
 * `max(every revision) + 1`, not `head + 1`: a rollback leaves the head pointing at a
 * lower payload than the highest revision that exists, and the SQL takes the max.
 */
export function nextRevision(state: SiteReleaseState): number {
  const highest = state.history.reduce((max, r) => (r.revision > max ? r.revision : max), 0);
  return Math.max(highest, currentRevision(state.head)) + 1;
}

export function revisionText(head: ReleaseHeadRow | null): string {
  return `Revision: ${currentRevision(head)}`;
}

export function headText(head: ReleaseHeadRow | null): string {
  return isUnreleased(head) ? EMPTY_RELEASE_TEXT : head!.released_at;
}

/** Just a string trim — the client never computes a checksum, only shortens one. */
export function shortChecksum(checksum: string | null | undefined): string {
  const s = String(checksum ?? "").trim();
  if (!s) return "—";
  const hex = s.startsWith("sha256:") ? s.slice("sha256:".length) : s;
  return hex.length <= 12 ? s : `sha256:${hex.slice(0, 12)}…`;
}

/* ------------------------------------------------------------------------ gates */

export interface Gate {
  ok: boolean;
  reason: string;
}

export function publishGate(input: { approvedCount: number; note: string; busy: boolean }): Gate {
  if (input.busy) return { ok: false, reason: "Đang phát hành…" };
  if (input.approvedCount <= 0) {
    return { ok: false, reason: "Chưa có bộ nào được duyệt cho lần phát hành tiếp theo." };
  }
  // A release nobody can explain later is a release nobody can decide to roll back to.
  if (!input.note.trim()) return { ok: false, reason: "Nhập ghi chú phát hành trước đã." };
  return { ok: true, reason: "" };
}

export function rollbackGate(row: HistoryRow, head: ReleaseHeadRow | null, busy: boolean): Gate {
  if (busy) return { ok: false, reason: "Đang xử lý…" };
  if (isUnreleased(head)) return { ok: false, reason: "Site này chưa có bản phát hành nào." };
  if (row.isHead) return { ok: false, reason: "Đây đang là bản hiện hành — không cần rollback." };
  return { ok: true, reason: "" };
}

/* ---------------------------------------------------------------- single flight */

/**
 * A mutable box, on purpose.
 *
 * React state updates are not synchronous, so two clicks landing before a re-render both
 * read `busy === false` and both fire. The guard has to be something that can be set and
 * read within one tick, which is why the component holds this in a `useRef` rather than
 * `useState`.
 *
 * This covers one operator double-clicking. Two browser tabs still send two requests —
 * the per-site advisory lock serialises them and `unique (site_code, revision)` rejects
 * the loser with 23505. Do not "fix" that here with a lock table.
 */
export interface Flight {
  busy: boolean;
}

export function newFlight(): Flight {
  return { busy: false };
}

/* --------------------------------------------------------------- orchestrators */

export interface ReleaseDeps {
  publish: (site: string, note: string) => Promise<PublishResult>;
  rollback: (site: string, releaseId: string) => Promise<RollbackResult>;
  reload: (site: string) => Promise<ListReleasesResult>;
}

export type Outcome =
  | { status: "blocked"; reason: string }
  | { status: "busy" }
  | { status: "error"; message: string }
  | { status: "ok"; result: PublishResult | RollbackResult; releases: ListReleasesResult };

function messageOf(err: unknown): string {
  // Verbatim. The Postgres text is the only thing that says WHICH guide blocked a publish.
  return err instanceof Error ? err.message : String(err);
}

export async function runPublish(
  flight: Flight,
  input: { site: string; note: string; approvedCount: number },
  deps: ReleaseDeps,
): Promise<Outcome> {
  const gate = publishGate({ approvedCount: input.approvedCount, note: input.note, busy: false });
  if (!gate.ok) return { status: "blocked", reason: gate.reason };
  if (flight.busy) return { status: "busy" };

  flight.busy = true;
  try {
    const result = await deps.publish(input.site, input.note);
    const releases = await deps.reload(input.site);
    return { status: "ok", result, releases };
  } catch (err) {
    return { status: "error", message: messageOf(err) };
  } finally {
    flight.busy = false;
  }
}

export async function runRollback(
  flight: Flight,
  input: { site: string; row: HistoryRow; head: ReleaseHeadRow | null },
  deps: ReleaseDeps,
): Promise<Outcome> {
  const gate = rollbackGate(input.row, input.head, false);
  if (!gate.ok) return { status: "blocked", reason: gate.reason };
  if (flight.busy) return { status: "busy" };

  flight.busy = true;
  try {
    const result = await deps.rollback(input.site, input.row.id);
    const releases = await deps.reload(input.site);
    return { status: "ok", result, releases };
  } catch (err) {
    return { status: "error", message: messageOf(err) };
  } finally {
    flight.busy = false;
  }
}

/**
 * Fold an outcome into the site's state.
 *
 * A failure keeps `head` and `history` untouched: the screen still shows what is really
 * live, with the error next to it. Replacing them with nothing on failure would tell the
 * operator the site had lost its release.
 *
 * `busy` returns the SAME object so a test can assert by reference that nothing moved.
 * Guides are not refetched — publishing does not change any guide row.
 */
export function applyOutcome(state: SiteReleaseState, outcome: Outcome): SiteReleaseState {
  switch (outcome.status) {
    case "busy":
      return state;
    case "blocked":
      return { ...state, error: outcome.reason };
    case "error":
      return { ...state, error: outcome.message };
    case "ok":
      return {
        ...state,
        head: outcome.releases.head ?? null,
        history: toHistoryRows(outcome.releases),
        error: null,
        lastResult: outcome.result,
      };
  }
}
