/**
 * Step 5 of the legacy import: the human-readable evidence that the import is faithful.
 *
 * The report never prints a scrubbed value — only where the scrub happened.
 */

import { FLAGS } from "../../packages/guide-schema/src/flags.ts";
import { isWildcard } from "../../packages/guide-schema/src/url-match.ts";

const FLAG_NOTES = {
  [FLAGS.AUTO_CLICK_UNANCHORED]:
    "Extension tự click, nhưng selector chỉ dựa vào vị trí trong DOM và không có text để xác nhận. Ưu tiên recapture.",
  [FLAGS.SEL_STRUCTURAL_AND_NO_TEXT]: "Selector thuần cấu trúc và không có text anchor.",
  [FLAGS.SEL_STRUCTURAL_ONLY]: "Selector không có id/class/attribute — chỉ dựa vị trí.",
  [FLAGS.SEL_NTH_OF_TYPE]: "Selector dùng :nth-of-type.",
  [FLAGS.SEL_KNOWN_DUPLICATE_ID]: "Dùng id đã đo được là trùng lặp trên production (#basic-button xuất hiện 9 lần).",
  [FLAGS.NO_TEXT_ANCHOR]: "Không có matchText dùng được.",
  [FLAGS.MATCH_TEXT_ZERO_WIDTH_ONLY]: "matchText cũ chỉ chứa ký tự zero-width — trông có nhưng không khớp được gì.",
  [FLAGS.PII_SCRUBBED]: "Đã xoá dữ liệu cá nhân khỏi URL.",
  [FLAGS.URL_UUID_STRIPPED]: "Đã gỡ UUID định danh bản ghi/cửa hàng khỏi URL.",
  [FLAGS.URL_STALE_QUERY_STRIPPED]: "Đã gỡ tham số môi trường cũ (ngày tuyệt đối, từ khoá tìm kiếm).",
  [FLAGS.URL_TOO_LONG]: "URL rất dài — UI phải truncate.",
  [FLAGS.URL_HARDCODED_UUID]: "URL vẫn còn ID cụ thể sau khi scrub.",
  [FLAGS.WAIT_URL_ON_LAST_STEP]: "Action chờ-URL nằm ở bước cuối.",
  [FLAGS.WAIT_URL_NO_TARGET]: "Action chờ-URL không suy ra được đích.",
  [FLAGS.START_URL_MISMATCH]: "startUrl khác urlPattern của bước 1.",
  [FLAGS.DUP_STEP_TITLE]: "Có tiêu đề bước trùng nhau trong cùng bộ.",
  [FLAGS.DUP_GUIDE_NAME]: "Tên bộ trùng với bộ khác.",
  [FLAGS.GUIDE_HAS_AUTO_CLICK_UNANCHORED]: "Bộ chứa ít nhất một bước AUTO_CLICK_UNANCHORED.",
  [FLAGS.UNMAPPED]: "Bước không có selector lẫn text.",
  [FLAGS.SEL_BROAD]: "Selector quá rộng.",
};

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|");

function countBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

export function buildReport({ source, guides, payloadChecksum, piiHits, generatedAt }) {
  const allSteps = guides.flatMap((g) => g.steps.map((s) => ({ guide: g, step: s })));
  const lines = [];
  const P = (s = "") => lines.push(s);

  P("# IMPORT REPORT — legacy v4 -> v5");
  P();
  P("Sinh bởi `scripts/import-legacy/cli.mjs`. Batch 1A, chưa ghi vào Supabase.");
  P();
  P("| | |");
  P("|---|---|");
  P(`| Thời điểm chạy | ${generatedAt} |`);
  P(`| File nguồn | \`${esc(source.filePath)}\` |`);
  P(`| Kích thước | ${source.bytes} bytes |`);
  P(`| SHA256 | \`${source.sha256}\` |`);
  P(`| exportedAt | ${esc(source.exportedAt)} |`);
  P(`| targetDomain gốc | ${esc(source.targetDomain)} |`);
  P(`| Checksum artifact | \`${payloadChecksum}\` |`);
  P();

  /* ---------------------------------------------------------------- totals */
  const outSteps = allSteps.length;
  P("## 1. Đối soát số lượng");
  P();
  P("| Hạng mục | Nguồn | Sau import | Khớp |");
  P("|---|---:|---:|:---:|");
  P(`| Guide | ${source.guides.length} | ${guides.length} | ${source.guides.length === guides.length ? "OK" : "SAI"} |`);
  P(`| Step | ${source.stepCount} | ${outSteps} | ${source.stepCount === outSteps ? "OK" : "SAI"} |`);
  P();
  const idSet = new Set(allSteps.map((x) => x.step.id));
  P(`Step id sinh ra là **deterministic** (\`sha256(legacyGuideId:index)\`), toàn bộ ${idSet.size} id duy nhất, nên chạy lại importer cho kết quả byte-for-byte giống nhau và \`admin_import_legacy\` idempotent.`);
  P();

  /* ---------------------------------------------------------------- PII */
  P("## 2. Dữ liệu cá nhân");
  P();
  if (piiHits.length === 0) {
    P("**PASS** — sau khi decode nhiều lớp, không còn chuỗi nào giống số điện thoại Việt Nam trong bất kỳ URL, matchText, tiêu đề hay nội dung nào.");
  } else {
    P("**FAIL** — vẫn còn dấu vết. Không được import.");
    P();
    P("| Guide | Bước | Trường |");
    P("|---|---:|---|");
    for (const h of piiHits) P(`| ${esc(h.guide)} | ${h.step} | ${h.field} |`);
  }
  P();
  const scrubbed = allSteps.filter(({ step }) => (step.flags || []).includes(FLAGS.PII_SCRUBBED));
  if (scrubbed.length) {
    P(`Số bước đã bị xoá PII: **${scrubbed.length}** (giá trị không được ghi ra ở bất kỳ đâu).`);
    P();
    P("| Guide | Bước |");
    P("|---|---:|");
    for (const { guide, step } of scrubbed) {
      P(`| ${esc(guide.name)} | ${guide.steps.indexOf(step) + 1} |`);
    }
    P();
  }

  /* ---------------------------------------------------------------- scrub */
  P("## 3. Kết quả làm sạch URL");
  P();
  P("| Loại | Số bước | Ý nghĩa |");
  P("|---|---:|---|");
  for (const flag of [FLAGS.PII_SCRUBBED, FLAGS.URL_UUID_STRIPPED, FLAGS.URL_STALE_QUERY_STRIPPED]) {
    const n = allSteps.filter(({ step }) => (step.flags || []).includes(flag)).length;
    P(`| \`${flag}\` | ${n} | ${FLAG_NOTES[flag] || ""} |`);
  }
  P();
  const stillDynamic = allSteps.filter(({ step }) => (step.flags || []).includes(FLAGS.URL_HARDCODED_UUID));
  if (stillDynamic.length) {
    P(`Còn **${stillDynamic.length}** bước có URL vẫn mang ID cụ thể sau khi scrub — cần triage xem lại.`);
    P();
  }

  /* ---------------------------------------------------------------- actions */
  P("## 4. Phân bố action");
  P();
  P("| Action | Số bước |");
  P("|---|---:|");
  for (const [type, n] of countBy(allSteps, ({ step }) => step.action.type)) P(`| \`${type}\` | ${n} |`);
  P();

  /* ---------------------------------------------------------------- flags */
  P("## 5. Flag toàn bộ corpus");
  P();
  P("Flag là thông tin tư vấn, **không chặn publish** (Plan v1.1 §P0-7). Chúng nuôi repair queue và cảnh báo lúc publish.");
  P();
  P("| Flag | Số bước | Ý nghĩa |");
  P("|---|---:|---|");
  const flagCounts = new Map();
  for (const { step } of allSteps) for (const f of step.flags || []) flagCounts.set(f, (flagCounts.get(f) || 0) + 1);
  for (const [flag, n] of [...flagCounts.entries()].sort((a, b) => b[1] - a[1])) {
    P(`| \`${flag}\` | ${n} | ${FLAG_NOTES[flag] || ""} |`);
  }
  P();
  const risky = allSteps.filter(({ step }) => (step.flags || []).includes(FLAGS.AUTO_CLICK_UNANCHORED));
  const riskyGuides = new Set(risky.map(({ guide }) => guide.name));
  P(`### Rủi ro cao nhất: \`AUTO_CLICK_UNANCHORED\``);
  P();
  P(`**${risky.length}** bước, nằm ở **${riskyGuides.size}/${guides.length}** bộ. Đây là danh sách ưu tiên của repair queue và là điều kiện Portal cảnh báo trước khi publish.`);
  P();

  /* ---------------------------------------------------------------- wildcard */
  const wildcardPatterns = new Map();
  for (const { step } of allSteps) {
    if (isWildcard(step.urlPattern)) {
      wildcardPatterns.set(step.urlPattern, (wildcardPatterns.get(step.urlPattern) || 0) + 1);
    }
  }
  P("## 6. Pattern wildcard cần đối chiếu khi neo đầu");
  P();
  P("Matcher v5 neo wildcard vào đầu path (v4 không neo). Đây là toàn bộ pattern bị ảnh hưởng — phải chứng minh bằng replay Batch 4 (Plan v1.1 R4).");
  P();
  P("| Pattern | Số bước |");
  P("|---|---:|");
  for (const [pat, n] of [...wildcardPatterns.entries()].sort((a, b) => b[1] - a[1])) P(`| \`${esc(pat)}\` | ${n} |`);
  P();

  /* ---------------------------------------------------------------- validation */
  const withErrors = guides.filter((g) => g.validation.errors.length);
  const warnCount = guides.reduce((n, g) => n + g.validation.warnings.length, 0);
  P("## 7. Validate");
  P();
  P(`- Bộ có lỗi: **${withErrors.length}/${guides.length}**`);
  P(`- Tổng cảnh báo: **${warnCount}**`);
  P();
  if (withErrors.length) {
    P("| Guide | Lỗi |");
    P("|---|---|");
    for (const g of withErrors) P(`| ${esc(g.name)} | ${g.validation.errors.map(esc).join("<br>")} |`);
    P();
  }

  /* ---------------------------------------------------------------- triage */
  P("## 8. Bảng triage — 48 bộ cần gán site thủ công");
  P();
  P("`siteCode` của **mọi** bộ đang là `null`, `status = unassigned`. Cột *Gợi ý* chỉ là tư vấn từ tiền tố route và **không được dùng làm acceptance criterion**; người duyệt quyết định từng bộ.");
  P();
  P("| # | Tên bộ | Bước | startUrl | Gợi ý | Độ tin | Flag |");
  P("|---:|---|---:|---|---|---|---|");
  guides.forEach((g, i) => {
    const flags = [...new Set(g.steps.flatMap((s) => s.flags || []).concat(g.flags || []))].sort();
    const short = flags
      .filter((f) => f !== FLAGS.SEL_NTH_OF_TYPE && f !== FLAGS.SEL_STRUCTURAL_ONLY && f !== FLAGS.NO_TEXT_ANCHOR)
      .map((f) => `\`${f}\``)
      .join(" ");
    P(
      `| ${i + 1} | ${esc(g.name)} | ${g.steps.length} | \`${esc(g.startUrl)}\` | ` +
        `${g.siteGuess || "—"} | ${g.siteEvidence.confidence} | ${short || "—"} |`,
    );
  });
  P();
  P("### Bằng chứng phân loại theo từng bộ");
  P();
  for (const g of guides) {
    const ev = g.siteEvidence;
    P(`- **${esc(g.name)}** — gợi ý \`${g.siteGuess || "không rõ"}\` (${ev.confidence}). ${esc(ev.reason)} ` +
      `POS ${ev.posScore} / Admin ${ev.adminScore} / trung tính ${ev.neutralScore}. ` +
      `Prefix: ${Object.entries(ev.prefixes).map(([k, v]) => `\`${k}\`×${v}`).join(", ")}`);
  }
  P();

  /* ---------------------------------------------------------------- acceptance */
  P("## 9. Acceptance Batch 1A");
  P();
  P("| Tiêu chí | Kết quả |");
  P("|---|---|");
  P(`| 48/48 guide | ${guides.length === source.guides.length ? "PASS" : "FAIL"} |`);
  P(`| 409/409 step | ${outSteps === source.stepCount ? "PASS" : "FAIL"} |`);
  P(`| Không còn PII sau decode nhiều lớp | ${piiHits.length === 0 ? "PASS" : "FAIL"} |`);
  P(`| Mọi guide ở trạng thái unassigned | ${guides.every((g) => g.status === "unassigned" && g.siteCode === null) ? "PASS" : "FAIL"} |`);
  P(`| Step id duy nhất và deterministic | ${idSet.size === outSteps ? "PASS" : "FAIL"} |`);
  P(`| Bộ có lỗi validate | ${withErrors.length === 0 ? "PASS (0)" : `${withErrors.length} bộ — xem mục 7`} |`);
  P();

  return lines.join("\n") + "\n";
}
