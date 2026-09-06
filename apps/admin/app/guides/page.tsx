import Link from "next/link";

import { AppShell } from "../../components/app-shell";
import { GuideList } from "../../components/guide-list";
import { StatusSummary } from "../../components/status-summary";
import { requireAdmin } from "../../lib/auth/require-admin";
import { rpcListGuides } from "../../lib/guides/rpc";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Bộ hướng dẫn · Circa Tool-tip Admin" };

export default async function GuidesPage() {
  const session = await requireAdmin();
  const supabase = await createClient();
  const result = await rpcListGuides(supabase);

  return (
    <AppShell current="/guides" email={session.email}>
      <h1 className="page-title">Bộ hướng dẫn</h1>
      <p className="page-lead">
        {result.counts.total === 0 ? (
          <>Chưa có dữ liệu. <Link href="/guides/import">Import 48 bộ legacy</Link> để bắt đầu.</>
        ) : result.counts.unassigned > 0 ? (
          <>Còn {result.counts.unassigned} bộ chưa phân loại — <Link href="/guides/triage">mở màn phân loại</Link>.</>
        ) : (
          <>Toàn bộ {result.counts.total} bộ đã được gán site.</>
        )}
      </p>
      <div className="stack">
        <StatusSummary counts={result.counts} />
        <GuideList guides={result.guides} />
      </div>
    </AppShell>
  );
}
