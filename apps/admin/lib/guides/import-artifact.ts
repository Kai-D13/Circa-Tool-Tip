import { SCHEMA_VERSION, canonicalJson, sha256Tagged } from "@circa/guide-schema";

/**
 * Validation of the legacy import artifact (data/legacy-import.v5.json) BEFORE it is
 * sent to admin_import_legacy.
 *
 * The checksum is RECOMPUTED here from the file's content, not read from the file: a
 * file whose guides were edited but whose embedded contentChecksum was left alone must
 * be caught on the client, and the recomputed value is what gets passed as p_checksum.
 *
 * Pure (no Next.js imports) so it is unit-testable with `node --test`.
 */

export const ARTIFACT_TYPE = "circa-tooltip-legacy-import";

/** The one-off migration is exactly this big. Anything else is the wrong file. */
export const EXPECTED_LEGACY = { guides: 48, steps: 409 };

export interface ArtifactSummary {
  filename: string;
  type: string;
  schemaVersion: number;
  guides: number;
  steps: number;
  sourceFileSha256: string;
  embeddedChecksum: string;
  computedChecksum: string;
}

export interface ArtifactCheck {
  ok: boolean;
  errors: string[];
  summary: ArtifactSummary | null;
  /** The parsed artifact, exactly as it will be sent to the RPC. */
  payload: Record<string, unknown> | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function checkArtifact(
  text: string,
  filename: string,
  expected: { guides: number; steps: number } = EXPECTED_LEGACY,
): Promise<ArtifactCheck> {
  const errors: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["File không phải JSON hợp lệ."], summary: null, payload: null };
  }
  if (!isRecord(parsed)) {
    return { ok: false, errors: ["Nội dung file không phải object JSON."], summary: null, payload: null };
  }

  const type = String(parsed._type ?? "");
  if (type !== ARTIFACT_TYPE) errors.push(`_type là "${type}", cần "${ARTIFACT_TYPE}".`);

  const schemaVersion = Number(parsed.schemaVersion);
  if (schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion là ${parsed.schemaVersion}, cần ${SCHEMA_VERSION}.`);

  const guides = Array.isArray(parsed.guides) ? (parsed.guides as unknown[]) : null;
  if (!guides) errors.push("Thiếu mảng guides.");

  const guideCount = guides ? guides.length : 0;
  const stepCount = guides
    ? guides.reduce<number>((n, g) => n + (isRecord(g) && Array.isArray(g.steps) ? g.steps.length : 0), 0)
    : 0;

  const stats = isRecord(parsed.stats) ? parsed.stats : {};
  if (Number(stats.guides) !== guideCount || Number(stats.steps) !== stepCount) {
    errors.push(`stats khai ${stats.guides ?? "?"}/${stats.steps ?? "?"} nhưng đếm được ${guideCount}/${stepCount}.`);
  }
  if (guideCount !== expected.guides || stepCount !== expected.steps) {
    errors.push(`File có ${guideCount} guide / ${stepCount} step, migration này cần đúng ${expected.guides}/${expected.steps}.`);
  }

  const embeddedChecksum = String(parsed.contentChecksum ?? "");
  if (!/^sha256:[0-9a-f]{64}$/.test(embeddedChecksum)) errors.push("contentChecksum thiếu hoặc sai định dạng.");

  // Recompute over everything except the checksum field itself — same rule as the CLI.
  const { contentChecksum: _ignored, ...content } = parsed;
  const computedChecksum = await sha256Tagged(canonicalJson(content));
  if (embeddedChecksum && computedChecksum !== embeddedChecksum) {
    errors.push("Checksum tính lại KHÁC checksum trong file — nội dung đã bị sửa sau khi importer sinh ra.");
  }

  const source = isRecord(parsed.source) ? parsed.source : {};

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      filename,
      type,
      schemaVersion,
      guides: guideCount,
      steps: stepCount,
      sourceFileSha256: String(source.sourceFileSha256 ?? ""),
      embeddedChecksum,
      computedChecksum,
    },
    payload: parsed,
  };
}
