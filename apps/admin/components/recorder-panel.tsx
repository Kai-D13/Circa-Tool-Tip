"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftStep } from "@circa/guide-schema";

import {
  appendRecorded,
  newRecordingId,
  originToSite,
  recordReadiness,
  recordingStartUrl,
  siteOrigins,
  type RecordedStep,
  type RecorderSession,
} from "../lib/guides/recorder";
import type { SiteOption } from "../lib/guides/types";
import { useExtension, type ExtensionReply } from "./use-extension";

/**
 * The Portal half of the recorder.
 *
 * The port itself lives in useExtension, shared with the selector probe and the preview.
 * What stays here is what only the recorder knows:
 *
 *   - The port is a fast path, not the truth. The recording lives in the extension's
 *     session storage; the port only pushes changes as they happen. It dies whenever the
 *     service worker is evicted or the extension reloads, and the recording carries on
 *     regardless — so a dead port drops us to polling GET_RECORDING, and Stop/Undo just
 *     open a fresh port.
 *   - Recorded steps NEVER reach Supabase from here. They land in the editor exactly as
 *     if they had been typed, and are saved only when the Admin presses "Lưu thay đổi".
 */

const POLL_MS = 2000;

type Phase = "idle" | "starting" | "recording" | "stopped";

export function RecorderPanel({
  guideId,
  siteCode,
  startUrl,
  sites,
  dirty,
  disabled,
  onInsert,
}: {
  guideId: string;
  siteCode: string | null;
  startUrl: string;
  sites: SiteOption[];
  dirty: boolean;
  disabled: boolean;
  onInsert: (append: (existing: DraftStep[]) => DraftStep[], count: number) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [steps, setSteps] = useState<RecordedStep[]>([]);
  const [where, setWhere] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phaseRef = useRef<Phase>("idle");

  phaseRef.current = phase;

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const finish = useCallback(
    (session: RecorderSession | undefined) => {
      if (session) setSteps(session.steps ?? []);
      setPhase("stopped");
      stopPolling();
    },
    [stopPolling],
  );

  const onEvent = useCallback(
    (reply: ExtensionReply) => {
      if (!reply?.ok) {
        setError(reply?.error ? `${reply.error.code}: ${reply.error.message}` : "Extension trả lời không hợp lệ.");
        if (phaseRef.current === "starting") setPhase("idle");
        return;
      }
      const session = reply.data?.session as RecorderSession | undefined;
      switch (reply.type) {
        case "READY":
          sessionRef.current = session?.id ?? null;
          setSteps(session?.steps ?? []);
          setPhase("recording");
          setError(null);
          break;
        case "STEP":
        case "UNDO":
          setSteps(session?.steps ?? []);
          break;
        case "NAVIGATED":
          setWhere(String(reply.data?.url ?? ""));
          break;
        case "DONE":
          finish(session);
          break;
        default:
          break;
      }
    },
    [finish],
  );

  /** Poll storage directly. Slower than the port, but it survives the port dying. */
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      const sessionId = sessionRef.current;
      if (!sessionId) return;
      void extRef.current
        .oneShot({ v: 1, type: "GET_RECORDING", payload: { sessionId } })
        .then((reply) => {
          if (!reply) return;
          if (!reply.ok) {
            // The session is gone from session storage: the browser was closed or the
            // extension reloaded. Nothing more will arrive.
            setError(`${reply.error?.code}: ${reply.error?.message}`);
            finish(undefined);
            return;
          }
          const session = reply.data?.session as RecorderSession | undefined;
          setSteps(session?.steps ?? []);
          if (session?.status === "done") finish(session);
        });
    }, POLL_MS);
  }, [finish]);

  const ext = useExtension({
    onEvent,
    onDisconnect: () => {
      if (phaseRef.current === "recording") startPolling();
    },
  });

  // The disconnect handler is created before `ext` exists; a ref keeps the polling
  // callback pointing at the live transport without re-creating the port every render.
  const extRef = useRef(ext);
  extRef.current = ext;

  useEffect(() => () => stopPolling(), [stopPolling]);

  const origins = siteOrigins(sites);
  const absoluteStart = recordingStartUrl(siteCode, startUrl, origins);
  const ready = recordReadiness({ extensionId: ext.extensionId, siteCode, startUrl: absoluteStart, dirty });

  function start() {
    setError(null);
    ext.setError(null);
    setSteps([]);
    setWhere("");
    setPhase("starting");
    const id = newRecordingId();
    sessionRef.current = id;
    const sent = ext.send({
      v: 1,
      type: "START",
      payload: { session: { id, guideId, site: siteCode, startUrl: absoluteStart, mode: "append" } },
    });
    if (!sent) setPhase("idle");
  }

  function undo() {
    ext.send({ v: 1, type: "UNDO", payload: { sessionId: sessionRef.current } });
  }

  function stop() {
    ext.send({ v: 1, type: "STOP", payload: { sessionId: sessionRef.current } });
  }

  function insert() {
    const captured = steps;
    const originSite = originToSite(sites);
    onInsert((existing) => appendRecorded(existing, captured, { guideSite: siteCode, originSite }), captured.length);
    reset();
  }

  function reset() {
    setPhase("idle");
    setSteps([]);
    setWhere("");
    setError(null);
    ext.setError(null);
    sessionRef.current = null;
    stopPolling();
    ext.disconnect();
  }

  const shown = error ?? ext.error;

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Ghi hướng dẫn từ thao tác thật</strong>
        {phase === "recording" ? (
          <span className={ext.live ? "chip chip-success" : "chip chip-warning"}>
            {ext.live ? "Đang kết nối extension" : `Mất kết nối — hỏi lại mỗi ${POLL_MS / 1000}s`}
          </span>
        ) : null}
      </div>

      {shown ? <div className="alert alert-danger">{shown}</div> : null}

      {phase === "idle" ? (
        <div className="row">
          <button className="btn" type="button" disabled={disabled || !ready.ok} title={ready.reason} onClick={start}>
            Bắt đầu ghi
          </button>
          <span className="muted">
            {ready.ok
              ? `Extension sẽ mở ${absoluteStart} trong tab mới. Bấm vào từng phần tử cần hướng dẫn.`
              : ready.reason}
          </span>
        </div>
      ) : null}

      {phase === "starting" ? <div className="muted">Đang mở tab và bắt đầu phiên ghi…</div> : null}

      {phase === "recording" ? (
        <div className="stack">
          <div className="row">
            <span className="chip chip-warning">Đang ghi</span>
            <strong>{steps.length} bước</strong>
            {where ? <span className="muted mono">{where}</span> : null}
          </div>
          <div className="row">
            <button className="btn btn-sm" type="button" disabled={!steps.length} onClick={undo}>
              Hoàn tác bước cuối
            </button>
            <button className="btn btn-sm btn-primary" type="button" onClick={stop}>
              Dừng ghi
            </button>
          </div>
          <div className="muted">
            Thao tác trên tab vừa mở. Mỗi lần bấm được lưu lại trước khi trang chuyển, nên điều hướng không làm mất bước.
          </div>
        </div>
      ) : null}

      {phase === "stopped" ? (
        <div className="stack">
          <div className="row">
            <span className="chip">Đã dừng</span>
            <strong>{steps.length} bước ghi được</strong>
          </div>
          {steps.length ? (
            <ol className="mono" style={{ margin: 0, paddingLeft: 20, maxHeight: 180, overflowY: "auto" }}>
              {steps.map((s, i) => (
                <li key={`${s.urlPattern}-${i}`}>
                  {s.matchText || `<${s.tag}>`} <span className="muted">· {s.selectors[0] ?? "—"}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="muted">Không có bước nào được ghi.</div>
          )}
          <div className="row">
            <button className="btn btn-primary" type="button" disabled={!steps.length || disabled} onClick={insert}>
              Chèn {steps.length} bước vào cuối bộ
            </button>
            <button className="btn btn-sm" type="button" onClick={reset}>
              Bỏ
            </button>
          </div>
          <div className="muted">
            Chèn xong vẫn chưa lưu vào database — bấm <strong>Lưu thay đổi</strong> mới ghi.
          </div>
        </div>
      ) : null}
    </div>
  );
}
