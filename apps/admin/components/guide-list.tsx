import Link from "next/link";

import { statusChipClass, statusLabel } from "../lib/guides/status";
import type { GuideRow } from "../lib/guides/types";

function SiteChip({ site }: { site: string | null }) {
  if (site === "pos") return <span className="chip chip-pos">POS</span>;
  if (site === "admin") return <span className="chip chip-admin">Admin</span>;
  return <span className="chip chip-none">chưa gán</span>;
}

function StatusChip({ status }: { status: GuideRow["status"] }) {
  return <span className={statusChipClass(status)}>{statusLabel(status)}</span>;
}

export function GuideList({ guides }: { guides: GuideRow[] }) {
  if (!guides.length) {
    return <div className="card muted">Chưa có bộ hướng dẫn nào. Dùng trang Import để nhập 48 bộ legacy.</div>;
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Tên bộ</th>
            <th>Site</th>
            <th>Nhóm</th>
            <th>Bước</th>
            <th>Trạng thái</th>
            <th>URL bắt đầu</th>
          </tr>
        </thead>
        <tbody>
          {guides.map((g, i) => (
            <tr key={g.id}>
              <td className="muted">{i + 1}</td>
              <td><Link href={`/guides/${g.id}`}>{g.name}</Link></td>
              <td><SiteChip site={g.site_code} /></td>
              <td>{g.group_name || <span className="muted">—</span>}</td>
              <td>{g.step_count}</td>
              <td><StatusChip status={g.status} /></td>
              <td className="mono">{g.start_url}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
