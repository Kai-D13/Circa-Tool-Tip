import Link from "next/link";

import { AppShell } from "../../../components/app-shell";
import { ImportPanel } from "../../../components/import-panel";
import { requireAdmin } from "../../../lib/auth/require-admin";

export const metadata = { title: "Import · Circa Tool-tip Admin" };

export default async function ImportPage() {
  const session = await requireAdmin();
  return (
    <AppShell current="/guides/import" email={session.email}>
      <h1 className="page-title">Import bộ hướng dẫn legacy</h1>
      <p className="page-lead">
        Chọn file artifact do importer sinh ra. Portal tính lại checksum từ nội dung file trước khi gửi;
        import xong thì sang <Link href="/guides/triage">phân loại</Link>.
      </p>
      <ImportPanel />
    </AppShell>
  );
}
