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

/**
 * Release checksum covers ONLY the content that must not change silently: the groups
 * and the guides. `revision`, `releasedAt` and `checksum` itself are excluded so the
 * same content republished is recognisably the same content.
 */
export async function releaseChecksum(payload: {
  schemaVersion: number;
  site: string;
  sites: Record<string, string>;
  groups: unknown[];
  guides: unknown[];
}): Promise<string> {
  return sha256Tagged(
    canonicalJson({
      schemaVersion: payload.schemaVersion,
      site: payload.site,
      sites: payload.sites,
      groups: payload.groups,
      guides: payload.guides,
    }),
  );
}
