"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import {
  EMPTY_RELEASE_TEXT,
  applyOutcome,
  currentRevision,
  isUnreleased,
  newFlight,
  nextRevision,
  publishGate,
  revisionText,
  rollbackGate,
  runPublish,
  runRollback,
  shortChecksum,
  type HistoryRow,
  type ReleaseDeps,
  type SiteReleaseState,
} from "../lib/guides/releases";
import { rpcListReleases, rpcPublishSite, rpcRollbackSite } from "../lib/guides/rpc";
import { GUIDE_STATUS_LABEL, RELEASE_HEAD_LABEL, releaseHeadChipClass } from "../lib/guides/status";
import type { PublishResult, SiteOption } from "../lib/guides/types";
import { createClient } from "../lib/supabase/client";

/**
 * One site's release controls. Rendered once per site, so POS and Admin are independent
 * by construction — there is no shared state for a failure on one to leak into.
 *
 * Everything that decides anything lives in lib/guides/releases.ts. What is left here is
 * the transport, the phase of the dialog, and the single-flight box.
 */

type Phase = "idle" | "confirm-publish" | "confirm-rollback" | "working";

/** Every call makes its own client, matching the other client components in this app. */
const deps: ReleaseDeps = {
  publish: (site, note) => rpcPublishSite(createClient(), site, note),
  rollback: (site, releaseId) => rpcRollbackSite(createClient(), site, releaseId),
  reload: (site) => rpcListReleases(createClient(), site),
};

function isPublish(result: unknown): result is PublishResult {
  return !!result && typeof result === "object" && "guides" in result;
}

export function ReleasePanel({ site, initial }: { site: SiteOption; initial: SiteReleaseState }) {
  const [state, setState] = useState<SiteReleaseState>(initial);
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState("");
  const [target, setTarget] = useState<HistoryRow | null>(null);

  // A ref, not state: two clicks in one tick both read the same stale useState value, so
  // the guard has to be something that can be written and read within a single tick.
  const flight = useRef(newFlight());

  const busy = phase === "working";
  const gate = publishGate({ approvedCount: state.approved.length, note, busy });
  const live = !isUnreleased(state.head);
  const expected = nextRevision(state);

  async function publish() {
    setPhase("working");
    const outcome = await runPublish(
      flight.current,
      { site: site.code, note, approvedCount: state.approved.length },
      deps,
    );
    setState((s) => applyOutcome(s, outcome));
    setPhase("idle");
    if (outcome.status === "ok") setNote("");
    // No router.refresh(): the panel just reloaded its own releases, and a refresh would
    // re-run every read on the page while this component's state — seeded from props —
    // quietly ignored the new ones. Publishing changes no guide row, so nothing else on
    // the page is stale.
  }

  async function rollback() {
    if (!target) return;
    setPhase("working");
    const outcome = await runRollback(flight.current, { site: site.code, row: target, head: state.head }, deps);
    setState((s) => applyOutcome(s, outcome));
    setPhase("idle");
    setTarget(null);
  }

  return (
    <div className="card stack">
      {/* ------------------------------------------------------------ header */}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>
          <span className={`chip chip-${site.code}`}>{site.label}</span> {site.origin}
        </strong>
        {live ? <span className={releaseHeadChipClass()}>{RELEASE_HEAD_LABEL}</span> : null}
      </div>

      {/* ----------------------------------------------------------- summary */}
      <div className="summary">
        <div className="card summary-item">
          <div className="summary-label">{GUIDE_STATUS_LABEL.draft}</div>
          <div className="summary-value">{state.draftCount}</div>
        </div>
        <div className="card summary-item">
          <div className="summary-label">{GUIDE_STATUS_LABEL.published}</div>
          <div className="summary-value">{state.approved.length}</div>
        </div>
        <div className="card summary-item">
          <div className="summary-label">Tổng bước</div>
          <div className="summary-value">{state.approvedStepTotal}</div>
        </div>
        <div className="card summary-item">
          <div className="summary-label">Revision hiện hành</div>
          <div className="summary-value">{currentRevision(state.head)}</div>
        </div>
      </div>

      <div className="row">
        {live ? (
          <>
            <span className="muted">Phát hành lúc {state.head!.released_at}</span>
            <span className="mono muted">{shortChecksum(state.head!.checksum)}</span>
            <span className="muted">
              {state.head!.guide_count} bộ · {state.head!.step_count} bước
            </span>
          </>
        ) : (
          <span className="muted">
            {EMPTY_RELEASE_TEXT} · {revisionText(state.head)}
          </span>
        )}
      </div>

      {state.error ? (
        <div className="alert alert-danger" role="alert">
          {state.error}
        </div>
      ) : null}

      {state.lastResult ? (
        <div className="alert alert-success">
          {isPublish(state.lastResult) ? (
            <>
              Đã phát hành revision <strong>{state.lastResult.revision}</strong> — {state.lastResult.guides} bộ ·{" "}
              {state.lastResult.steps} bước · <span className="mono">{shortChecksum(state.lastResult.checksum)}</span>
            </>
          ) : (
            <>
              Đã rollback về nội dung của revision <strong>{state.lastResult.rolledBackFrom}</strong>, phát hành thành
              revision mới <strong>{state.lastResult.revision}</strong>.
            </>
          )}
        </div>
      ) : null}

      {/* ------------------------------------------- what would go in the release */}
      {state.approved.length ? (
        <details>
          <summary style={{ cursor: "pointer" }}>Xem {state.approved.length} bộ sẽ vào bản phát hành</summary>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Bộ hướng dẫn</th>
                  <th>Bước</th>
                  <th>Cảnh báo</th>
                </tr>
              </thead>
              <tbody>
                {state.approved.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <Link href={`/guides/${g.id}`}>{g.name}</Link>
                    </td>
                    <td>{g.stepCount}</td>
                    <td>
                      {g.hasAutoClickFlag ? (
                        <span className="chip chip-warning">Auto-click chưa có neo text</span>
                      ) : g.hasWarnings ? (
                        <span className="chip">có cảnh báo</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : (
        <div className="muted">{gate.reason}</div>
      )}

      {/* ----------------------------------------------------------- publish */}
      {phase === "confirm-publish" ? (
        <div className="card stack" role="dialog" aria-labelledby={`confirm-publish-${site.code}`}>
          <strong id={`confirm-publish-${site.code}`}>Xác nhận phát hành</strong>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                <tr>
                  <th>Site</th>
                  <td>{site.label}</td>
                </tr>
                <tr>
                  <th>Guide</th>
                  <td>{state.approved.length} (dự kiến)</td>
                </tr>
                <tr>
                  <th>Bước</th>
                  <td>{state.approvedStepTotal} (dự kiến)</td>
                </tr>
                <tr>
                  <th>Revision hiện tại</th>
                  <td>{currentRevision(state.head)}</td>
                </tr>
                <tr>
                  <th>Revision dự kiến</th>
                  <td>{expected}</td>
                </tr>
                <tr>
                  <th>Ghi chú phát hành</th>
                  <td>{note.trim()}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {/* Số guide/bước và revision là ảnh chụp lúc mở trang. Server mới là nơi chốt:
              nó khoá advisory lock theo site rồi mới dựng payload. */}
          <div className="muted">
            Con số trên là dự kiến. Server sẽ dựng payload và tính checksum của chính nó, rồi báo lại số thật.
          </div>
          <div className="row">
            <button className="btn btn-primary" type="button" onClick={publish}>
              Đồng ý, phát hành
            </button>
            <button className="btn" type="button" onClick={() => setPhase("idle")}>
              Huỷ
            </button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <div className="field">
            <label className="label" htmlFor={`note-${site.code}`}>
              Ghi chú phát hành (bắt buộc)
            </label>
            <input
              id={`note-${site.code}`}
              className="input"
              value={note}
              disabled={busy}
              placeholder="Ví dụ: sửa selector Cài Đặt sau khi POS đổi header"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="row">
            <button
              className="btn btn-primary"
              type="button"
              disabled={!gate.ok}
              title={gate.reason}
              onClick={() => setPhase("confirm-publish")}
            >
              Phát hành site {site.label}
            </button>
            {gate.ok ? null : <span className="muted">{gate.reason}</span>}
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------- history */}
      <strong>Lịch sử phát hành</strong>
      {state.history.length === 0 ? (
        <div className="muted">{EMPTY_RELEASE_TEXT}.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Revision</th>
                <th>Thời điểm</th>
                <th>Người phát hành</th>
                <th>Bộ</th>
                <th>Bước</th>
                <th>Checksum</th>
                <th>Ghi chú</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {state.history.map((r) => {
                const canRoll = rollbackGate(r, state.head, busy);
                return (
                  <tr key={r.id}>
                    <td>
                      {r.revision} {r.isHead ? <span className={releaseHeadChipClass()}>{RELEASE_HEAD_LABEL}</span> : null}
                    </td>
                    <td>{r.releasedAt}</td>
                    <td>{r.releasedByEmail ?? <span className="muted">—</span>}</td>
                    <td>{r.guideCount}</td>
                    <td>{r.stepCount}</td>
                    <td className="mono">{shortChecksum(r.checksum)}</td>
                    <td>
                      {r.note ?? <span className="muted">—</span>}
                      {r.rolledBackFromRevision !== null ? (
                        <div className="muted">Rollback từ revision {r.rolledBackFromRevision}</div>
                      ) : null}
                    </td>
                    <td>
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={!canRoll.ok}
                        title={canRoll.reason}
                        onClick={() => {
                          setTarget(r);
                          setPhase("confirm-rollback");
                        }}
                      >
                        Rollback
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {phase === "confirm-rollback" && target ? (
        <div className="card stack" role="dialog" aria-labelledby={`confirm-rollback-${site.code}`}>
          <strong id={`confirm-rollback-${site.code}`}>Xác nhận rollback</strong>
          <p style={{ margin: 0 }}>
            Site <strong>{site.label}</strong>: lấy lại nội dung của revision <strong>{target.revision}</strong>, trong
            khi bản đang chạy là revision <strong>{currentRevision(state.head)}</strong>.
          </p>
          {/* Revision không bao giờ giảm: extension từ chối downgrade, nên hạ số sẽ làm
              mọi máy đã nhận bản cao hơn đứng vĩnh viễn. Rollback = phát hành lại nội
              dung cũ dưới một số MỚI. */}
          <p style={{ margin: 0 }}>
            Nội dung cũ sẽ được phát hành lại thành revision <strong>{expected}</strong> — cao hơn bản hiện tại, không
            phải hạ số.
          </p>
          <div className="muted">
            Ghi chú sẽ do hệ thống tự ghi: <span className="mono">Rollback về revision {target.revision}</span>
          </div>
          <div className="row">
            <button className="btn btn-primary" type="button" onClick={rollback}>
              Đồng ý, rollback
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setTarget(null);
                setPhase("idle");
              }}
            >
              Huỷ
            </button>
          </div>
        </div>
      ) : null}

      {busy ? <div className="alert alert-info">Đang gửi lệnh tới database…</div> : null}
    </div>
  );
}
