import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "../../../components/app-shell";
import { GuideEditor } from "../../../components/guide-editor";
import { requireAdmin } from "../../../lib/auth/require-admin";
import { isNotFoundError, rpcGetGuide } from "../../../lib/guides/rpc";
import { fetchSites } from "../../../lib/guides/sites";
import { createClient } from "../../../lib/supabase/server";

export const metadata = { title: "Sửa bộ hướng dẫn · Circa Tool-tip Admin" };

export default async function GuideDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireAdmin();
  const supabase = await createClient();

  // Only a genuine "row does not exist" becomes a 404. Swallowing every failure would
  // show "Not Found" for a network outage or a permission problem and hide the real cause.
  const detail = await rpcGetGuide(supabase, id).catch((err) => {
    if (isNotFoundError(err)) notFound();
    throw err;
  });
  const sites = await fetchSites(supabase);

  return (
    <AppShell current="/guides" email={session.email}>
      <p style={{ margin: "0 0 8px" }}><Link href="/guides">← Danh sách bộ hướng dẫn</Link></p>
      <h1 className="page-title">{detail.guide.name}</h1>
      <p className="page-lead">
        Sửa xong bấm <strong>Lưu thay đổi</strong>. Cảnh báo vẫn lưu được; lỗi thì phải sửa trước khi duyệt
        bộ này cho lần phát hành tiếp theo.
      </p>
      {/* key forces a fresh editor state after router.refresh() picks up a new updated_at */}
      <GuideEditor key={detail.guide.updated_at} guide={detail.guide} sites={sites} publishError={detail.publishError} />
    </AppShell>
  );
}
