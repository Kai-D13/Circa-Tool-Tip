import { NextResponse, type NextRequest } from "next/server";

import { HOME_PATH, LOGIN_PATH, resolveRouteAction } from "./lib/auth/route-policy";
import { updateSession } from "./lib/supabase/proxy";

/**
 * Next.js 16 proxy (formerly middleware): refresh the session and do coarse redirects.
 * Authorisation (admin role) is enforced per page in requireAdmin(), not here.
 */
export async function proxy(request: NextRequest) {
  const { response, isAuthenticated } = await updateSession(request);
  const action = resolveRouteAction(request.nextUrl.pathname, isAuthenticated);

  if (action === "allow") {
    // Auth responses carry Set-Cookie; never let a CDN cache them.
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }

  const url = request.nextUrl.clone();
  url.pathname = action === "redirect-login" ? LOGIN_PATH : HOME_PATH;
  url.search = "";
  const redirect = NextResponse.redirect(url);
  // Keep any cookies the refresh just rotated, or the next request would refresh again.
  response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
  redirect.headers.set("Cache-Control", "private, no-store");
  return redirect;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
