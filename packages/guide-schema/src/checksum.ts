/**
 * Circa Tool-tip — canonical JSON + SHA-256.
 *
 * Uses WebCrypto (`globalThis.crypto.subtle`) rather than node:crypto so the exact same
 * code runs in the importer (Node 24), the portal (browser) and the extension service
 * worker. The extension recomputes this checksum before swapping a release in, so the
 * three implementations must agree byte for byte — hence one shared module.
 */

/**
 * Deterministic JSON: object keys sorted, arrays kept in order, undefined dropped.
 * Any two callers serialising the same logical value produce the same string.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "undefined" ? null : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    if (typeof src[key] === "undefined") continue;
    out[key] = canonicalize(src[key]);
  }
  return out;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

export async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto subtle is unavailable in this context");
  const data = new TextEncoder().encode(input);
  return toHex(await subtle.digest("SHA-256", data));
}

/** Prefixed so a stored checksum states its own algorithm. */
export async function sha256Tagged(input: string): Promise<string> {
  return "sha256:" + (await sha256Hex(input));
}

/*
 * There is deliberately no releaseChecksum() here.
 *
 * Release checksums are computed SERVER-SIDE as sha256(jsonb::text). Postgres serialises
 * jsonb deterministically, but that ordering is not reproducible from JavaScript, so a
 * second implementation here could only ever disagree with the database. The extension
 * instead compares release_heads.checksum with the checksum embedded in the payload it
 * downloaded, which is the failure that actually matters: the head moving mid-download.
 *
 * canonicalJson + sha256Tagged above remain useful for content the CLIENT owns, such as
 * the legacy import artifact.
 */
