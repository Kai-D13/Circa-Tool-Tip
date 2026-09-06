"use client";

import { useMemo, useState } from "react";

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

export function TriageBoard({ initialGuides }: { initialGuides: GuideRow[] }) {
  const [guides, setGuides] = useState<GuideRow[]>(initialGuides);
  const [filter, setFilter] = useState<TriageFilter>(DEFAULT_FILTER);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkPreview, setBulkPreview] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

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

  async function applyBulk() {
    setBulkBusy(true);
    setError(null);
    const supabase = createClient();
    for (const g of suggestions) {
      const site = g.site_guess as "pos" | "admin";
      try {
        await rpcAssignSite(supabase, g.id, site, g.group_name || "");
        setGuides((prev) => applyAssignment(prev, g.id, site, g.group_name || ""));
      } catch (err) {
        setError(`${g.name}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
    setBulkBusy(false);
    setBulkPreview(false);
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
        <button className="btn" type="button" disabled={!suggestions.length || bulkBusy} onClick={() => setBulkPreview(true)}>
          Áp dụng gợi ý độ tin cao ({suggestions.length})
        </button>
      </div>

      {bulkPreview ? (
        <div className="card stack" role="dialog" aria-labelledby="bulk-title">
          <strong id="bulk-title">Sẽ gán {suggestions.length} bộ theo gợi ý độ tin cao</strong>
          <p className="muted" style={{ margin: 0 }}>Chỉ gợi ý độ tin cao được áp dụng hàng loạt. Bộ độ tin vừa/thấp/không rõ vẫn phải phân loại tay.</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Tên bộ</th><th>Sẽ gán</th><th>Bước</th></tr></thead>
              <tbody>
                {suggestions.map((g) => (
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
            <button className="btn btn-primary" type="button" onClick={applyBulk} disabled={bulkBusy}>{bulkBusy ? "Đang gán…" : "Xác nhận gán hàng loạt"}</button>
            <button className="btn" type="button" onClick={() => setBulkPreview(false)} disabled={bulkBusy}>Huỷ</button>
          </div>
        </div>
      ) : null}

      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}

      {visible.length === 0 ? (
        <div className="card muted">Không có bộ nào khớp bộ lọc.</div>
      ) : (
        <div className="triage-list">
          {visible.map((g) => (
            <TriageCard key={g.id} guide={g} busy={busyId === g.id || bulkBusy} onAssign={assign} />
          ))}
        </div>
      )}
    </div>
  );
}
