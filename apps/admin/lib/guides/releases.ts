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
  /** Raw message from a write the database REFUSED, or null. */
  error: string | null;
  /** The last publish/rollback the database accepted. */
  lastResult: PublishResult | RollbackResult | null;
  /**
   * Set when a write ended somewhere the screen cannot reason about on its own: either
   * the database committed but the refresh failed, or we never heard back at all. While
   * this is set, further writes are refused — see the gates.
   */
  needsReload: NeedsReload | null;
}

export interface NeedsReload {
  /** committed: the release EXISTS. unknown: it may or may not. */
  kind: "committed-refresh-failed" | "unknown";
  message: string;
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
    needsReload: null,
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

export function publishGate(input: {
  approvedCount: number;
  note: string;
  busy: boolean;
  needsReload?: boolean;
}): Gate {
  if (input.busy) return { ok: false, reason: "Đang phát hành…" };
  // A second publish on top of an unresolved one is how a site ends up with two releases
  // for one intention. Make the operator look at the real state first.
  if (input.needsReload) {
    return { ok: false, reason: "Chưa rõ trạng thái lần trước — tải lại trạng thái đã." };
  }
  if (input.approvedCount <= 0) {
    return { ok: false, reason: "Chưa có bộ nào được duyệt cho lần phát hành tiếp theo." };
  }
  // A release nobody can explain later is a release nobody can decide to roll back to.
  if (!input.note.trim()) return { ok: false, reason: "Nhập ghi chú phát hành trước đã." };
  return { ok: true, reason: "" };
}

export function rollbackGate(
  row: HistoryRow,
  head: ReleaseHeadRow | null,
  busy: boolean,
  needsReload = false,
): Gate {
  if (busy) return { ok: false, reason: "Đang xử lý…" };
  if (needsReload) return { ok: false, reason: "Chưa rõ trạng thái lần trước — tải lại trạng thái đã." };
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
 * Scope: one operator double-clicking inside ONE panel. Two browser tabs still send two
 * requests, and they do NOT collide — `pg_advisory_xact_lock` is transaction-scoped, so
 * the second waits for the first to commit, then reads the new `max(revision)` and mints
 * the one after it. The result is two consecutive releases, no error. That is the
 * database working as designed; deciding whether it is what the operator meant is a
 * human question, not one to "fix" here with a lock table.
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

/**
 * What happened to a write, told precisely enough to act on.
 *
 * The distinction that matters — and that a single try/catch destroyed — is between "the
 * database refused" and "the database committed but the screen could not refresh". Both
 * used to surface as an error, so the operator was told the publish failed while a
 * release existed, pressed the button again, and got a second revision for one intention.
 */
export type Outcome =
  | { status: "blocked"; reason: string }
  | { status: "busy" }
  /** The database answered, and the answer was no. Nothing was written; retrying is safe. */
  | { status: "rejected"; message: string }
  /** Written AND the screen is up to date. */
  | { status: "committed"; result: PublishResult | RollbackResult; releases: ListReleasesResult }
  /** Written — the release EXISTS — but reloading the screen failed. Never an error. */
  | { status: "committed-refresh-failed"; result: PublishResult | RollbackResult; message: string }
  /** We never heard back. The write may or may not have landed. */
  | { status: "unknown"; message: string }
  | { status: "refreshed"; releases: ListReleasesResult }
  | { status: "refresh-failed"; message: string };

function messageOf(err: unknown): string {
  // Verbatim. The Postgres text is the only thing that says WHICH guide blocked a publish.
  return err instanceof Error ? err.message : String(err);
}

/**
 * Did the database actually answer?
 *
 * A SQLSTATE (22023, 42501, P0002, 40001 …) means Postgres evaluated the call and
 * refused it, so nothing was written. No code means the failure happened somewhere in
 * the transport, and from here it is genuinely unknowable whether the transaction
 * committed. Guessing "it failed" is the guess that creates duplicate releases.
 *
 * Duck-typed on `.code` rather than on `instanceof RpcError`, so this module stays free
 * of the Supabase layer and a test can construct either case with a plain object.
 */
export function isDatabaseVerdict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.trim() !== "";
}

async function runWrite(
  flight: Flight,
  gate: Gate,
  site: string,
  call: () => Promise<PublishResult | RollbackResult>,
  deps: ReleaseDeps,
): Promise<Outcome> {
  if (!gate.ok) return { status: "blocked", reason: gate.reason };
  if (flight.busy) return { status: "busy" };

  flight.busy = true;
  try {
    let result: PublishResult | RollbackResult;
    try {
      result = await call();
    } catch (err) {
      return isDatabaseVerdict(err)
        ? { status: "rejected", message: messageOf(err) }
        : { status: "unknown", message: messageOf(err) };
    }

    // From here on the write HAS committed. A failure below is a display problem, and
    // reporting it as a failed publish is what makes the operator publish twice.
    try {
      return { status: "committed", result, releases: await deps.reload(site) };
    } catch (err) {
      return { status: "committed-refresh-failed", result, message: messageOf(err) };
    }
  } finally {
    flight.busy = false;
  }
}

export async function runPublish(
  flight: Flight,
  input: { site: string; note: string; approvedCount: number; needsReload?: boolean },
  deps: ReleaseDeps,
): Promise<Outcome> {
  const gate = publishGate({
    approvedCount: input.approvedCount,
    note: input.note,
    busy: false,
    needsReload: input.needsReload,
  });
  return runWrite(flight, gate, input.site, () => deps.publish(input.site, input.note), deps);
}

export async function runRollback(
  flight: Flight,
  input: { site: string; row: HistoryRow; head: ReleaseHeadRow | null; needsReload?: boolean },
  deps: ReleaseDeps,
): Promise<Outcome> {
  const gate = rollbackGate(input.row, input.head, false, input.needsReload);
  return runWrite(flight, gate, input.site, () => deps.rollback(input.site, input.row.id), deps);
}

/** Re-read head and history. The way out of both unresolved states. */
export async function runReload(flight: Flight, site: string, deps: ReleaseDeps): Promise<Outcome> {
  if (flight.busy) return { status: "busy" };
  flight.busy = true;
  try {
    return { status: "refreshed", releases: await deps.reload(site) };
  } catch (err) {
    return { status: "refresh-failed", message: messageOf(err) };
  } finally {
    flight.busy = false;
  }
}

/**
 * Fold an outcome into the site's state.
 *
 * A refused write keeps `head` and `history` untouched: the screen still shows what is
 * really live, with the error next to it. Replacing them with nothing would tell the
 * operator the site had lost its release.
 *
 * A committed-but-unrefreshed write is NOT an error. The release exists; only the screen
 * is stale. It records the server's own result so the operator can see the revision that
 * was created, and sets `needsReload` so no second write can be started on top of it.
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
    case "rejected":
      // The database refused; nothing was written, so the operator may safely try again.
      return { ...state, error: outcome.message, needsReload: null };
    case "unknown":
      return {
        ...state,
        error: null,
        needsReload: { kind: "unknown", message: outcome.message },
      };
    case "committed-refresh-failed":
      return {
        ...state,
        error: null,
        lastResult: outcome.result,
        needsReload: { kind: "committed-refresh-failed", message: outcome.message },
      };
    case "committed":
      return {
        ...state,
        head: outcome.releases.head ?? null,
        history: toHistoryRows(outcome.releases),
        error: null,
        lastResult: outcome.result,
        needsReload: null,
      };
    case "refreshed":
      return {
        ...state,
        head: outcome.releases.head ?? null,
        history: toHistoryRows(outcome.releases),
        error: null,
        needsReload: null,
      };
    case "refresh-failed":
      // Still stuck, and still not an error about the write itself.
      return {
        ...state,
        needsReload: { kind: state.needsReload?.kind ?? "unknown", message: outcome.message },
      };
  }
}
