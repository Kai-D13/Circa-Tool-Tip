"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftStep } from "@circa/guide-schema";

import {
  appendRecorded,
  newRecordingId,
  originToSite,
  recordReadiness,
  recordingStartUrl,
  resolveExtensionId,
  siteOrigins,
  type RecordedStep,
  type RecorderSession,
} from "../lib/guides/recorder";
import type { SiteOption } from "../lib/guides/types";

/**
 * The Portal half of the recorder.
 *
 * Only the transport lives here. Everything that decides what a recorded click MEANS is
 * in lib/guides/recorder.ts, where it can be tested without a browser or an extension.
 *
 * Two states are worth understanding before reading the code:
 *
 *   - The port is a fast path, not the truth. The recording lives in the extension's
 *     session storage; the port only pushes changes as they happen. It dies whenever the
 *     service worker is evicted or the extension reloads, and the recording carries on
 *     regardless — so a dead port drops us to polling GET_RECORDING, and Stop/Undo just
 *     open a fresh port.
 *   - Recorded steps NEVER reach Supabase from here. They land in the editor exactly as
 *     if they had been typed, and are saved only when the Admin presses "Lưu thay đổi".
 */

type Reply = {
  ok: boolean;
  type: string;
  data?: { session?: RecorderSession; url?: string };
  error?: { code: string; message: string };
};

interface Port {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (message: Reply) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

interface Runtime {
  connect(extensionId: string, info: { name: string }): Port;
  sendMessage(extensionId: string, message: unknown, callback: (reply?: Reply) => void): void;
  lastError?: { message?: string };
}

function runtime(): Runtime | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { chrome?: { runtime?: Runtime } }).chrome?.runtime ?? null;
}

const PORT_NAME = "tg-recorder";
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
  const [extensionId, setExtensionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [steps, setSteps] = useState<RecordedStep[]>([]);
  const [live, setLive] = useState(true);
  const [where, setWhere] = useState("");
  const [error, setError] = useState<string | null>(null);

  const portRef = useRef<Port | null>(null);
  const sessionRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phaseRef = useRef<Phase>("idle");

  phaseRef.current = phase;

  // Reading localStorage and window.chrome has to wait for the client; on the server
  // there is neither, and guessing would make the first render disagree with the second.
  useEffect(() => {
    let override: string | null = null;
    try {
      override = window.localStorage.getItem("tg:extensionId");
    } catch {
      /* private mode; the configured id is the answer then */
    }
    setExtensionId(
      resolveExtensionId(process.env.NEXT_PUBLIC_EXTENSION_ID, override, process.env.NODE_ENV === "production"),
    );
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const finish = useCallback(
    (session: RecorderSession | undefined) => {
      if (session) setSteps(session.steps ?? []);
      setPhase("stopped");
      stopPolling();
      setLive(true);
    },
    [stopPolling],
  );

  const onReply = useCallback(
    (reply: Reply) => {
      if (!reply?.ok) {
        setError(reply?.error ? `${reply.error.code}: ${reply.error.message}` : "Extension trả lời không hợp lệ.");
        if (phaseRef.current === "starting") setPhase("idle");
        return;
      }
      switch (reply.type) {
        case "READY":
          sessionRef.current = reply.data?.session?.id ?? null;
          setSteps(reply.data?.session?.steps ?? []);
          setPhase("recording");
          setError(null);
          break;
        case "STEP":
        case "UNDO":
          setSteps(reply.data?.session?.steps ?? []);
          break;
        case "NAVIGATED":
          setWhere(reply.data?.url ?? "");
          break;
        case "DONE":
          finish(reply.data?.session);
          break;
        default:
          break;
      }
    },
    [finish],
  );

  /** Poll storage directly. Slower than the port, but it survives the port dying. */
  const startPolling = useCallback(() => {
    const api = runtime();
    if (!api || !extensionId || pollRef.current) return;
    pollRef.current = setInterval(() => {
      const sessionId = sessionRef.current;
      if (!sessionId) return;
      api.sendMessage(extensionId, { v: 1, type: "GET_RECORDING", payload: { sessionId } }, (reply) => {
        if (api.lastError || !reply) return;
        if (!reply.ok) {
          // The session is gone from session storage: the browser was closed or the
          // extension reloaded. Nothing more will arrive.
          setError(`${reply.error?.code}: ${reply.error?.message}`);
          finish(undefined);
          return;
        }
        const session = reply.data?.session;
        setSteps(session?.steps ?? []);
        if (session?.status === "done") finish(session);
      });
    }, POLL_MS);
  }, [extensionId, finish]);

  /**
   * The port, connecting it if the last one died. Stop and Undo have to keep working
   * after a service-worker restart, and a restart is invisible from here.
   */
  const ensurePort = useCallback((): Port | null => {
    if (portRef.current) return portRef.current;
    const api = runtime();
    if (!api || !extensionId) {
      setError("Không tìm thấy extension. Kiểm tra đã cài và đang bật.");
      return null;
    }
    try {
      const port = api.connect(extensionId, { name: PORT_NAME });
      port.onMessage.addListener(onReply);
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        if (phaseRef.current === "recording") {
          setLive(false);
          startPolling();
        }
      });
      portRef.current = port;
      setLive(true);
      return port;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [extensionId, onReply, startPolling]);

  useEffect(
    () => () => {
      stopPolling();
      portRef.current?.disconnect();
      portRef.current = null;
    },
    [stopPolling],
  );

  const origins = siteOrigins(sites);
  const absoluteStart = recordingStartUrl(siteCode, startUrl, origins);
  const ready = recordReadiness({ extensionId, siteCode, startUrl: absoluteStart, dirty });

  function start() {
    setError(null);
    setSteps([]);
    setWhere("");
    setPhase("starting");
    const id = newRecordingId();
    sessionRef.current = id;
    const port = ensurePort();
    if (!port) {
      setPhase("idle");
      return;
    }
    port.postMessage({
      v: 1,
      type: "START",
      payload: {
        session: { id, guideId, site: siteCode, startUrl: absoluteStart, mode: "append" },
      },
    });
  }

  function undo() {
    ensurePort()?.postMessage({ v: 1, type: "UNDO", payload: { sessionId: sessionRef.current } });
  }

  function stop() {
    ensurePort()?.postMessage({ v: 1, type: "STOP", payload: { sessionId: sessionRef.current } });
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
    sessionRef.current = null;
    portRef.current?.disconnect();
    portRef.current = null;
    stopPolling();
  }

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Ghi hướng dẫn từ thao tác thật</strong>
        {phase === "recording" ? (
          <span className={live ? "chip chip-success" : "chip chip-warning"}>
            {live ? "Đang kết nối extension" : `Mất kết nối — hỏi lại mỗi ${POLL_MS / 1000}s`}
          </span>
        ) : null}
      </div>

      {error ? <div className="alert alert-danger">{error}</div> : null}

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
