import Link from "next/link";

import { AppShell } from "../../../components/app-shell";
import { NewGuideForm } from "../../../components/new-guide-form";
import { requireAdmin } from "../../../lib/auth/require-admin";
import { fetchSites } from "../../../lib/guides/sites";
import { createClient } from "../../../lib/supabase/server";

export const metadata = { title: "Tạo bộ mới · Circa Tool-tip Admin" };

export default async function NewGuidePage() {
  const session = await requireAdmin();
  const supabase = await createClient();
  const sites = await fetchSites(supabase);

  return (
    <AppShell current="/guides" email={session.email}>
      <p style={{ margin: "0 0 8px" }}><Link href="/guides">← Danh sách bộ hướng dẫn</Link></p>
      <h1 className="page-title">Tạo bộ hướng dẫn mới</h1>
      <p className="page-lead">Nhập thông tin cơ bản, sau đó thêm bước ở màn hình sửa.</p>
      <NewGuideForm sites={sites} />
    </AppShell>
  );
}
