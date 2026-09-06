/**
 * Step 2 of the legacy import: make every URL reusable by another store, on another day.
 *
 * Three classes of contamination were measured in the source file:
 *   1. PII       - one real customer phone number, inside a percent-encoded JSON blob in
 *                  the `filter=` query param of two steps, in BOTH urlPattern and
 *                  navigationUrl. A raw-text regex over the URL misses it entirely: the
 *                  digits only become visible after decoding, hence decodeDeep().
 *   2. Record ids- 6 steps pin a specific UUID, including `?pos=<uuid>` which is a STORE
 *                  identifier. Left in place, every store would be sent to one POS.
 *   3. Stale env - 29 steps carry absolute dates and search keywords from the day the
 *                  guide was recorded.
 *
 * Removing a param is safe for matching because the matcher compares the path with a
 * boundary check and only compares params the pattern still names.
 *
 * This module never logs a scrubbed value.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Vietnamese mobile/landline shapes. */
const PHONE_RE = /(?:^|[^0-9])(0[1-9][0-9]{8,9}|84[0-9]{9})(?:[^0-9]|$)/;
const PHONE_KEY_RE = /phone|mobile|sdt|so_dien_thoai|tel/i;
const STALE_KEY_RE = /^(date_from|date_to|start_date|end_date|from_date|to_date|keyword|search|q)$|date|daterange/i;

export const SCRUB_FLAGS = {
  PII: "PII_SCRUBBED",
  UUID: "URL_UUID_STRIPPED",
  STALE: "URL_STALE_QUERY_STRIPPED",
};

/** Decode until the string stops changing. Tolerates malformed escapes. */
export function decodeDeep(value, maxPasses = 4) {
  const chain = [String(value ?? "")];
  let current = chain[0];
  for (let i = 0; i < maxPasses; i++) {
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    current = next;
    chain.push(current);
  }
  return chain;
}

/** True if any decoding of this string reveals a phone number. */
export function containsPhone(value) {
  return decodeDeep(value).some((v) => PHONE_RE.test(v));
}

function scrubJsonTree(node, flags) {
  if (Array.isArray(node)) return node.map((v) => scrubJsonTree(v, flags));
  if (!node || typeof node !== "object") return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object") {
      // Stale date ranges are stored as arrays of ISO timestamps.
      if (STALE_KEY_RE.test(key) && (Array.isArray(value) ? value.length : Object.keys(value).length)) {
        flags.add(SCRUB_FLAGS.STALE);
        out[key] = Array.isArray(value) ? [] : {};
        continue;
      }
      out[key] = scrubJsonTree(value, flags);
      continue;
    }

    if (typeof value === "string" && value !== "") {
      if (PHONE_KEY_RE.test(key) || PHONE_RE.test(value)) {
        flags.add(SCRUB_FLAGS.PII);
        out[key] = "";
        continue;
      }
      if (UUID_RE.test(value)) {
        flags.add(SCRUB_FLAGS.UUID);
        out[key] = "";
        continue;
      }
      if (STALE_KEY_RE.test(key)) {
        flags.add(SCRUB_FLAGS.STALE);
        out[key] = "";
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

/** True when a scrubbed JSON filter carries nothing worth keeping. */
function isVacuous(value) {
  if (value === null || value === "" || value === false) return true;
  if (Array.isArray(value)) return value.every(isVacuous);
  if (typeof value === "object") return Object.values(value).every(isVacuous);
  return false;
}

/**
 * Scrub one URL (path + query + hash). Returns the cleaned URL, the flags earned, and
 * whether the URL turned into a wildcard.
 *
 * A record id in the query is NOT simply deleted. `/sellback/create?id=<uuid>` without
 * its id is a broken page, so deleting the param would leave a navigationUrl that
 * cannot load. Instead the URL becomes `/sellback/create*`:
 *   - as a urlPattern it matches whatever id the user's own flow produced;
 *   - as a navigationUrl it is unusable by definition, so the caller clears it - those
 *     pages are only ever reached by clicking through the previous step.
 * All six affected legacy steps are reached from an auto_click_wait_url, so the wait
 * target (materialised from the next step's pattern) becomes the same wildcard.
 */
export function scrubUrl(url) {
  const flags = new Set();
  const original = String(url ?? "");
  if (!original) return { url: original, flags: [], dynamic: false };

  const hashIdx = original.indexOf("#");
  const hash = hashIdx >= 0 ? original.slice(hashIdx) : "";
  const noHash = hashIdx >= 0 ? original.slice(0, hashIdx) : original;
  const qIdx = noHash.indexOf("?");
  const path = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
  const query = qIdx >= 0 ? noHash.slice(qIdx + 1) : "";

  // A UUID in the path itself becomes a wildcard segment.
  if (UUID_ANYWHERE_RE.test(path)) {
    flags.add(SCRUB_FLAGS.UUID);
    return { url: path.replace(UUID_ANYWHERE_RE, "*") + hash, flags: [...flags], dynamic: true };
  }

  if (!query) return { url: original, flags: [], dynamic: false };

  // A record id anywhere in the query makes the URL specific to one record. Replace the
  // VALUE with a wildcard and keep the parameter NAME: `/sellback/create*` would also
  // match `/sellback/create` (the broken id-less page) and `/sellback/create-copy`,
  // whereas `/sellback/create?id=*` matches only a page that actually carries an id.
  if ([...new URLSearchParams(query)].some(([, v]) => UUID_ANYWHERE_RE.test(String(v ?? "")))) {
    flags.add(SCRUB_FLAGS.UUID);
    const parts = [];
    for (const [key, rawValue] of new URLSearchParams(query)) {
      const value = String(rawValue ?? "");
      if (value === "") continue;
      if (STALE_KEY_RE.test(key)) {
        flags.add(SCRUB_FLAGS.STALE);
        continue;
      }
      if (UUID_ANYWHERE_RE.test(value)) {
        parts.push(encodeURIComponent(key) + "=*");
        continue;
      }
      if (PHONE_KEY_RE.test(key) || containsPhone(value)) {
        flags.add(SCRUB_FLAGS.PII);
        continue;
      }
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
    }
    return { url: path + "?" + parts.join("&") + hash, flags: [...flags], dynamic: true };
  }

  const kept = [];
  for (const [key, rawValue] of new URLSearchParams(query)) {
    const value = String(rawValue ?? "");
    if (value === "") continue; // empty params carry no meaning and never gate a match

    if (STALE_KEY_RE.test(key)) {
      flags.add(SCRUB_FLAGS.STALE);
      continue;
    }
    if (PHONE_KEY_RE.test(key) || containsPhone(value)) {
      // Try to keep the surrounding structure when the value is a JSON blob.
      const parsed = tryParseJsonDeep(value);
      if (parsed.ok) {
        const cleaned = scrubJsonTree(parsed.value, flags);
        if (isVacuous(cleaned)) continue;
        kept.push([key, JSON.stringify(cleaned)]);
        continue;
      }
      flags.add(SCRUB_FLAGS.PII);
      continue;
    }

    const parsed = tryParseJsonDeep(value);
    if (parsed.ok) {
      const cleaned = scrubJsonTree(parsed.value, flags);
      if (isVacuous(cleaned)) continue;
      kept.push([key, JSON.stringify(cleaned)]);
      continue;
    }

    kept.push([key, value]);
  }

  const params = new URLSearchParams();
  for (const [k, v] of kept) params.append(k, v);
  const qs = params.toString();
  return { url: path + (qs ? "?" + qs : "") + hash, flags: [...flags], dynamic: false };
}

function tryParseJsonDeep(value) {
  for (const candidate of decodeDeep(value)) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch {
      /* keep trying the next decoding */
    }
  }
  return { ok: false, value: null };
}

/**
 * Scrub both URL fields of a v4 step. Never mutates the input.
 *
 * When either field turned into a wildcard, navigationUrl is cleared: a wildcard
 * describes a family of pages, so there is no single URL to navigate to. The runtime
 * already treats an empty navigationUrl as "this page is reached by clicking through",
 * which is exactly true of these steps.
 */
export function scrubStepUrls(step) {
  const pattern = scrubUrl(step.urlPattern);
  const navigation = scrubUrl(step.navigationUrl);
  const dynamic = pattern.dynamic || navigation.dynamic;

  return {
    urlPattern: pattern.url,
    navigationUrl: dynamic ? "" : navigation.url,
    dynamic,
    flags: [...new Set([...pattern.flags, ...navigation.flags])],
    changed:
      pattern.url !== String(step.urlPattern || "") ||
      (dynamic ? "" : navigation.url) !== String(step.navigationUrl || ""),
  };
}

/**
 * Final gate: refuse to emit anything that still looks like a phone number after any
 * amount of decoding. Returns a list of {guide, step, field} locations, values REDACTED.
 */
export function assertNoPii(guides) {
  const hits = [];
  guides.forEach((guide) => {
    (guide.steps || []).forEach((step, i) => {
      for (const field of ["urlPattern", "navigationUrl", "matchText", "title", "content"]) {
        if (containsPhone(step[field])) hits.push({ guide: guide.name, step: i + 1, field });
      }
    });
  });
  return hits;
}
