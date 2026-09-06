import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "../../../components/app-shell";
import { GuideEditor } from "../../../components/guide-editor";
import { requireAdmin } from "../../../lib/auth/require-admin";
import { rpcGetGuide } from "../../../lib/guides/rpc";
import { fetchSites } from "../../../lib/guides/sites";
import { createClient } from "../../../lib/supabase/server";

export const metadata = { title: "Sửa bộ hướng dẫn · Circa Tool-tip Admin" };

export default async function GuideDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireAdmin();
  const supabase = await createClient();

  const [detail, sites] = await Promise.all([
    rpcGetGuide(supabase, id).catch(() => null),
    fetchSites(supabase),
  ]);
  if (!detail) notFound();

  return (
    <AppShell current="/guides" email={session.email}>
      <p style={{ margin: "0 0 8px" }}><Link href="/guides">← Danh sách bộ hướng dẫn</Link></p>
      <h1 className="page-title">{detail.guide.name}</h1>
      <p className="page-lead">
        Sửa xong bấm <strong>Lưu thay đổi</strong>. Cảnh báo vẫn lưu được; lỗi thì phải sửa trước khi
        đánh dấu published.
      </p>
      {/* key forces a fresh editor state after router.refresh() picks up a new updated_at */}
      <GuideEditor key={detail.guide.updated_at} guide={detail.guide} sites={sites} publishError={detail.publishError} />
    </AppShell>
  );
}
