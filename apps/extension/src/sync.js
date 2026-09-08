/**
 * Keeping the extension's copy of the releases up to date.
 *
 * The rule this module exists to enforce: **a failed sync never costs the operator the
 * release they already have.** A POS machine with a stale-but-working guide set is doing
 * its job; a POS machine that threw its cache away because the network blinked is not.
 * So the cache is only ever written, never cleared, and it is written only after every
 * check has passed.
 *
 * Cache lives in `chrome.storage.local`, not `session`: session storage is wiped when the
 * browser closes and on every extension update, which would mean a cold start with no
 * guides on 25 machines at once. A running tour still keeps its own state in session —
 * that is a different lifetime, and pinning it there is what stops a mid-tour release
 * swap from moving the ground under the person following it.
 *
 * Pure apart from the injected `storage`, `api` and `schema`, so the whole pipeline is
 * unit-testable without Chrome and without a network.
 */

/**
 * The sites this build serves. A closed set: the manifest hardcodes exactly these two
 * origins, and a site the content script does not run on has nothing to sync for.
 */
export const SITES = ["pos", "admin"];

export const RELEASE_KEY = (site) => `release:${site}`;
export const STATUS_KEY = (site) => `releaseStatus:${site}`;

export const SYNC_STATE = {
  /** A validated release is cached and current. */
  OK: "ok",
  /** The site has never published. Not an error — there is simply nothing to serve. */
  NO_RELEASE: "no-release",
  /** Something went wrong. Whatever was cached before is still cached and still served. */
  ERROR: "error",
};

/**
 * Everything that must be true before a downloaded payload may replace the cached one.
 *
 * Pure and exported: these are the checks that decide whether ~25 machines get new
 * content, and each one earns its place.
 */
export function checkPayload(payload, site, head, schema) {
  const problems = [];

  // Revision and checksum are compared against the head we JUST read. A republish between
  // the probe and the download would otherwise be cached under the wrong revision, and
  // the next sync would see "revision unchanged" and never correct it.
  if (payload?.revision !== head.revision) {
    problems.push(`revision ${String(payload?.revision)} không khớp head ${head.revision} — có bản phát hành xen vào giữa.`);
  }
  if (String(payload?.checksum || "") !== String(head.checksum || "")) {
    problems.push("checksum không khớp release_heads.");
  }

  // The schema validator covers schemaVersion, the site, and every guide and step. It is
  // the same function the Portal and the importer use — there is no second definition of
  // what a valid release is.
  const result = schema.validateReleasePayload(payload, site);
  for (const err of result.errors) problems.push(err);

  return problems;
}

/**
 * @param {object} deps
 * @param {{get(keys): Promise<object>, set(items): Promise<void>}} deps.storage  chrome.storage.local
 * @param {{heads(): Promise<object[]>, release(site: string): Promise<object>}} deps.api
 * @param {{validateReleasePayload(payload: unknown, site?: string): {errors: string[]}}} deps.schema
 */
export function createSync({ storage, api, schema, sites = SITES, now = () => new Date().toISOString() }) {
  /**
   * The one pipeline.
   *
   * Four things trigger a sync — install, startup, the 15-minute alarm, and the Đồng bộ
   * button — and on a browser that has just woken up they can all fire at once. Running
   * them concurrently would download the same payload several times and let two writers
   * race on the same cache key, so a sync already in progress is simply shared.
   */
  let inFlight = null;

  async function readStatus(site) {
    const key = STATUS_KEY(site);
    const bag = await storage.get(key);
    return bag?.[key] ?? null;
  }

  async function readCache(site) {
    const key = RELEASE_KEY(site);
    const bag = await storage.get(key);
    return bag?.[key] ?? null;
  }

  async function writeStatus(site, status) {
    await storage.set({ [STATUS_KEY(site)]: { site, syncedAt: now(), ...status } });
  }

  /** Record a failure WITHOUT touching the cached release. */
  async function fail(site, message) {
    // Described from the CACHE, not from the previous status: the cache is what is
    // actually being served, and it is the thing the operator needs the number of. A
    // machine that has a release but has never written a status would otherwise be
    // reported as holding nothing.
    const cached = await readCache(site);
    await writeStatus(site, {
      state: SYNC_STATE.ERROR,
      message,
      revision: Number(cached?.revision ?? 0),
      checksum: cached?.checksum ?? null,
      releasedAt: cached?.releasedAt ?? null,
    });
    return { site, action: "error", message };
  }

  async function syncSite(site, head) {
    if (!head) {
      // Nothing has ever been published for this site. `revision: 0` is the convention
      // get_release uses for that, and it must never reach the validator — the validator
      // is right to reject it, and calling that an error would report a healthy new
      // install as broken.
      await writeStatus(site, { state: SYNC_STATE.NO_RELEASE, revision: 0, checksum: null, releasedAt: null });
      return { site, action: "no-release" };
    }

    const cached = await readCache(site);
    const cachedRevision = Number(cached?.revision ?? 0);
    const cachedChecksum = String(cached?.checksum ?? "");
    const headChecksum = String(head.checksum ?? "");

    // Both, not just the revision. The revision says WHICH release; the checksum says
    // what is actually in it. If they disagree the cache is holding something that is
    // not what the head describes — and skipping the download on the strength of the
    // number alone would make that permanent, because every later sync would reach this
    // same branch and report "unchanged" forever.
    if (cached && cachedRevision === head.revision && cachedChecksum === headChecksum) {
      await writeStatus(site, {
        state: SYNC_STATE.OK,
        revision: cachedRevision,
        checksum: cached.checksum ?? null,
        releasedAt: cached.releasedAt ?? null,
      });
      return { site, action: "unchanged", revision: cachedRevision };
    }

    if (cached && cachedRevision > head.revision) {
      // Revisions only ever go up — a rollback publishes the old content under a HIGHER
      // number precisely so this can be treated as an error rather than a downgrade.
      // Seeing a lower head means something is wrong upstream; keep what works.
      return fail(site, `Head revision ${head.revision} thấp hơn bản đang có (${cachedRevision}) — giữ bản cũ.`);
    }

    // Downloaded when there is no cache, when the head moved forward, or when the
    // revision matches but the content does not. The checks below decide whether what
    // comes back is allowed to replace what is already there.
    let payload;
    try {
      payload = await api.release(site);
    } catch (err) {
      return fail(site, `Không tải được bản phát hành: ${err?.message ?? err}`);
    }

    const problems = checkPayload(payload, site, head, schema);
    if (problems.length) {
      return fail(site, `Bản phát hành không hợp lệ, giữ bản cũ. ${problems.join(" ")}`);
    }

    // Only here. Both keys in ONE write so a reader can never see a new status pointing
    // at an old payload.
    await storage.set({
      [RELEASE_KEY(site)]: payload,
      [STATUS_KEY(site)]: {
        site,
        syncedAt: now(),
        state: SYNC_STATE.OK,
        revision: payload.revision,
        checksum: payload.checksum,
        releasedAt: payload.releasedAt,
      },
    });
    return { site, action: "updated", revision: payload.revision };
  }

  async function run() {
    let heads;
    try {
      heads = await api.heads();
    } catch (err) {
      // One probe covers both sites, so one network failure fails both — and neither
      // loses its cache.
      const message = `Không đọc được release_heads: ${err?.message ?? err}`;
      return { ok: false, sites: await Promise.all(sites.map((site) => fail(site, message))) };
    }

    const byCode = new Map(heads.map((h) => [h.site_code, h]));
    const results = [];
    // Sequential and independent: POS failing must not stop Admin from updating, and
    // interleaving writes to the same storage area buys nothing here.
    for (const site of sites) {
      results.push(await syncSite(site, byCode.get(site) ?? null));
    }
    return { ok: results.every((r) => r.action !== "error"), sites: results };
  }

  return {
    readCache,
    readStatus,

    /** Every trigger goes through here, and concurrent triggers share one run. */
    syncAll() {
      if (inFlight) return inFlight;
      inFlight = run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    /** For the Portal and the Tool-tip panel: what does this machine actually hold? */
    async status() {
      const out = {};
      for (const site of sites) {
        out[site] = (await readStatus(site)) ?? { site, state: SYNC_STATE.NO_RELEASE, revision: 0 };
      }
      return out;
    },
  };
}
