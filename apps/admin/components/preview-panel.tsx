"use client";

import type { ToolReadiness } from "../lib/guides/preview";

/**
 * "Chạy thử" — walk the guide currently on screen, on the real site.
 *
 * Presentational only. The port, the state machine and the payload all live in
 * GuideEditor, because the selector probe shares the same connection with it: one port
 * per editor, not one per widget.
 */
export function PreviewPanel({
  ready,
  running,
  live,
  url,
  index,
  total,
  dirty,
  disabled,
  onStart,
  onStop,
}: {
  ready: ToolReadiness;
  running: boolean;
  live: boolean;
  url: string;
  index: number;
  total: number;
  dirty: boolean;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Chạy thử bộ này trên trang thật</strong>
        {running ? (
          <span className={live ? "chip chip-success" : "chip chip-warning"}>
            {live ? "Đang chạy thử" : "Mất kết nối extension"}
          </span>
        ) : null}
      </div>

      {running ? (
        <div className="stack">
          <div className="row">
            <strong>
              Bước {Math.min(index + 1, total)}/{total}
            </strong>
            <span className="muted">Điều khiển Trước / Tiếp / Thoát nằm trên chính trang đang chạy thử.</span>
          </div>
          <div className="row">
            <button className="btn btn-sm" type="button" onClick={onStop}>
              Dừng chạy thử
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="btn" type="button" disabled={disabled || !ready.ok} title={ready.reason} onClick={onStart}>
            Chạy thử
          </button>
          <span className="muted">
            {ready.ok ? `Mở ${url} và đi qua từng bước của bản đang sửa.` : ready.reason}
          </span>
        </div>
      )}

      {/* Đây là điểm khác biệt giữa "chạy thử" và "publish": bản nháp được gửi thẳng
          trong message, không đọc lại từ database và không đụng tới release nào. */}
      <div className="muted">
        Chạy thử dùng đúng bản đang sửa trên màn hình{dirty ? " (kể cả thay đổi chưa lưu)" : ""} — không lưu gì vào
        database và không đổi bản đã phát hành. Bước tự-bấm chỉ được tô sáng, không bấm hộ.
      </div>
    </div>
  );
}
