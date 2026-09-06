/**
 * Step 3 of the legacy import: guess which site a guide belongs to — and never act on
 * the guess.
 *
 * Every legacy URL is a relative path, so POS and Admin are genuinely indistinguishable
 * from the data alone. `startUrl` is a weak signal too: 33 of 48 guides start at
 * /tai-khoan, which is an entry hop rather than a business destination.
 *
 * So this module emits `siteGuess` + `siteEvidence` and leaves `siteCode = null`,
 * `status = "unassigned"`. A human assigns the site in the triage screen; the database
 * CHECK constraint refuses to let an unassigned guide reach a release.
 *
 * The lexicons below only contain routes that belong unambiguously to one app. Routes
 * observed under BOTH entry points are listed as neutral and cast no vote.
 */

export const POS_PREFIXES = [
  "trang-chu",
  "ban-hang",
  "ban-hang-online",
  "ban-hang-offline",
  "tra-hang",
  "tra-hang-nhap",
  "doi-soat-doanh-thu",
  "chuyen-hang",
  "danh-sach-phieu-nhan-hang",
];

export const ADMIN_PREFIXES = [
  "tai-khoan",
  "don-hang",
  "tra-hang-ban",
  "circa",
  "quan-ly-san-pham-pos",
  "quan-ly-combo",
  "quan-ly-bang-gia",
  "quan-ly-deal",
  "quan-ly-voucher",
  "quan-ly-nha-cung-cap",
  "quan-ly-cua-hang",
  "dieu-chinh-ton-kho",
  "dieu-chinh-gia-von",
  "kiem-ke-ton-kho",
  "luan-chuyen-ton",
  "phieu-nhan-hang",
  "yeu-cau-mua-hang",
  "phieu-mua-hang",
  "combo-da-dang-ban",
  "danh-sach-lieu-thuoc",
  "danh-sach-vat",
  "hoa-don-ban-hang",
  "thanh-toan-chuyen-khoan",
  "dashboard-tong-hop",
];

/** Seen under both POS and Admin entry points in the corpus — no vote. */
export const NEUTRAL_PREFIXES = ["dashboard", "danh-sach-ton-kho", "in-tem-gia-hang-loat", "sellback"];

function firstSegment(url) {
  const path = String(url || "").split("?")[0].split("#")[0];
  const seg = path.replace(/^\/+/, "").split("/")[0];
  return seg.toLowerCase();
}

/**
 * @param {{name:string,startUrl:string,steps:Array<{urlPattern:string,navigationUrl:string}>}} guide
 */
export function classifyGuide(guide) {
  const prefixes = new Map();
  const bump = (url) => {
    const seg = firstSegment(url);
    if (!seg) return;
    prefixes.set(seg, (prefixes.get(seg) || 0) + 1);
  };

  bump(guide.startUrl);
  for (const step of guide.steps || []) {
    bump(step.urlPattern);
    bump(step.navigationUrl);
  }

  let posScore = 0;
  let adminScore = 0;
  let neutral = 0;
  for (const [seg, count] of prefixes) {
    if (POS_PREFIXES.includes(seg)) posScore += count;
    else if (ADMIN_PREFIXES.includes(seg)) adminScore += count;
    else if (NEUTRAL_PREFIXES.includes(seg)) neutral += count;
  }

  const entry = firstSegment(guide.startUrl);
  const entryVote = POS_PREFIXES.includes(entry) ? "pos" : ADMIN_PREFIXES.includes(entry) ? "admin" : null;

  let guess = null;
  let confidence = "none";
  let reason = "";

  const total = posScore + adminScore;
  if (total === 0) {
    reason = "Không có prefix nào thuộc từ điển POS/Admin — toàn route trung tính.";
  } else if (posScore > 0 && adminScore > 0) {
    // Mixed evidence is exactly the cross-origin case the schema now supports.
    const ratio = Math.max(posScore, adminScore) / Math.min(posScore, adminScore);
    guess = posScore > adminScore ? "pos" : "admin";
    confidence = ratio >= 3 ? "medium" : "low";
    reason = `Có cả prefix POS (${posScore}) lẫn Admin (${adminScore}) — có thể là guide chạy xuyên hai site.`;
  } else {
    guess = posScore > 0 ? "pos" : "admin";
    confidence = entryVote === guess ? "high" : "medium";
    reason = entryVote === guess
      ? "Toàn bộ prefix nghiệp vụ và cả URL bắt đầu đều thuộc một site."
      : "Toàn bộ prefix nghiệp vụ thuộc một site, nhưng URL bắt đầu là route trung tính.";
  }

  if (neutral && confidence === "high" && total < neutral) {
    confidence = "medium";
    reason += " Phần lớn route là trung tính nên bằng chứng yếu.";
  }

  return {
    siteGuess: guess,
    siteEvidence: {
      entrySegment: entry,
      entryVote,
      posScore,
      adminScore,
      neutralScore: neutral,
      confidence,
      reason,
      prefixes: Object.fromEntries([...prefixes.entries()].sort((a, b) => b[1] - a[1])),
    },
  };
}
