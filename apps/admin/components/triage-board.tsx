"use client";

import { useMemo, useState } from "react";

import { retryTargets, runBulkAssign, type BulkResult } from "../lib/guides/bulk-assign";
import { rpcAssignSite } from "../lib/guides/rpc";
import {
  DEFAULT_FILTER,
  applyAssignment,
  filterGuides,
  highConfidenceSuggestions,
  progressOf,
  unknownFirst,
  type TriageFilter,
} from "../lib/guides/triage";
import type { GuideRow } from "../lib/guides/types";
import { createClient } from "../lib/supabase/client";
import { TriageCard } from "./triage-card";

/**
 * Bulk apply is N sequential RPCs, so a failure at item N leaves 1..N-1 committed.
 * The panel therefore never closes on failure: it shows what succeeded, what failed and
 * what is still pending, and "retry" only targets guides still unassigned.
 */
interface BulkState {
  phase: "preview" | "running" | "result";
  /** Frozen at the moment the operator confirmed. Retry derives from this. */
  snapshot: GuideRow[];
  /** What the current run is processing (snapshot, or the retry subset). */
  targets: GuideRow[];
  done: number;
  result: BulkResult | null;
  /** Ids assigned across ALL runs of this panel, for the final summary. */
  succeededTotal: string[];
}

export function TriageBoard({ initialGuides }: { initialGuides: GuideRow[] }) {
  const [guides, setGuides] = useState<GuideRow[]>(initialGuides);
  const [filter, setFilter] = useState<TriageFilter>(DEFAULT_FILTER);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulk, setBulk] = useState<BulkState | null>(null);

  const progress = progressOf(guides);
  const visible = useMemo(() => unknownFirst(filterGuides(guides, filter)), [guides, filter]);
  const suggestions = useMemo(() => highConfidenceSuggestions(guides), [guides]);

  async function assign(guideId: string, site: "pos" | "admin", groupName: string) {
    setBusyId(guideId);
    setError(null);
    try {
      const supabase = createClient();
      await rpcAssignSite(supabase, guideId, site, groupName);
      setGuides((prev) => applyAssignment(prev, guideId, site, groupName));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  function openBulk() {
    setBulk({ phase: "preview", snapshot: suggestions, targets: suggestions, done: 0, result: null, succeededTotal: [] });
  }

  async function runBulk(targets: GuideRow[], previous: BulkState) {
    setBulk({ ...previous, phase: "running", targets, done: 0, result: null });
    const supabase = createClient();
    // Local state is updated per success so a mid-run failure leaves the list truthful.
    let latest = guides;
    const result = await runBulkAssign(
      targets,
      async (g, site) => {
        await rpcAssignSite(supabase, g.id, site, g.group_name || "");
        latest = applyAssignment(latest, g.id, site, g.group_name || "");
        setGuides(latest);
      },
      (done) => setBulk((b) => (b ? { ...b, done } : b)),
    );
    setBulk((b) =>
      b
        ? { ...b, phase: "result", result, succeededTotal: [...b.succeededTotal, ...result.succeeded] }
        : b,
    );
  }

  function retryBulk(current: BulkState) {
    const again = retryTargets(current.snapshot, guides);
    void runBulk(again, current);
  }

  const pct = progress.total ? Math.round((progress.assigned / progress.total) * 100) : 0;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>Đã phân loại {progress.assigned}/{progress.total}</strong>
          <span className="muted">còn {progress.unassigned} chưa phân loại</span>
        </div>
        <div className="progress-bar" aria-hidden="true"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
      </div>

      <div className="card filters">
        <div className="field">
          <label className="label" htmlFor="f-scope">Hiển thị</label>
          <select id="f-scope" className="select" value={filter.scope} onChange={(e) => setFilter({ ...filter, scope: e.target.value as TriageFilter["scope"] })}>
            <option value="unassigned">Chưa phân loại</option>
            <option value="pos">POS</option>
            <option value="admin">Admin</option>
            <option value="all">Tất cả</option>
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="f-conf">Độ tin gợi ý</label>
          <select id="f-conf" className="select" value={filter.confidence} onChange={(e) => setFilter({ ...filter, confidence: e.target.value as TriageFilter["confidence"] })}>
            <option value="any">Bất kỳ</option>
            <option value="high">Cao</option>
            <option value="medium">Vừa</option>
            <option value="low">Thấp</option>
            <option value="none">Không rõ</option>
          </select>
        </div>
        <label className="row" style={{ gap: 6, paddingBottom: 8 }}>
          <input type="checkbox" checked={filter.onlyWarnings} onChange={(e) => setFilter({ ...filter, onlyWarnings: e.target.checked })} /> Chỉ bộ có cảnh báo
        </label>
        <div className="field" style={{ flex: 1, minWidth: 200 }}>
          <label className="label" htmlFor="f-q">Tìm theo tên</label>
          <input id="f-q" className="input" placeholder="vd: voucher" value={filter.query} onChange={(e) => setFilter({ ...filter, query: e.target.value })} />
        </div>
        <button className="btn" type="button" disabled={!suggestions.length || bulk !== null} onClick={openBulk}>
          Áp dụng gợi ý độ tin cao ({suggestions.length})
        </button>
      </div>

      {bulk?.phase === "preview" ? (
        <div className="card stack" role="dialog" aria-labelledby="bulk-title">
          <strong id="bulk-title">Sẽ gán {bulk.snapshot.length} bộ theo gợi ý độ tin cao</strong>
          <p className="muted" style={{ margin: 0 }}>
            Chỉ gợi ý độ tin cao được áp dụng hàng loạt; bộ độ tin vừa/thấp/không rõ vẫn phân loại tay.
            Các bộ được gán lần lượt — nếu một bộ lỗi, những bộ trước đó đã được ghi và bạn sẽ thấy rõ còn bao nhiêu.
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Tên bộ</th><th>Sẽ gán</th><th>Bước</th></tr></thead>
              <tbody>
                {bulk.snapshot.map((g) => (
                  <tr key={g.id}>
                    <td>{g.name}</td>
                    <td><span className={`chip ${g.site_guess === "pos" ? "chip-pos" : "chip-admin"}`}>{g.site_guess === "pos" ? "POS" : "Admin"}</span></td>
                    <td>{g.step_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <button className="btn btn-primary" type="button" onClick={() => void runBulk(bulk.snapshot, bulk)}>Xác nhận gán hàng loạt</button>
            <button className="btn" type="button" onClick={() => setBulk(null)}>Huỷ</button>
          </div>
        </div>
      ) : null}

      {bulk?.phase === "running" ? (
        <div className="card stack" role="status" aria-live="polite">
          <strong>Đang gán hàng loạt…</strong>
          <div>Đã xử lý <strong>{bulk.done}/{bulk.targets.length}</strong></div>
          <div className="progress-bar" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${bulk.targets.length ? Math.round((bulk.done / bulk.targets.length) * 100) : 0}%` }} />
          </div>
        </div>
      ) : null}

      {bulk?.phase === "result" && bulk.result ? (
        <div className="card stack" role="dialog" aria-labelledby="bulk-result-title">
          {bulk.result.failed ? (
            <>
              <strong id="bulk-result-title" style={{ color: "var(--danger)" }}>Gán hàng loạt dừng lại vì một bộ lỗi</strong>
              <div className="alert alert-danger">
                <div><strong>{bulk.result.failed.name}</strong></div>
                <div className="mono">{bulk.result.failed.message}</div>
              </div>
              <table className="table">
                <tbody>
                  <tr><th>Đã gán thành công (lần này)</th><td>{bulk.result.succeeded.length}</td></tr>
                  <tr><th>Đã gán thành công (tất cả các lần)</th><td>{bulk.succeededTotal.length}/{bulk.snapshot.length}</td></tr>
                  <tr><th>Còn chưa phân loại trong nhóm này</th><td><strong>{retryTargets(bulk.snapshot, guides).length}</strong></td></tr>
                </tbody>
              </table>
              <div className="row">
                <button className="btn btn-primary" type="button" onClick={() => retryBulk(bulk)} disabled={retryTargets(bulk.snapshot, guides).length === 0}>
                  Thử lại {retryTargets(bulk.snapshot, guides).length} bộ còn lại
                </button>
                <button className="btn" type="button" onClick={() => setBulk(null)}>Đóng</button>
              </div>
            </>
          ) : (
            <>
              <strong id="bulk-result-title" style={{ color: "var(--success)" }}>Gán hàng loạt hoàn tất</strong>
              <div className="alert alert-success">
                Đã gán <strong>{bulk.succeededTotal.length}/{bulk.snapshot.length}</strong> bộ theo gợi ý. Còn {progressOf(guides).unassigned} bộ cần phân loại tay.
              </div>
              <div className="row">
                <button className="btn" type="button" onClick={() => setBulk(null)}>Đóng</button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}

      {visible.length === 0 ? (
        <div className="card muted">Không có bộ nào khớp bộ lọc.</div>
      ) : (
        <div className="triage-list">
          {visible.map((g) => (
            <TriageCard key={g.id} guide={g} busy={busyId === g.id || bulk?.phase === "running"} onAssign={assign} />
          ))}
        </div>
      )}
    </div>
  );
}
