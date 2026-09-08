import { FLAGS } from "@circa/guide-schema";

import type { GuideStatus, GuideValidation } from "./types";

/**
 * How a guide's state is worded in the UI. ONE definition — every component that shows a
 * status reads it from here, and a test asserts each string appears in no other file.
 *
 * The database values are not the words a person should read. `published` in particular
 * was rendered raw, in green, on /guides — while no release existed at all, so it was
 * not queued behind anything either. It means "queued for the next release", which is a
 * completely different thing from "already released", and the two were indistinguishable.
 *
 * "Bản phát hành hiện hành" is NOT a `guides.status` value. It is a property of
 * `release_heads` — the single source of truth for which revision is current on Supabase
 * (Plan v1.1 §P0-4) — so it lives here as a separate constant and never appears in a
 * Record keyed by GuideStatus.
 */

export const GUIDE_STATUS_LABEL: Record<GuideStatus, string> = {
  unassigned: "Chưa phân loại",
  draft: "Bản nháp",
  published: "Đã duyệt cho lần phát hành tiếp theo",
  archived: "Đã lưu trữ",
};

/**
 * The release head, not a guide status.
 *
 * Worded as "hiện hành", not "đang chạy trên extension": `release_heads` proves what
 * Supabase considers current, and nothing more. Whether all ~25 POS machines have
 * actually pulled it is a different fact, and this project deliberately does not track
 * devices. Batch 3 can show the revision an individual browser holds, in the Tool-tip
 * menu on that machine — that is the only place the claim would be true.
 */
export const RELEASE_HEAD_LABEL = "Bản phát hành hiện hành";

export const APPROVE_BUTTON_LABEL = "Duyệt cho lần phát hành tiếp theo";
export const TO_DRAFT_BUTTON_LABEL = "Chuyển về bản nháp";
export const ARCHIVE_BUTTON_LABEL = "Lưu trữ";

/** Never blank: an unknown code from the server is shown as-is rather than swallowed. */
export function statusLabel(status: string): string {
  return GUIDE_STATUS_LABEL[status as GuideStatus] ?? status;
}

/**
 * Green means one thing only: this revision is the current release.
 *
 * `published` was green before this batch, which is exactly the confusion being removed —
 * an approved guide is waiting to be released, not released. It is amber now, and the
 * head chip on /releases takes the green.
 *
 * Note what green still does NOT claim: that any POS machine has pulled it. Supabase is
 * the only thing `release_heads` speaks for.
 */
export function statusChipClass(status: string): string {
  if (status === "published") return "chip chip-warning";
  return "chip chip-none";
}

export function releaseHeadChipClass(): string {
  return "chip chip-success";
}

/**
 * Whether approving this guide should stop for a human confirmation first.
 *
 * Only on the way to `published`, and only for the auto-click flag. Confirming on
 * "Lưu trữ" would be noise, and confirming on any warning at all would fire on nearly
 * every recorded guide (a freshly recorded step has no title yet) — a dialog that always
 * appears is a dialog nobody reads.
 *
 * The flag itself is imported from the schema package rather than spelled out here: it is
 * computed there, and a second copy of the string would drift.
 */
export function needsStatusConfirmation(target: GuideStatus, validation: GuideValidation | null | undefined): boolean {
  if (target !== "published") return false;
  return (validation?.flags ?? []).includes(FLAGS.GUIDE_HAS_AUTO_CLICK_UNANCHORED);
}
