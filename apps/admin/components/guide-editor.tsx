"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DraftStep } from "@circa/guide-schema";

import {
  blankStep,
  buildValidationPayload,
  canChangeStatus,
  canClearSite,
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
  newToolSessionId,
  originsOf,
  previewReadiness,
  previewRequest,
  probeReadiness,
  probeRequest,
  stepPageUrl,
  type ProbeResult,
} from "../lib/guides/preview";
import { isConflictError, rpcDeleteGuide, rpcSaveGuide, rpcSetGuideStatus } from "../lib/guides/rpc";
import type { GuideDetailRow, GuideStatus, SiteOption } from "../lib/guides/types";
import { createClient } from "../lib/supabase/client";
import { PreviewPanel } from "./preview-panel";
import { RecorderPanel } from "./recorder-panel";
import { StepEditor } from "./step-editor";
import { useExtension, type ExtensionReply } from "./use-extension";

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

  /* ------------------------------------------------- công cụ chạy trên trang thật */

  /**
   * Probe and preview share one port. Both are read-only against the page and write
   * nothing anywhere: a probe counts elements, a preview carries the draft in its own
   * message. Neither touches Supabase, and neither can change a release.
   */
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [probing, setProbing] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ running: boolean; index: number; total: number }>({
    running: false,
    index: 0,
    total: 0,
  });
  const [toolError, setToolError] = useState<string | null>(null);
  const probeSession = useRef<string>("");
  const previewSession = useRef<string>("");

  const onToolEvent = useCallback((reply: ExtensionReply) => {
    if (!reply?.ok) {
      setToolError(reply?.error ? `${reply.error.code}: ${reply.error.message}` : "Extension trả lời không hợp lệ.");
      setProbing(null);
      return;
    }
    const data = reply.data ?? {};
    switch (reply.type) {
      case "PROBE_RESULT": {
        const probeId = String(data.probeId ?? "");
        setProbes((current) => ({ ...current, [probeId]: data.result as ProbeResult }));
        setProbing((current) => (current === probeId ? null : current));
        break;
      }
      case "PREVIEW_READY": {
        const session = data.session as { job?: { guide?: { steps?: unknown[] } } } | undefined;
        setPreview({ running: true, index: 0, total: session?.job?.guide?.steps?.length ?? 0 });
        setToolError(null);
        break;
      }
      case "PREVIEW_STEP":
        setPreview((current) => ({ ...current, index: Number(data.index ?? 0), total: Number(data.total ?? current.total) }));
        break;
      case "PREVIEW_DONE":
        setPreview({ running: false, index: 0, total: 0 });
        break;
      default:
        break;
    }
  }, []);

  const ext = useExtension({ onEvent: onToolEvent });

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
      // ONE call = one transaction. Metadata and steps are written together behind a
      // single optimistic guard, so a rejected save cannot leave steps committed while
      // the metadata was refused.
      const saved = await rpcSaveGuide(createClient(), {
        guideId: guide.id,
        name: meta.name,
        site: meta.siteCode,
        groupName: meta.groupName,
        startUrl: meta.startUrl,
        sortOrder: meta.sortOrder,
        notes: meta.notes.trim() === "" ? null : meta.notes,
        steps: serializeSteps(steps),
        validation: buildValidationPayload(validation, guide.validation),
        expectedUpdatedAt: baseUpdatedAt,
      });

      setBaseUpdatedAt(saved.updatedAt);
      setStatus(saved.status);
      setBaseline({ meta, steps });
      setSaving("saved");
      // Refresh so publishError and the guide list reflect the new state.
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

  const origins = useMemo(() => originsOf(sites), [sites]);

  function probeStepOnPage(step: DraftStep) {
    setToolError(null);
    if (!probeSession.current) probeSession.current = newToolSessionId("prb");
    setProbing(step.id);
    const sent = ext.send(
      probeRequest({
        sessionId: probeSession.current,
        guideId: guide.id,
        siteCode: meta.siteCode,
        step,
        url: stepPageUrl(step, meta.siteCode, meta.startUrl, origins),
      }),
    );
    if (!sent) setProbing(null);
  }

  function startPreview() {
    setToolError(null);
    previewSession.current = newToolSessionId("pvw");
    // serializeSteps: chạy thử đúng hình dạng sẽ được lưu, không phải state thô của form.
    ext.send(
      previewRequest({
        sessionId: previewSession.current,
        guideId: guide.id,
        name: meta.name,
        siteCode: meta.siteCode,
        steps: serializeSteps(steps),
        url: previewStartUrl,
        origins,
      }),
    );
  }

  function stopPreview() {
    ext.send({ v: 1, type: "PREVIEW_STOP", payload: { sessionId: previewSession.current } });
    setPreview({ running: false, index: 0, total: 0 });
  }

  const previewStartUrl = steps.length
    ? stepPageUrl(steps[0], meta.siteCode, meta.startUrl, origins)
    : "";
  const previewReady = previewReadiness({
    extensionId: ext.extensionId,
    siteCode: meta.siteCode,
    steps,
    url: previewStartUrl,
  });

  const publishable = canPublish(validation, meta.siteCode);
  const statusState = { current: status, dirty, busy, publishable, hasSite: !!meta.siteCode };

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
              {/* Chỉ bộ còn trong hàng chờ phân loại mới được để trống site — database
                  từ chối xoá site của bộ đã phân loại, nên hiện lựa chọn đó là nói dối. */}
              {canClearSite(status) ? <option value="">— chưa gán —</option> : null}
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

      {/* ---------------------------------------------------------- recorder */}
      {/* Ghi xong chỉ chèn bước vào editor. Không tự ghi Supabase: người duyệt phải
          nhìn thấy bước ghi được rồi mới bấm "Lưu thay đổi". */}
      <RecorderPanel
        guideId={guide.id}
        siteCode={meta.siteCode}
        startUrl={meta.startUrl}
        sites={sites}
        dirty={dirty}
        disabled={busy}
        onInsert={(append) => updateSteps(append(steps))}
      />

      <PreviewPanel
        ready={previewReady}
        running={preview.running}
        live={ext.live}
        url={previewStartUrl}
        index={preview.index}
        total={preview.total}
        dirty={dirty}
        disabled={busy}
        onStart={startPreview}
        onStop={stopPreview}
      />

      {toolError ? <div className="alert alert-danger">{toolError}</div> : null}

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
              probe={probes[s.id] ?? null}
              probeBusy={probing === s.id}
              onProbe={{
                ...probeReadiness({
                  extensionId: ext.extensionId,
                  siteCode: meta.siteCode,
                  step: s,
                  url: stepPageUrl(s, meta.siteCode, meta.startUrl, origins),
                }),
                run: () => probeStepOnPage(s),
              }}
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

        {/* Mọi nút đổi trạng thái đều khoá khi còn thay đổi chưa lưu: đổi trạng thái bump
            updated_at ở server, editor remount và các chỉnh sửa chưa lưu sẽ biến mất. */}
        <div className="row">
          <button
            className="btn btn-sm"
            type="button"
            disabled={!canChangeStatus("draft", statusState)}
            title={dirty ? "Lưu thay đổi trước" : undefined}
            onClick={() => changeStatus("draft")}
          >
            Chuyển về draft
          </button>
          <button
            className="btn btn-sm"
            type="button"
            disabled={!canChangeStatus("published", statusState)}
            title={dirty ? "Lưu thay đổi trước" : !publishable ? "Còn lỗi validate hoặc chưa gán site" : undefined}
            onClick={() => changeStatus("published")}
          >
            Đánh dấu published
          </button>
          <button
            className="btn btn-sm"
            type="button"
            disabled={!canChangeStatus("archived", statusState)}
            title={dirty ? "Lưu thay đổi trước" : undefined}
            onClick={() => changeStatus("archived")}
          >
            Archive
          </button>
          <button
            className="btn btn-sm"
            type="button"
            disabled={busy || dirty || status === "published"}
            title={dirty ? "Lưu thay đổi trước" : undefined}
            onClick={remove}
            style={{ marginLeft: "auto", color: "var(--danger)" }}
          >
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
