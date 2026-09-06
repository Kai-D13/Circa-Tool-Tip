import { createBrowserClient } from "@supabase/ssr";

import { supabaseEnv } from "./env";

/** Browser-side client. Session lives in cookies so server requests see the same login. */
export function createClient() {
  const { url, key } = supabaseEnv();
  return createBrowserClient(url, key);
}
