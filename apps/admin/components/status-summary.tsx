import { GUIDE_STATUS_LABEL } from "../lib/guides/status";
import type { GuideCounts } from "../lib/guides/types";

export function StatusSummary({ counts }: { counts: GuideCounts }) {
  const items: Array<{ label: string; value: number }> = [
    { label: "Tổng", value: counts.total },
    { label: GUIDE_STATUS_LABEL.unassigned, value: counts.unassigned },
    { label: GUIDE_STATUS_LABEL.draft, value: counts.draft },
    { label: GUIDE_STATUS_LABEL.published, value: counts.published },
    { label: GUIDE_STATUS_LABEL.archived, value: counts.archived },
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
