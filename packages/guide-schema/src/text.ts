/**
 * Text normalisation shared by the importer, the portal and the extension.
 *
 * Why zero-width stripping matters: 66 legacy steps carry U+200B inside matchText and
 * 38 of them are ONLY zero-width/whitespace. A naive `if (step.matchText)` treats those
 * as text-anchored when they can never match textContent. Effective text anchors in the
 * legacy corpus are ~280, not the naive 318.
 *
 * The character classes below are built from code points rather than written as literal
 * characters: the characters in question are invisible, so a literal class is unreadable
 * in review and silently corruptible by any editor or encoding round-trip.
 */

function charClass(ranges: Array<[number, number]>): string {
  const esc = (cp: number) => "\\u" + cp.toString(16).padStart(4, "0");
  return "[" + ranges.map(([lo, hi]) => (lo === hi ? esc(lo) : esc(lo) + "-" + esc(hi))).join("") + "]";
}

/**
 * Zero-width and invisible formatting characters:
 * U+00AD soft hyphen · U+200B..U+200F ZWSP/ZWNJ/ZWJ + LTR/RTL marks ·
 * U+2028/U+2029 line & paragraph separators · U+2060 word joiner ·
 * U+2066..U+2069 bidi isolates · U+FEFF BOM.
 */
const ZERO_WIDTH_RE = new RegExp(
  charClass([
    [0x00ad, 0x00ad],
    [0x200b, 0x200f],
    [0x2028, 0x2029],
    [0x2060, 0x2060],
    [0x2066, 0x2069],
    [0xfeff, 0xfeff],
  ]),
  "g",
);

/** Combining diacritical marks left over after NFD normalisation (U+0300..U+036F). */
const COMBINING_RE = new RegExp(charClass([[0x0300, 0x036f]]), "g");

/** U+0110 / U+0111 — d with stroke. NFD does not decompose it into d + mark. */
const D_STROKE_UPPER = String.fromCharCode(0x0110);
const D_STROKE_LOWER = String.fromCharCode(0x0111);

export function stripZeroWidth(input: string): string {
  return String(input || "").replace(ZERO_WIDTH_RE, "");
}

export function collapseWhitespace(input: string): string {
  return String(input || "").replace(/\s+/g, " ").trim();
}

/**
 * Canonical form for comparing visible text (element textContent vs step.matchText).
 * Ported from content.js:330 `normText`, plus the zero-width strip it was missing.
 */
export function normalizeText(input: string): string {
  return collapseWhitespace(stripZeroWidth(input));
}

/**
 * Diacritic-free lowercase form, for locating UI landmarks by their visible label.
 * Used by the POS header adapter ("Cai Dat", "Ho Tro", "Bao Cao") and the Admin
 * sidebar adapter ("POS Tools").
 */
export function normalizeSearchText(input: string): string {
  const deStroked = normalizeText(input)
    .split(D_STROKE_UPPER)
    .join("D")
    .split(D_STROKE_LOWER)
    .join("d");
  return deStroked.normalize("NFD").replace(COMBINING_RE, "").toLowerCase();
}

/**
 * True when the string carries no usable text anchor: empty, or nothing left once
 * zero-width characters and whitespace are removed.
 */
export function isBlankAnchor(input: string | undefined | null): boolean {
  return normalizeText(String(input || "")) === "";
}
