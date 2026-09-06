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
 * Every mutation goes through ONE global queue. Per-session locking is not enough: the
 * "one recorder per tab" rule is a property of the TAB, so two different session ids can
 * both read "tab 7 is free" and both write themselves onto it. A single queue is also
 * what appendStep/undo need — they are read-modify-write against storage, and two in
 * flight at once silently drop a step. A recorder handles a handful of clicks, so
 * serialising every mutation costs nothing and removes a whole class of race.
 *
 * The storage adapter is injected so this module is unit-testable without Chrome.
 */

export const RECORDER_PREFIX = "tg:recorder:";

export const SESSION_ERRORS = {
  /** The payload is missing something the recorder cannot work without. */
  INVALID_SESSION: "INVALID_SESSION",
  /** That id is still recording; starting over it would discard captured steps. */
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
  /** Tail of the single mutation queue. */
  let queue = Promise.resolve();

  /**
   * Run `fn` after every earlier mutation has settled — including failed ones, so one
   * rejected operation never stalls the queue.
   */
  function enqueue(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
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
      // A malformed payload is not "this session already exists" — the Portal needs to
      // tell the two apart to know whether retrying could ever help.
      if (!id) throw new SessionError(SESSION_ERRORS.INVALID_SESSION, "start: thiếu id phiên ghi");
      if (!guideId) throw new SessionError(SESSION_ERRORS.INVALID_SESSION, "start: thiếu guideId");
      if (!site) throw new SessionError(SESSION_ERRORS.INVALID_SESSION, "start: thiếu site");

      return enqueue(async () => {
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
      return enqueue(async () => {
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
      return enqueue(async () => {
        const s = await read(sessionId);
        if (!s || s.status !== "recording") return null;
        return write({ ...s, steps: [...s.steps, step] });
      });
    },

    /** Remove the last captured step. A no-op on an empty session. */
    async undo(sessionId) {
      return enqueue(async () => {
        const s = await read(sessionId);
        if (!s || s.status !== "recording") return null;
        return write({ ...s, steps: s.steps.slice(0, -1) });
      });
    },

    /** Mark the session finished; the steps stay readable until the Portal collects them. */
    async stop(sessionId) {
      return enqueue(async () => {
        const s = await read(sessionId);
        if (!s) return null;
        return write({ ...s, status: "done", stoppedAt: new Date().toISOString() });
      });
    },

    async discard(sessionId) {
      return enqueue(async () => {
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
