"use client";

import { useState, type ChangeEvent } from "react";

import { checkArtifact, type ArtifactCheck } from "../lib/guides/import-artifact";
import { rpcImportLegacy } from "../lib/guides/rpc";
import type { ImportResult } from "../lib/guides/types";
import { createClient } from "../lib/supabase/client";

type Phase = "idle" | "checked" | "confirm" | "importing" | "done";

export function ImportPanel() {
  const [fileText, setFileText] = useState<string>("");
  const [filename, setFilename] = useState<string>("");
  const [check, setCheck] = useState<ArtifactCheck | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    setCheck(null);
    setResult(null);
    setError(null);
    setPhase("idle");
    if (!f) {
      setFileText("");
      setFilename("");
      return;
    }
    setFilename(f.name);
    setFileText(await f.text());
  }

  async function onCheck() {
    setError(null);
    const r = await checkArtifact(fileText, filename);
    setCheck(r);
    setPhase("checked");
  }

  async function onImport() {
    if (!check?.ok || !check.payload || !check.summary) return;
    setPhase("importing");
    setError(null);
    try {
      const supabase = createClient();
      // Pass the checksum WE computed, not the one in the file.
      const r = await rpcImportLegacy(supabase, check.payload, filename, check.summary.computedChecksum);
      setResult(r);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("checked");
    }
  }

  const s = check?.summary;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="field">
          <label className="label" htmlFor="artifact">File artifact (<span className="mono">data/legacy-import.v5.json</span>)</label>
          <input id="artifact" type="file" accept="application/json,.json" onChange={onPick} />
        </div>
        <div className="row">
          <button className="btn" type="button" onClick={onCheck} disabled={!fileText || phase === "importing"}>
            Kiểm tra file
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => setPhase("confirm")}
            disabled={!check?.ok || phase === "importing" || phase === "done"}
          >
            Import {s?.guides ?? 48} bộ hướng dẫn
          </button>
        </div>
      </div>

      {s ? (
        <div className="card stack">
          <strong>Kết quả kiểm tra</strong>
          <table className="table">
            <tbody>
              <tr><th>File</th><td>{s.filename}</td></tr>
              <tr><th>Loại</th><td className="mono">{s.type}</td></tr>
              <tr><th>schemaVersion</th><td>{s.schemaVersion}</td></tr>
              <tr><th>Guide / Step</th><td><strong>{s.guides} / {s.steps}</strong></td></tr>
              <tr><th>sourceFileSha256</th><td className="mono">{s.sourceFileSha256 || "—"}</td></tr>
              <tr><th>contentChecksum trong file</th><td className="mono">{s.embeddedChecksum || "—"}</td></tr>
              <tr><th>contentChecksum tính lại</th><td className="mono">{s.computedChecksum}</td></tr>
            </tbody>
          </table>
          {check?.ok ? (
            <div className="alert alert-success">File hợp lệ, checksum khớp. Có thể import.</div>
          ) : (
            <div className="alert alert-danger">
              <div><strong>File không hợp lệ:</strong></div>
              <ul style={{ margin: "4px 0 0 18px" }}>
                {check?.errors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            </div>
          )}
        </div>
      ) : null}

      {phase === "confirm" && s ? (
        <div className="card stack" role="dialog" aria-labelledby="confirm-title">
          <strong id="confirm-title">Xác nhận import</strong>
          <p style={{ margin: 0 }}>
            Sẽ gọi <span className="mono">admin_import_legacy</span> với <strong>{s.guides} guide / {s.steps} step</strong>.
            Mọi bộ được nhập ở trạng thái <em>chưa phân loại</em>. Bộ đã được phân loại từ trước sẽ không bị ghi đè.
          </p>
          <div className="row">
            <button className="btn btn-primary" type="button" onClick={onImport}>Đồng ý, import</button>
            <button className="btn" type="button" onClick={() => setPhase("checked")}>Huỷ</button>
          </div>
        </div>
      ) : null}

      {phase === "importing" ? <div className="alert alert-info">Đang import…</div> : null}
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}

      {result ? (
        <div className="card stack">
          <div className="alert alert-success">Import xong.</div>
          <table className="table">
            <tbody>
              <tr><th>Guide / Step</th><td>{result.guides} / {result.steps}</td></tr>
              <tr><th>Thêm mới</th><td>{result.inserted}</td></tr>
              <tr><th>Cập nhật (chưa phân loại)</th><td>{result.updated}</td></tr>
              <tr><th>Bỏ qua (đã phân loại)</th><td>{result.skippedBecauseTriaged}</td></tr>
              <tr><th>Còn chưa phân loại</th><td><strong>{result.unassignedRemaining}</strong></td></tr>
              <tr><th>contentChecksum</th><td className="mono">{result.contentChecksum}</td></tr>
            </tbody>
          </table>
          <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(result, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
}
