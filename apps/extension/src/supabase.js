/**
 * The extension's read-only access to Supabase.
 *
 * Two calls, both anonymous. `release_heads` and `releases` carry SELECT policies for
 * `anon` (migration 0002) because this is the extension's data plane — it holds nothing
 * but a publishable key, and everything published is readable with it. That is exactly
 * why the importer scrubs PII before anything is imported.
 *
 * Header contract: the publishable key goes in `apikey`, and ONLY there.
 * `sb_publishable_…` is not a JWT, so `Authorization: Bearer` is not a place it belongs —
 * sending it there gets the request rejected rather than authorised. There is no user
 * session here and there must never be one: the extension never authenticates a person.
 */

/** Pure, so a test can prove the key never lands in an Authorization header. */
export function buildHeaders(key) {
  return {
    apikey: String(key || ""),
    Accept: "application/json",
    // get_release is a POST with a JSON body; PostgREST refuses it without this.
    "Content-Type": "application/json",
  };
}

/** `release_heads` for every site in one request — two rows, a few hundred bytes. */
export function headsUrl(supabaseUrl) {
  const base = String(supabaseUrl || "").replace(/\/+$/, "");
  return `${base}/rest/v1/release_heads?select=site_code,revision,checksum,released_at`;
}

export function releaseUrl(supabaseUrl) {
  const base = String(supabaseUrl || "").replace(/\/+$/, "");
  return `${base}/rest/v1/rpc/get_release`;
}

/**
 * @param {{url: string, key: string, fetchImpl?: typeof fetch, timeoutMs?: number}} config
 */
export function createApi({ url, key, fetchImpl = fetch, timeoutMs = 15000 }) {
  if (!url) throw new Error("Thiếu Supabase URL — build lại extension với cấu hình đầy đủ.");
  if (!key) throw new Error("Thiếu publishable key — build lại extension với cấu hình đầy đủ.");

  async function request(target, init) {
    // A hung request must not hold the sync pipeline open forever; the next alarm would
    // then find it still "in flight" and skip, and the extension would quietly stop
    // syncing with no error anywhere.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(target, { ...init, headers: buildHeaders(key), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`Supabase trả về ${response.status} cho ${target}`);
    }
    return response.json();
  }

  return {
    /** @returns {Promise<Array<{site_code: string, revision: number, checksum: string, released_at: string}>>} */
    async heads() {
      const rows = await request(headsUrl(url), { method: "GET" });
      return Array.isArray(rows) ? rows : [];
    },

    /** The full payload for one site. Only called when the revision actually moved. */
    async release(site) {
      return request(releaseUrl(url), {
        method: "POST",
        body: JSON.stringify({ p_site: site }),
      });
    },
  };
}
