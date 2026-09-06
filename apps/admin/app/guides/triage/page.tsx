import Link from "next/link";

import { AppShell } from "../../../components/app-shell";
import { TriageBoard } from "../../../components/triage-board";
import { requireAdmin } from "../../../lib/auth/require-admin";
import { rpcListGuides } from "../../../lib/guides/rpc";
import { createClient } from "../../../lib/supabase/server";

export const metadata = { title: "Phân loại · Circa Tool-tip Admin" };

export default async function TriagePage() {
  const session = await requireAdmin();
  const supabase = await createClient();
  const result = await rpcListGuides(supabase);

  return (
    <AppShell current="/guides/triage" email={session.email}>
      <h1 className="page-title">Phân loại POS / Admin</h1>
      <p className="page-lead">
        Gợi ý chỉ để tham khảo — người duyệt quyết định từng bộ. Bộ không gợi ý được nằm đầu danh sách.
        {result.counts.total === 0 ? <> Chưa có dữ liệu, <Link href="/guides/import">import trước</Link>.</> : null}
      </p>
      <TriageBoard initialGuides={result.guides} />
    </AppShell>
  );
}
