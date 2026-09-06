import { redirect } from "next/navigation";

import { createClient } from "../supabase/server";

export type AdminSession = { userId: string; email: string };

/**
 * The real authorisation gate. Every protected page calls this on the server:
 *   1. a verified session must exist (getClaims verifies the JWT), else -> /login
 *   2. profiles.role must be 'admin', else -> /unauthorized
 *
 * profiles is readable by the user for their own row (RLS policy profiles_read_self),
 * so no privileged key is involved.
 */
export async function requireAdmin(): Promise<AdminSession> {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims || typeof claims.sub !== "string" || !claims.sub) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", claims.sub)
    .maybeSingle();

  if (profile?.role !== "admin") {
    redirect("/unauthorized");
  }

  return { userId: claims.sub, email: typeof claims.email === "string" ? claims.email : "" };
}
