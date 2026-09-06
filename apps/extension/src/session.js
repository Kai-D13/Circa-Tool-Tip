/**
 * Recorder state, kept in `chrome.storage.session`.
 *
 * Why not a variable in the service worker: MV3 evicts the worker whenever it is idle,
 * and a recording session outlives that easily — the operator is over on the POS tab
 * clicking around. State in memory would vanish mid-recording with no warning. Session
 * storage survives worker restarts and is cleared when the browser closes, which is
 * exactly the lifetime a recording should have.
 *
 * Two invariants this module enforces, because breaking either loses the operator's work:
 *   1. An id that is still `recording` cannot be re-started over the top of itself.
 *   2. A tab hosts at most one recording session.
 * Without them, two Portal tabs (or one impatient double-click on START) produce two
 * recorders on the same POS tab and the content script attaches to whichever one
 * `findByTab` happened to see first.
 *
 * Every mutation of a session is serialised per session id. appendStep and undo are
 * read-modify-write against storage; two of them in flight at once silently drop a step.
 *
 * The storage adapter is injected so this module is unit-testable without Chrome.
 */

export const RECORDER_PREFIX = "tg:recorder:";

export const SESSION_ERRORS = {
  SESSION_EXISTS: "SESSION_EXISTS",
  TAB_BUSY: "TAB_BUSY",
  DUPLICATE_TAB: "DUPLICATE_TAB",
};

export class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

export function recorderKey(sessionId) {
  return RECORDER_PREFIX + sessionId;
}

/**
 * @param {{get(keys):Promise<object>, set(items):Promise<void>, remove(keys):Promise<void>}} storage
 */
export function createRecorderStore(storage) {
  /** sessionId -> tail of that session's mutation chain. */
  const chains = new Map();

  /** Run `fn` after every earlier mutation of this session has settled. */
  function serialize(sessionId, fn) {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    chains.set(sessionId, next.then(
      () => {},
      () => {},
    ));
    return next;
  }

  async function read(sessionId) {
    const key = recorderKey(sessionId);
    const bag = await storage.get(key);
    return bag?.[key] ?? null;
  }

  async function write(session) {
    await storage.set({ [recorderKey(session.id)]: session });
    return session;
  }

  /** Every session currently in the `recording` state. */
  async function recordingSessions() {
    const all = await storage.get(null);
    return Object.entries(all || {})
      .filter(([key, value]) => key.startsWith(RECORDER_PREFIX) && value?.status === "recording")
      .map(([, value]) => value);
  }

  async function assertTabFree(tabId, ownerId) {
    if (tabId === null || tabId === undefined) return;
    const holder = (await recordingSessions()).find((s) => s.tabId === tabId && s.id !== ownerId);
    if (holder) {
      throw new SessionError(
        SESSION_ERRORS.TAB_BUSY,
        `Tab ${tabId} đang được phiên ghi "${holder.id}" sử dụng. Dừng phiên đó trước.`,
      );
    }
  }

  return {
    /**
     * Begin a session. Refuses to overwrite one that is still recording — that would
     * throw away steps the operator has already captured.
     */
    async start({ id, guideId, site, startUrl, tabId = null, mode = "append", stepId = null }) {
      if (!id) throw new SessionError(SESSION_ERRORS.SESSION_EXISTS, "start: thiếu id phiên ghi");
      if (!guideId) throw new SessionError(SESSION_ERRORS.SESSION_EXISTS, "start: thiếu guideId");
      if (!site) throw new SessionError(SESSION_ERRORS.SESSION_EXISTS, "start: thiếu site");

      return serialize(id, async () => {
        const existing = await read(id);
        if (existing && existing.status === "recording") {
          throw new SessionError(
            SESSION_ERRORS.SESSION_EXISTS,
            `Phiên ghi "${id}" đang chạy — không ghi đè. Dừng nó trước khi bắt đầu phiên mới.`,
          );
        }
        await assertTabFree(tabId, id);

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
      });
    },

    get: read,

    async attachTab(sessionId, tabId) {
      return serialize(sessionId, async () => {
        const s = await read(sessionId);
        if (!s || s.status !== "recording") return null;
        await assertTabFree(tabId, sessionId);
        return write({ ...s, tabId });
      });
    },

    /**
     * Append a captured step. Returns the updated session, or null when the session is
     * gone or already stopped — the caller must treat that as "recording already
     * finished", not as a crash.
     */
    async appendStep(sessionId, step) {
      return serialize(sessionId, async () => {
        const s = await read(sessionId);
        if (!s || s.status !== "recording") return null;
        return write({ ...s, steps: [...s.steps, step] });
      });
    },

    /** Remove the last captured step. A no-op on an empty session. */
    async undo(sessionId) {
      return serialize(sessionId, async () => {
        const s = await read(sessionId);
        if (!s || s.status !== "recording") return null;
        return write({ ...s, steps: s.steps.slice(0, -1) });
      });
    },

    /** Mark the session finished; the steps stay readable until the Portal collects them. */
    async stop(sessionId) {
      return serialize(sessionId, async () => {
        const s = await read(sessionId);
        if (!s) return null;
        return write({ ...s, status: "done", stoppedAt: new Date().toISOString() });
      });
    },

    async discard(sessionId) {
      return serialize(sessionId, async () => {
        await storage.remove(recorderKey(sessionId));
        return null;
      });
    },

    /**
     * The recording session bound to a tab, or null.
     *
     * Throws if two sessions claim the same tab: start/attachTab are supposed to make
     * that impossible, so it means the invariant broke and silently picking one would
     * attach the content script to an arbitrary recorder.
     */
    async findByTab(tabId) {
      const holders = (await recordingSessions()).filter((s) => s.tabId === tabId);
      if (holders.length > 1) {
        throw new SessionError(
          SESSION_ERRORS.DUPLICATE_TAB,
          `Tab ${tabId} có ${holders.length} phiên ghi cùng lúc: ${holders.map((s) => s.id).join(", ")}.`,
        );
      }
      return holders[0] ?? null;
    },
  };
}
