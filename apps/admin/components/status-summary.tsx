import type { GuideCounts } from "../lib/guides/types";

export function StatusSummary({ counts }: { counts: GuideCounts }) {
  const items: Array<{ label: string; value: number }> = [
    { label: "Tổng", value: counts.total },
    { label: "Chưa phân loại", value: counts.unassigned },
    { label: "Draft", value: counts.draft },
    { label: "Published", value: counts.published },
    { label: "Archived", value: counts.archived },
  ];
  return (
    <div className="summary">
      {items.map((it) => (
        <div key={it.label} className="card summary-item">
          <div className="summary-label">{it.label}</div>
          <div className="summary-value">{it.value}</div>
        </div>
      ))}
    </div>
  );
}
