"use client";

import { ACTION_TYPES, URL_MATCH_MODES, inferUrlMatchMode, type DraftStep } from "@circa/guide-schema";

import { formatSelectors, parseSelectors, type StepIssues } from "../lib/guides/editor";
import { summarizeProbe, type ProbeResult } from "../lib/guides/preview";
import type { SiteOption } from "../lib/guides/types";

const ACTION_LABEL: Record<string, string> = {
  highlight: "highlight — chỉ tô sáng",
  click_next: "click_next — người dùng bấm rồi qua bước",
  click_wait_url: "click_wait_url — người dùng bấm, chờ đổi URL",
  auto_click_next: "auto_click_next — TỰ bấm rồi qua bước",
  auto_click_wait_url: "auto_click_wait_url — TỰ bấm, chờ đổi URL",
  wait_element: "wait_element — chờ phần tử xuất hiện",
  manual: "manual — người dùng tự làm, không cần phần tử",
};

const WAIT_URL = ["click_wait_url", "auto_click_wait_url"];

export function StepEditor({
  step,
  index,
  total,
  sites,
  issues,
  disabled,
  onPatch,
  onMove,
  onDuplicate,
  onRemove,
  probe,
  probeBusy,
  onProbe,
}: {
  step: DraftStep;
  index: number;
  total: number;
  sites: SiteOption[];
  issues: StepIssues | undefined;
  disabled: boolean;
  onPatch: (patch: Partial<DraftStep>) => void;
  onMove: (delta: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  /** Last answer from the page for THIS step, or null if it has not been checked. */
  probe: ProbeResult | null;
  probeBusy: boolean;
  /** Disabled with a reason when the step cannot be checked at all. */
  onProbe: { ok: boolean; reason: string; run: () => void };
}) {
  const inferred = inferUrlMatchMode(step.urlPattern, undefined);
  const isWaitUrl = WAIT_URL.includes(step.action.type);
  const errs = issues?.errors ?? [];
  const warns = issues?.warnings ?? [];
  const flags = step.flags ?? [];

  const patchAction = (patch: Partial<DraftStep["action"]>) => onPatch({ action: { ...step.action, ...patch } });
  const verdict = summarizeProbe(probe);
  const VERDICT_CLASS: Record<string, string> = { ok: "chip chip-success", warn: "chip chip-warning", bad: "chip chip-danger", idle: "chip" };

  return (
    <details className="card stack" open={errs.length > 0}>
      <summary className="row" style={{ cursor: "pointer", justifyContent: "space-between" }}>
        <span>
          <strong>Bước {index + 1}</strong>{" "}
          <span className="muted">{step.title || <em>chưa có tiêu đề</em>}</span>{" "}
          <span className="chip">{step.action.type}</span>
          {errs.length ? <span className="chip chip-danger">{errs.length} lỗi</span> : null}
          {warns.length ? <span className="chip chip-warning">{warns.length} cảnh báo</span> : null}
          {flags.length ? <span className="chip chip-warning">{flags.length} flag</span> : null}
          {verdict.tone !== "idle" ? <span className={VERDICT_CLASS[verdict.tone]}>{verdict.label}</span> : null}
        </span>
      </summary>

      {errs.length ? (
        <div className="alert alert-danger">
          <ul style={{ margin: 0, paddingLeft: 18 }}>{errs.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      ) : null}
      {warns.length ? (
        <div className="alert alert-warning">
          <ul style={{ margin: 0, paddingLeft: 18 }}>{warns.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      ) : null}
      {flags.length ? (
        <div className="row">{flags.map((f) => <span key={f} className="chip chip-warning">{f}</span>)}</div>
      ) : null}

      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label className="label">Tiêu đề</label>
          <input className="input" value={step.title} disabled={disabled} onChange={(e) => onPatch({ title: e.target.value })} />
        </div>
        <div className="field" style={{ flex: 2, minWidth: 260 }}>
          <label className="label">Nội dung</label>
          <input className="input" value={step.content} disabled={disabled} onChange={(e) => onPatch({ content: e.target.value })} />
        </div>
      </div>

      <div className="field">
        <label className="label">Selector (mỗi dòng một candidate, thứ tự là thứ tự thử)</label>
        <textarea
          className="input"
          rows={Math.min(5, Math.max(2, step.selectors.length + 1))}
          value={formatSelectors(step.selectors)}
          disabled={disabled}
          onChange={(e) => onPatch({ selectors: parseSelectors(e.target.value) })}
        />
      </div>

      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="field" style={{ flex: 2, minWidth: 220 }}>
          <label className="label">matchText</label>
          <input className="input" value={step.matchText} disabled={disabled} onChange={(e) => onPatch({ matchText: e.target.value })} />
        </div>
        <div className="field" style={{ width: 110 }}>
          <label className="label">tag</label>
          <input className="input" value={step.tag} disabled={disabled} onChange={(e) => onPatch({ tag: e.target.value })} />
        </div>
        <div className="field" style={{ width: 150 }}>
          <label className="label">intent</label>
          <select
            className="select"
            value={step.intent ?? "exact"}
            disabled={disabled}
            onChange={(e) => onPatch({ intent: e.target.value === "first_item" ? "first_item" : undefined })}
          >
            <option value="exact">exact</option>
            <option value="first_item">first_item</option>
          </select>
        </div>
        <div className="field" style={{ width: 130 }}>
          <label className="label">position</label>
          <select
            className="select"
            value={step.position ?? "auto"}
            disabled={disabled}
            onChange={(e) => onPatch({ position: e.target.value === "auto" ? undefined : (e.target.value as DraftStep["position"]) })}
          >
            {["auto", "top", "bottom", "left", "right"].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>

      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="field" style={{ flex: 1, minWidth: 240 }}>
          <label className="label">urlPattern (dùng để khớp trang)</label>
          <input className="input mono" value={step.urlPattern} disabled={disabled} onChange={(e) => onPatch({ urlPattern: e.target.value })} />
        </div>
        <div className="field" style={{ width: 190 }}>
          <label className="label">urlMatchMode</label>
          <select
            className="select"
            value={step.urlMatchMode ?? ""}
            disabled={disabled}
            onChange={(e) => onPatch({ urlMatchMode: e.target.value === "" ? undefined : (e.target.value as DraftStep["urlMatchMode"]) })}
          >
            <option value="">tự suy ra ({inferred || "—"})</option>
            {URL_MATCH_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>

      <div className="field">
        <label className="label">navigationUrl (URL đầy đủ để tự điều hướng; để trống nếu chỉ tới được bằng cách bấm qua bước trước)</label>
        <input className="input mono" value={step.navigationUrl} disabled={disabled} onChange={(e) => onPatch({ navigationUrl: e.target.value })} />
      </div>

      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="field" style={{ flex: 1, minWidth: 280 }}>
          <label className="label">action</label>
          <select className="select" value={step.action.type} disabled={disabled} onChange={(e) => patchAction({ type: e.target.value as DraftStep["action"]["type"] })}>
            {ACTION_TYPES.map((t) => <option key={t} value={t}>{ACTION_LABEL[t] ?? t}</option>)}
          </select>
        </div>
        <div className="field" style={{ width: 120 }}>
          <label className="label">timeoutMs</label>
          <input
            className="input"
            type="number"
            min={0}
            value={step.action.timeoutMs}
            disabled={disabled}
            onChange={(e) => patchAction({ timeoutMs: Number(e.target.value) || 0 })}
          />
        </div>
        <div className="field" style={{ width: 170 }}>
          <label className="label">siteOverride</label>
          <select
            className="select"
            value={step.siteOverride ?? ""}
            disabled={disabled}
            onChange={(e) => onPatch({ siteOverride: e.target.value === "" ? undefined : e.target.value })}
          >
            <option value="">kế thừa từ bộ</option>
            {sites.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
        </div>
      </div>

      {isWaitUrl ? (
        <div className="field">
          <label className="label">expectedUrl (URL đích sau khi bấm; để trống thì lấy urlPattern của bước sau)</label>
          <input className="input mono" value={step.action.expectedUrl} disabled={disabled} onChange={(e) => patchAction({ expectedUrl: e.target.value })} />
        </div>
      ) : null}

      {/* Kiểm tra selector chạy trên trang thật và KHÔNG ghi gì: nó chỉ đọc DOM rồi
          báo về. Bước chưa lưu vẫn kiểm tra được, vì bước đi kèm trong message. */}
      <div className="row" style={{ alignItems: "center" }}>
        <button
          className="btn btn-sm"
          type="button"
          disabled={disabled || probeBusy || !onProbe.ok}
          title={onProbe.reason}
          onClick={onProbe.run}
        >
          {probeBusy ? "Đang kiểm tra…" : "Kiểm tra selector trên trang"}
        </button>
        {probe ? (
          <>
            <span className={VERDICT_CLASS[verdict.tone]}>{verdict.label}</span>
            <span className="muted">{verdict.detail}</span>
          </>
        ) : (
          <span className="muted">{onProbe.ok ? "Mở trang của bước và đếm element khớp." : onProbe.reason}</span>
        )}
      </div>

      {probe ? (
        <ul className="mono" style={{ margin: 0, paddingLeft: 18 }}>
          {probe.candidates.map((c, i) => (
            <li key={c.selector + i}>
              {c.invalid ? "sai cú pháp" : `${c.count} element`}
              {c.textMatches ? ` · ${c.textMatches} khớp text` : ""} · {c.selector}
              {probe.resolved?.selectorIndex === i ? <strong> ← đang dùng</strong> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="row">
        <button className="btn btn-sm" type="button" disabled={disabled || index === 0} onClick={() => onMove(-1)}>↑ Lên</button>
        <button className="btn btn-sm" type="button" disabled={disabled || index === total - 1} onClick={() => onMove(1)}>↓ Xuống</button>
        <button className="btn btn-sm" type="button" disabled={disabled} onClick={onDuplicate}>Nhân bản</button>
        <button className="btn btn-sm" type="button" disabled={disabled} onClick={onRemove} style={{ marginLeft: "auto", color: "var(--danger)" }}>Xoá bước</button>
      </div>
    </details>
  );
}
