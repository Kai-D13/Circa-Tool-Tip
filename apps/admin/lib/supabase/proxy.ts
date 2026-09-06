import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { supabaseEnv } from "./env";

/**
 * Refresh the Supabase session inside the Next.js proxy and carry any rotated cookies
 * onto both the forwarded request and the outgoing response.
 *
 * Returns whether the request carries a verified session. It does NOT decide
 * authorisation: admin role is checked server-side per page (requireAdmin), because a
 * proxy matcher can be bypassed by a refactor and must never be the only gate.
 */
export async function updateSession(request: NextRequest): Promise<{
  response: NextResponse;
  isAuthenticated: boolean;
}> {
  let response = NextResponse.next({ request });
  const { url, key } = supabaseEnv();

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getClaims() verifies the JWT and triggers a refresh when needed. It must run before
  // any response is produced, otherwise a rotated token cannot be written back.
  const { data } = await supabase.auth.getClaims();
  const isAuthenticated = typeof data?.claims?.sub === "string" && data.claims.sub.length > 0;

  return { response, isAuthenticated };
}
