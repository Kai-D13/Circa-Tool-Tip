"use client";

import { useState } from "react";

import { confidenceOf, hasWarnings } from "../lib/guides/triage";
import type { GuideRow } from "../lib/guides/types";

const CONF_LABEL: Record<string, string> = { high: "cao", medium: "vừa", low: "thấp", none: "không rõ" };

export function TriageCard({
  guide,
  busy,
  onAssign,
}: {
  guide: GuideRow;
  busy: boolean;
  onAssign: (guideId: string, site: "pos" | "admin", groupName: string) => Promise<void>;
}) {
  const guess = guide.site_guess === "pos" || guide.site_guess === "admin" ? guide.site_guess : null;
  const [site, setSite] = useState<"pos" | "admin" | "">(guess ?? "");
  const [group, setGroup] = useState(guide.group_name || "");
  const conf = confidenceOf(guide);
  const ev = guide.site_evidence || {};
  const v = guide.validation || {};
  const flags = v.flags ?? [];
  const done = guide.status !== "unassigned";

  return (
    <div className="card triage-card">
      <div>
        <h3 className="triage-name">{guide.name}</h3>
        <div className="triage-meta">
          <span className="chip">{guide.step_count} bước</span>
          <span className="chip mono">{guide.start_url}</span>
          {guess ? (
            <span className={`chip ${guess === "pos" ? "chip-pos" : "chip-admin"}`}>gợi ý: {guess === "pos" ? "POS" : "Admin"}</span>
          ) : (
            <span className="chip chip-none">không gợi ý được</span>
          )}
          <span className={`chip ${conf === "none" ? "chip-danger" : conf === "high" ? "chip-success" : "chip-warning"}`}>
            độ tin: {CONF_LABEL[conf]}
          </span>
          {done ? <span className={`chip ${guide.site_code === "pos" ? "chip-pos" : "chip-admin"}`}>đã gán {guide.site_code === "pos" ? "POS" : "Admin"}</span> : null}
        </div>
        {ev.reason ? <p className="triage-reason">{ev.reason}</p> : null}
        {ev.prefixes ? (
          <p className="triage-reason mono">
            POS {ev.posScore ?? 0} · Admin {ev.adminScore ?? 0} · trung tính {ev.neutralScore ?? 0} —{" "}
            {Object.entries(ev.prefixes).slice(0, 6).map(([k, n]) => `/${k}×${n}`).join("  ")}
          </p>
        ) : null}
        {hasWarnings(guide) ? (
          <div className="triage-meta">
            {flags.map((f) => <span key={f} className="chip chip-warning">{f}</span>)}
            {(v.warnings ?? []).length ? <span className="chip chip-warning">{v.warnings!.length} cảnh báo bước</span> : null}
            {(v.errors ?? []).length ? <span className="chip chip-danger">{v.errors!.length} lỗi</span> : null}
          </div>
        ) : null}
      </div>

      <div className="triage-form">
        <div className="radio-row" role="radiogroup" aria-label="Site">
          <label><input type="radio" name={`site-${guide.id}`} checked={site === "pos"} onChange={() => setSite("pos")} disabled={done || busy} /> POS</label>
          <label><input type="radio" name={`site-${guide.id}`} checked={site === "admin"} onChange={() => setSite("admin")} disabled={done || busy} /> Admin</label>
        </div>
        <input className="input" placeholder="Nhóm (tuỳ chọn), vd: Bán hàng" value={group} onChange={(e) => setGroup(e.target.value)} disabled={done || busy} />
        <button
          className="btn btn-primary"
          type="button"
          disabled={done || busy || site === ""}
          onClick={() => site !== "" && onAssign(guide.id, site, group)}
        >
          {done ? "Đã phân loại" : busy ? "Đang lưu…" : "Xác nhận phân loại"}
        </button>
      </div>
    </div>
  );
}
