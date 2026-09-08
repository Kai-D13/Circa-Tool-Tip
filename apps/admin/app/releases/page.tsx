import { AppShell } from "../../components/app-shell";
import { ReleasePanel } from "../../components/release-panel";
import { requireAdmin } from "../../lib/auth/require-admin";
import { siteStateFrom } from "../../lib/guides/releases";
import { rpcListGuides, rpcListReleases } from "../../lib/guides/rpc";
import { fetchSites } from "../../lib/guides/sites";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Phát hành · Circa Tool-tip Admin" };

/**
 * Publishing is READ-ONLY on the way in. This page calls `admin_list_releases` and
 * `admin_list_guides` and nothing else — opening it must never create a release, so the
 * publish and rollback RPCs are deliberately not imported here at all. They live in the
 * client panel, behind a button and a confirmation.
 */
export default async function ReleasesPage() {
  const session = await requireAdmin();
  const supabase = await createClient();
  const sites = await fetchSites(supabase);

  // Both sites in parallel, and each site's two reads in parallel: four sequential awaits
  // would add three needless round trips to a page that is otherwise one screen of text.
  const states = await Promise.all(
    sites.map(async (site) => {
      const [releases, guides] = await Promise.all([
        rpcListReleases(supabase, site.code),
        // No status filter: one call gives the draft count, the approved list and the
        // flags. `admin_list_guides.counts` cannot be used — it is not filtered by site.
        rpcListGuides(supabase, { site: site.code }),
      ]);
      return siteStateFrom(site.code, releases, guides.guides);
    }),
  );

  return (
    <AppShell current="/releases" email={session.email}>
      <h1 className="page-title">Phát hành</h1>
      <p className="page-lead">
        POS và Admin phát hành độc lập. Bộ được duyệt vẫn chỉ nằm chờ — nó chỉ lên máy nhân viên sau khi bấm{" "}
        <strong>Phát hành site</strong>.
      </p>

      {sites.length === 0 ? (
        <div className="card muted">Chưa có site nào được bật trong bảng `sites`.</div>
      ) : (
        <div className="stack">
          {sites.map((site, i) => (
            <ReleasePanel key={site.code} site={site} initial={states[i]} />
          ))}
        </div>
      )}
    </AppShell>
  );
}
