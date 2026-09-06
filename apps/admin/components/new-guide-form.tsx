"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { rpcUpsertGuide } from "../lib/guides/rpc";
import type { SiteOption } from "../lib/guides/types";
import { createClient } from "../lib/supabase/client";

export function NewGuideForm({ sites }: { sites: SiteOption[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [site, setSite] = useState<string>(sites[0]?.code ?? "");
  const [groupName, setGroupName] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { guideId } = await rpcUpsertGuide(createClient(), {
        guideId: null,
        name,
        site: site || null,
        groupName,
        startUrl,
        sortOrder: 0,
        notes: null,
      });
      router.push(`/guides/${guideId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={onSubmit}>
      <div className="field">
        <label className="label" htmlFor="g-name">Tên bộ</label>
        <input id="g-name" className="input" required value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="field" style={{ width: 170 }}>
          <label className="label" htmlFor="g-site">Site</label>
          <select id="g-site" className="select" value={site} disabled={busy} onChange={(e) => setSite(e.target.value)}>
            <option value="">— chưa gán —</option>
            {sites.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
        </div>
        <div className="field" style={{ width: 200 }}>
          <label className="label" htmlFor="g-group">Nhóm (tuỳ chọn)</label>
          <input id="g-group" className="input" value={groupName} disabled={busy} onChange={(e) => setGroupName(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label className="label" htmlFor="g-url">URL bắt đầu</label>
          <input id="g-url" className="input mono" placeholder="/trang-chu" value={startUrl} disabled={busy} onChange={(e) => setStartUrl(e.target.value)} />
        </div>
      </div>
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? "Đang tạo…" : "Tạo và sửa bước"}
        </button>
      </div>
    </form>
  );
}
