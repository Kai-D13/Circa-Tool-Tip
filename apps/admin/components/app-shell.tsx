import Link from "next/link";
import type { ReactNode } from "react";

const NAV = [
  { href: "/guides", label: "Bộ hướng dẫn" },
  { href: "/guides/import", label: "Import" },
  { href: "/guides/triage", label: "Phân loại" },
  { href: "/releases", label: "Phát hành" },
] as const;

export function AppShell({
  current,
  email,
  children,
}: {
  current: (typeof NAV)[number]["href"];
  email: string;
  children: ReactNode;
}) {
  return (
    <>
      <header className="shell-header">
        <div className="shell-brand">Circa Tool-tip</div>
        <nav className="shell-nav" aria-label="Chính">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} aria-current={item.href === current ? "page" : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="shell-user">
          <span>{email}</span>
          <form action="/auth/signout" method="post">
            <button className="btn btn-sm" type="submit">Đăng xuất</button>
          </form>
        </div>
      </header>
      <main className="shell-main">{children}</main>
    </>
  );
}
