"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { DraftStep } from "@circa/guide-schema";

import {
  blankStep,
  buildValidationPayload,
  canPublish,
  groupIssues,
  insertStepAfter,
  isDirty,
  metadataOf,
  moveStep,
  newStepId,
  patchStep,
  removeStep,
  serializeSteps,
  validateForEditor,
  type GuideMetadata,
} from "../lib/guides/editor";
import {
  isConflictError,
  rpcDeleteGuide,
  rpcSaveGuideSteps,
  rpcSetGuideStatus,
  rpcUpsertGuide,
} from "../lib/guides/rpc";
import type { GuideDetailRow, GuideStatus, SiteOption } from "../lib/guides/types";
import { createClient } from "../lib/supabase/client";
import { StepEditor } from "./step-editor";

type Saving = "idle" | "saving" | "saved" | "conflict";

export function GuideEditor({
  guide,
  sites,
  publishError,
}: {
  guide: GuideDetailRow;
  sites: SiteOption[];
  publishError: string | null;
}) {
  const router = useRouter();

  const [meta, setMeta] = useState<GuideMetadata>(() => metadataOf(guide));
  const [steps, setSteps] = useState<DraftStep[]>(() => (guide.draft_steps as DraftStep[]) ?? []);
  const [status, setStatus] = useState<GuideStatus>(guide.status);
  /** The updated_at we loaded; the optimistic guard is checked against this. */
  const [baseUpdatedAt, setBaseUpdatedAt] = useState<string>(guide.updated_at);
  const [baseline, setBaseline] = useState(() => ({ meta: metadataOf(guide), steps: (guide.draft_steps as DraftStep[]) ?? [] }));

  const [saving, setSaving] = useState<Saving>("idle");
  const [error, setError] = useState<string | null>(null);

  const siteCodes = useMemo(() => sites.map((s) => s.code), [sites]);
  const validation = useMemo(() => validateForEditor(meta, steps, status, siteCodes), [meta, steps, status, siteCodes]);
  const grouped = useMemo(() => groupIssues(validation), [validation]);
  const dirty = isDirty({ meta, steps }, baseline);
  const busy = saving === "saving";

  function patchMeta(patch: Partial<GuideMetadata>) {
    setMeta((m) => ({ ...m, ...patch }));
    if (saving === "saved") setSaving("idle");
  }

  function updateSteps(next: DraftStep[]) {
    setSteps(next);
    if (saving === "saved") setSaving("idle");
  }

  async function save() {
    setSaving("saving");
    setError(null);
    try {
      const supabase = createClient();

      // Steps go first: this is the call that carries the optimistic guard. Saving the
      // metadata first would bump updated_at and make our own guard fail every time.
      const saved = await rpcSaveGuideSteps(
        supabase,
        guide.id,
        serializeSteps(steps),
        buildValidationPayload(validation, guide.validation),
        baseUpdatedAt,
      );

      let latest = saved.updatedAt;
      if (JSON.stringify(meta) !== JSON.stringify(baseline.meta)) {
        await rpcUpsertGuide(supabase, {
          guideId: guide.id,
          name: meta.name,
          site: meta.siteCode,
          groupName: meta.groupName,
          startUrl: meta.startUrl,
          sortOrder: meta.sortOrder,
          notes: meta.notes.trim() === "" ? null : meta.notes,
        });
        // upsert bumps updated_at again and does not return it, so the next guarded save
        // must use a value read back from the server.
        latest = "";
      }

      setBaseline({ meta, steps });
      setSaving("saved");
      if (latest) setBaseUpdatedAt(latest);
      // Re-read so baseUpdatedAt, publishError and the guide list are all truthful.
      router.refresh();
    } catch (err) {
      if (isConflictError(err)) {
        setSaving("conflict");
        return;
      }
      setSaving("idle");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function changeStatus(next: GuideStatus) {
    setSaving("saving");
    setError(null);
    try {
      await rpcSetGuideStatus(createClient(), guide.id, next);
      setStatus(next);
      setSaving("idle");
      router.refresh();
    } catch (err) {
      setSaving("idle");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove() {
    if (!confirm(`Xoá bộ "${guide.name}" và toàn bộ ${steps.length} bước? Không hoàn tác được.`)) return;
    setSaving("saving");
    setError(null);
    try {
      await rpcDeleteGuide(createClient(), guide.id);
      router.push("/guides");
    } catch (err) {
      setSaving("idle");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const publishable = canPublish(validation, meta.siteCode);

  return (
    <div className="stack">
      {saving === "conflict" ? (
        <div className="alert alert-danger" role="alert">
          <strong>Bộ này đã bị sửa ở nơi khác.</strong> Không ghi đè để tránh mất thay đổi của người kia.
          Hãy tải lại và làm lại chỉnh sửa của bạn.
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" type="button" onClick={() => router.refresh()}>Tải lại</button>
          </div>
        </div>
      ) : null}
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}

      {/* --------------------------------------------------------- metadata */}
      <div className="card stack">
        <strong>Thông tin bộ</strong>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 2, minWidth: 260 }}>
            <label className="label">Tên bộ</label>
            <input className="input" value={meta.name} disabled={busy} onChange={(e) => patchMeta({ name: e.target.value })} />
          </div>
          <div className="field" style={{ width: 160 }}>
            <label className="label">Site</label>
            <select className="select" value={meta.siteCode ?? ""} disabled={busy} onChange={(e) => patchMeta({ siteCode: e.target.value || null })}>
              <option value="">— chưa gán —</option>
              {sites.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
          </div>
          <div className="field" style={{ width: 180 }}>
            <label className="label">Nhóm</label>
            <input className="input" value={meta.groupName} disabled={busy} onChange={(e) => patchMeta({ groupName: e.target.value })} />
          </div>
          <div className="field" style={{ width: 110 }}>
            <label className="label">Thứ tự</label>
            <input className="input" type="number" value={meta.sortOrder} disabled={busy} onChange={(e) => patchMeta({ sortOrder: Number(e.target.value) || 0 })} />
          </div>
        </div>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <label className="label">URL bắt đầu</label>
            <input className="input mono" value={meta.startUrl} disabled={busy} onChange={(e) => patchMeta({ startUrl: e.target.value })} />
          </div>
          <div className="field" style={{ flex: 2, minWidth: 240 }}>
            <label className="label">Ghi chú</label>
            <input className="input" value={meta.notes} disabled={busy} onChange={(e) => patchMeta({ notes: e.target.value })} />
          </div>
        </div>
        {grouped.guide.errors.length ? (
          <div className="alert alert-danger"><ul style={{ margin: 0, paddingLeft: 18 }}>{grouped.guide.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
        ) : null}
        {grouped.guide.warnings.length ? (
          <div className="alert alert-warning"><ul style={{ margin: 0, paddingLeft: 18 }}>{grouped.guide.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>
        ) : null}
      </div>

      {/* ------------------------------------------------------------ steps */}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{steps.length} bước</strong>
        <button className="btn btn-sm" type="button" disabled={busy} onClick={() => updateSteps([...steps, blankStep(newStepId())])}>
          + Thêm bước cuối
        </button>
      </div>

      {steps.length === 0 ? (
        <div className="card muted">Bộ này chưa có bước nào. Thêm ít nhất một bước trước khi publish.</div>
      ) : (
        <div className="stack">
          {steps.map((s, i) => (
            <StepEditor
              key={s.id}
              step={s}
              index={i}
              total={steps.length}
              sites={sites}
              issues={grouped.byStep[i + 1]}
              disabled={busy}
              onPatch={(patch) => updateSteps(patchStep(steps, s.id, patch))}
              onMove={(delta) => updateSteps(moveStep(steps, i, delta))}
              onDuplicate={() => updateSteps(insertStepAfter(steps, i, { ...s, id: newStepId(), flags: undefined }))}
              onRemove={() => updateSteps(removeStep(steps, s.id))}
            />
          ))}
        </div>
      )}

      {/* ------------------------------------------------------- action bar */}
      <div className="card stack">
        <div className="row">
          <button className="btn btn-primary" type="button" disabled={busy || !dirty} onClick={save}>
            {busy ? "Đang lưu…" : dirty ? "Lưu thay đổi" : "Đã lưu"}
          </button>
          {saving === "saved" ? <span className="chip chip-success">Đã lưu</span> : null}
          {dirty ? <span className="chip chip-warning">Có thay đổi chưa lưu</span> : null}
          <span className="muted" style={{ marginLeft: "auto" }}>
            Trạng thái: <span className="chip">{status}</span>
          </span>
        </div>

        <div className="row">
          <button className="btn btn-sm" type="button" disabled={busy || status === "draft"} onClick={() => changeStatus("draft")}>Chuyển về draft</button>
          <button
            className="btn btn-sm"
            type="button"
            disabled={busy || dirty || !publishable || status === "published"}
            title={
              dirty ? "Lưu thay đổi trước" : !publishable ? "Còn lỗi validate hoặc chưa gán site" : undefined
            }
            onClick={() => changeStatus("published")}
          >
            Đánh dấu published
          </button>
          <button className="btn btn-sm" type="button" disabled={busy || status === "archived"} onClick={() => changeStatus("archived")}>Archive</button>
          <button className="btn btn-sm" type="button" disabled={busy || status === "published"} onClick={remove} style={{ marginLeft: "auto", color: "var(--danger)" }}>
            Xoá bộ
          </button>
        </div>

        {!publishable ? (
          <div className="muted">
            Chưa publish được: {validation.errors.length ? `${validation.errors.length} lỗi validate` : "chưa gán site"}.
            Cảnh báo thì vẫn lưu và publish được.
          </div>
        ) : null}
        {publishError ? <div className="alert alert-warning">Server báo: {publishError}</div> : null}
      </div>
    </div>
  );
}
