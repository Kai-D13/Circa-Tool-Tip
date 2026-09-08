import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPROVE_BUTTON_LABEL,
  ARCHIVE_BUTTON_LABEL,
  GUIDE_STATUS_LABEL,
  RELEASE_HEAD_LABEL,
  TO_DRAFT_BUTTON_LABEL,
  needsStatusConfirmation,
  releaseHeadChipClass,
  statusChipClass,
  statusLabel,
} from "../lib/guides/status.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const SKIP = new Set(["node_modules", ".next", "tests", "dist"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

const FILES = walk(APP);
const rel = (f) => relative(APP, f).split(sep).join("/");

/* ------------------------------------------------------------------- wording */

test("nhãn trạng thái đúng từng chữ stakeholder đã chốt", () => {
  assert.deepEqual(GUIDE_STATUS_LABEL, {
    unassigned: "Chưa phân loại",
    draft: "Bản nháp",
    published: "Đã duyệt cho lần phát hành tiếp theo",
    archived: "Đã lưu trữ",
  });
  // KHÔNG phải "đang chạy trên extension": release_heads chỉ chứng minh bản nào là hiện
  // hành trên Supabase, không chứng minh 25 máy POS đã kéo về.
  assert.equal(RELEASE_HEAD_LABEL, "Bản phát hành hiện hành");
  assert.equal(APPROVE_BUTTON_LABEL, "Duyệt cho lần phát hành tiếp theo");
});

test("mỗi giá trị status trong database đều có nhãn, không thiếu cái nào", () => {
  assert.deepEqual(Object.keys(GUIDE_STATUS_LABEL).sort(), ["archived", "draft", "published", "unassigned"]);
});

test("status lạ từ server hiện nguyên mã chứ không thành ô trống", () => {
  assert.equal(statusLabel("draft"), "Bản nháp");
  assert.equal(statusLabel("khong_biet"), "khong_biet");
});

/**
 * The one rule that makes the relabelling stick.
 *
 * Case-sensitive on purpose: prose like "Mọi bộ được nhập ở trạng thái chưa phân loại"
 * in import-panel.tsx is a sentence, not a label, and must stay legal.
 */
test("mỗi chuỗi nhãn chỉ được định nghĩa ở đúng lib/guides/status.ts", () => {
  const labels = [
    ...Object.values(GUIDE_STATUS_LABEL),
    RELEASE_HEAD_LABEL,
    APPROVE_BUTTON_LABEL,
    TO_DRAFT_BUTTON_LABEL,
    ARCHIVE_BUTTON_LABEL,
  ];
  for (const label of labels) {
    const found = FILES.filter((f) => readFileSync(f, "utf8").includes(label)).map(rel);
    assert.deepEqual(found, ["lib/guides/status.ts"], `"${label}" bị viết lặp ở nơi khác`);
  }
});

test("không còn chỗ nào in thẳng giá trị enum tiếng Anh ra chip", () => {
  // `<span className={...}>{status}</span>` là đúng cái đã làm /guides hiện chữ
  // "published" màu xanh lá suốt hai batch.
  for (const file of FILES) {
    const src = readFileSync(file, "utf8");
    assert.ok(!/>\{status\}</.test(src), `${rel(file)} vẫn render thẳng giá trị status`);
  }
});

/* --------------------------------------------------------------------- chips */

test("xanh lá chỉ dành cho bản phát hành hiện hành", () => {
  // Trước batch này `published` màu xanh trong khi chưa có release nào tồn tại — không
  // guide nào đang chạy ở đâu cả. Đó chính là hiểu nhầm cần xoá.
  assert.equal(releaseHeadChipClass(), "chip chip-success");
  for (const status of Object.keys(GUIDE_STATUS_LABEL)) {
    assert.ok(!statusChipClass(status).includes("chip-success"), `${status} không được màu xanh lá`);
  }
  assert.equal(statusChipClass("published"), "chip chip-warning", "đã duyệt là đang chờ, không phải đang chạy");
});

/* ------------------------------------------------------- xác nhận auto-click */

test("chỉ hỏi lại khi duyệt một bộ có bước tự bấm không neo được text", () => {
  const flagged = { flags: ["GUIDE_HAS_AUTO_CLICK_UNANCHORED"] };
  assert.equal(needsStatusConfirmation("published", flagged), true);
});

test("không hỏi lại khi bộ không có cờ auto-click", () => {
  assert.equal(needsStatusConfirmation("published", {}), false);
  assert.equal(needsStatusConfirmation("published", null), false);
  assert.equal(needsStatusConfirmation("published", undefined), false);
  assert.equal(
    needsStatusConfirmation("published", { warnings: ["Bước 1: thiếu tiêu đề"] }),
    false,
    "cảnh báo thường không được bật hộp thoại — bộ nào vừa ghi cũng có, hỏi mãi thì không ai đọc",
  );
});

test("lưu trữ hay trả về bản nháp thì không hỏi, kể cả bộ có cờ", () => {
  const flagged = { flags: ["GUIDE_HAS_AUTO_CLICK_UNANCHORED"] };
  assert.equal(needsStatusConfirmation("archived", flagged), false);
  assert.equal(needsStatusConfirmation("draft", flagged), false);
  assert.equal(needsStatusConfirmation("unassigned", flagged), false);
});

test("tên cờ lấy từ package schema, không phải chuỗi chép tay", () => {
  const src = readFileSync(resolve(APP, "lib/guides/status.ts"), "utf8");
  assert.match(src, /FLAGS\.GUIDE_HAS_AUTO_CLICK_UNANCHORED/);
  assert.ok(
    !/"GUIDE_HAS_AUTO_CLICK_UNANCHORED"|'GUIDE_HAS_AUTO_CLICK_UNANCHORED'/.test(src),
    "cờ được tính ở packages/guide-schema — bản sao chuỗi ở đây sẽ trôi",
  );
});
