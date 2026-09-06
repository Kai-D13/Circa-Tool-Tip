import type { GuideRow } from "./types";

/**
 * Bulk "apply high-confidence suggestions", done as N sequential RPC calls with NO
 * server-side transaction on purpose (Plan v1.1: keep it simple). The price of that
 * choice is that a failure at item N leaves items 1..N-1 committed, so this module makes
 * partial completion explicit instead of silent:
 *
 *   - it stops at the first failure and reports exactly which guide failed,
 *   - it returns what succeeded and what is still pending,
 *   - retry re-runs ONLY guides that are still unassigned.
 *
 * Pure apart from the injected `assign` function, so it is unit-tested with node --test.
 */

export type BulkSite = "pos" | "admin";

export interface BulkFailure {
  id: string;
  name: string;
  message: string;
}

export interface BulkResult {
  /** Ids assigned during THIS run, in order. */
  succeeded: string[];
  failed: BulkFailure | null;
  /** Targets not processed in this run, starting with the failed one. */
  remaining: GuideRow[];
}

export type AssignFn = (guide: GuideRow, site: BulkSite) => Promise<void>;

export function suggestedSite(guide: GuideRow): BulkSite | null {
  return guide.site_guess === "pos" || guide.site_guess === "admin" ? guide.site_guess : null;
}

export async function runBulkAssign(
  targets: GuideRow[],
  assign: AssignFn,
  onProgress?: (done: number, total: number) => void,
): Promise<BulkResult> {
  const succeeded: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const guide = targets[i];
    const site = suggestedSite(guide);
    if (!site) {
      return {
        succeeded,
        failed: { id: guide.id, name: guide.name, message: "Bộ này không có gợi ý site để áp dụng." },
        remaining: targets.slice(i),
      };
    }
    try {
      await assign(guide, site);
    } catch (err) {
      return {
        succeeded,
        failed: { id: guide.id, name: guide.name, message: err instanceof Error ? err.message : String(err) },
        remaining: targets.slice(i),
      };
    }
    succeeded.push(guide.id);
    onProgress?.(succeeded.length, targets.length);
  }

  return { succeeded, failed: null, remaining: [] };
}

/**
 * What a retry should process: the original snapshot minus anything that is no longer
 * unassigned in the current state. Guides that succeeded earlier are therefore never
 * sent to the RPC twice.
 */
export function retryTargets(snapshot: GuideRow[], current: GuideRow[]): GuideRow[] {
  const stillUnassigned = new Set(current.filter((g) => g.status === "unassigned").map((g) => g.id));
  return snapshot.filter((g) => stillUnassigned.has(g.id));
}
