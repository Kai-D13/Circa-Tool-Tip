/**
 * The only two configuration values the Portal needs. Both are public by design: the
 * publishable key can only do what RLS and the admin RPCs allow.
 */
export function supabaseEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Thiếu NEXT_PUBLIC_SUPABASE_URL hoặc NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. " +
        "Tạo apps/admin/.env.local theo .env.example.",
    );
  }
  return { url, key };
}
