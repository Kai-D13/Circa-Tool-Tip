/**
 * Recorder state, kept in `chrome.storage.session`.
 *
 * Why not a variable in the service worker: MV3 evicts the worker whenever it is idle,
 * and a recording session outlives that easily — the operator is over on the POS tab
 * clicking around. State in memory would vanish mid-recording with no warning. Session
 * storage survives worker restarts and is cleared when the browser closes, which is
 * exactly the lifetime a recording should have.
 *
 * The storage adapter is injected so this module is unit-testable without Chrome.
 */

export const RECORDER_PREFIX = "tg:recorder:";

export function recorderKey(sessionId) {
  return RECORDER_PREFIX + sessionId;
}

/**
 * @param {{get(keys):Promise<object>, set(items):Promise<void>, remove(keys):Promise<void>}} storage
 */
export function createRecorderStore(storage) {
  async function read(sessionId) {
    const key = recorderKey(sessionId);
    const bag = await storage.get(key);
    return bag?.[key] ?? null;
  }

  async function write(session) {
    await storage.set({ [recorderKey(session.id)]: session });
    return session;
  }

  return {
    /** Begin a session. Overwrites any earlier session with the same id. */
    async start({ id, guideId, site, startUrl, tabId = null, mode = "append", stepId = null }) {
      if (!id) throw new Error("start: thiếu id phiên ghi");
      if (!guideId) throw new Error("start: thiếu guideId");
      if (!site) throw new Error("start: thiếu site");
      return write({
        v: 1,
        id,
        guideId,
        site,
        startUrl: startUrl ?? "",
        tabId,
        mode,
        stepId,
        status: "recording",
        steps: [],
        startedAt: new Date().toISOString(),
      });
    },

    get: read,

    async attachTab(sessionId, tabId) {
      const s = await read(sessionId);
      if (!s) return null;
      return write({ ...s, tabId });
    },

    /**
     * Append a captured step. Returns the updated session, or null when the session is
     * gone — the caller must treat that as "recording already stopped", not as a crash.
     */
    async appendStep(sessionId, step) {
      const s = await read(sessionId);
      if (!s || s.status !== "recording") return null;
      return write({ ...s, steps: [...s.steps, step] });
    },

    /** Remove the last captured step. A no-op on an empty session. */
    async undo(sessionId) {
      const s = await read(sessionId);
      if (!s || s.status !== "recording") return null;
      return write({ ...s, steps: s.steps.slice(0, -1) });
    },

    /** Mark the session finished; the steps stay readable until the Portal collects them. */
    async stop(sessionId) {
      const s = await read(sessionId);
      if (!s) return null;
      return write({ ...s, status: "done", stoppedAt: new Date().toISOString() });
    },

    async discard(sessionId) {
      await storage.remove(recorderKey(sessionId));
    },

    /** Find the recording session bound to a tab, if any. */
    async findByTab(tabId) {
      const all = await storage.get(null);
      for (const [key, value] of Object.entries(all || {})) {
        if (key.startsWith(RECORDER_PREFIX) && value?.tabId === tabId && value?.status === "recording") {
          return value;
        }
      }
      return null;
    },
  };
}
