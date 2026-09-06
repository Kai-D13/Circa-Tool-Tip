/**
 * Pure routing policy for the proxy. Kept free of Next.js imports so it can be unit
 * tested with `node --test`.
 */

export const PUBLIC_PATHS = ["/login", "/unauthorized"];

export type RouteAction = "allow" | "redirect-login" | "redirect-home";

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function resolveRouteAction(pathname: string, isAuthenticated: boolean): RouteAction {
  // Sign-out and any future auth callbacks must always be reachable.
  if (pathname.startsWith("/auth/")) return "allow";

  if (!isAuthenticated) return isPublicPath(pathname) ? "allow" : "redirect-login";

  // A signed-in user has no business on the login page.
  if (pathname === "/login") return "redirect-home";
  return "allow";
}

export const HOME_PATH = "/guides";
export const LOGIN_PATH = "/login";
