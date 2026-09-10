// Batch 4: single-flight + "at most one trailing forced run" scheduler.
//
// Deliberately generic (takes a plain `runFn(reason, force) => Promise<result>`)
// so it can be unit tested with synthetic runners instead of real fs scans, and
// reused as-is by server.js for the real native-session refresh.
//
// Policy (session-refresh-performance-plan.md §Refresh concurrency policy):
//   - Concurrent non-force callers share whatever is currently in flight.
//   - A manual force that arrives while something is in flight waits for it,
//     then unconditionally runs exactly one more forced refresh afterward.
//   - Multiple manual forces that arrive while something is in flight collapse
//     into that same single trailing forced run — never more than one queued.
//   - Nothing already running is ever cancelled; shutdown only stops *new*
//     scan work from starting.
export function createRefreshCoordinator(runFn) {
  let current = null;   // { promise, force } — the run actually executing now
  let trailing = null;  // { promise } — at most one queued forced re-run
  let shuttingDown = false;

  function start(reason, force) {
    if (shuttingDown) {
      // No new native scan work may begin once shutdown has started. Resolve
      // immediately instead of hanging — this is what keeps shutdown from
      // leaving orphan background work. Anything already executing is a
      // different promise, tracked separately, and is left alone to finish.
      return Promise.resolve({ ok: false, skipped: 'shutdown', reason });
    }
    // runFn is invoked synchronously (matching normal call semantics — an
    // async runFn still only runs up to its first internal await before this
    // returns), with a synchronous throw converted into a rejection instead
    // of escaping start() uncaught.
    let raw;
    try {
      raw = runFn(reason, force);
    } catch (e) {
      raw = Promise.reject(e);
    }
    const promise = Promise.resolve(raw).finally(() => {
      if (current && current.promise === promise) current = null;
    });
    current = { promise, force };
    return promise;
  }

  function schedule(reason, { force = false } = {}) {
    if (!current) return start(reason, force);
    if (!force) return current.promise;
    if (trailing) return trailing.promise;
    const base = current.promise;
    const entry = {};
    // A rejected base run must not cancel the queued forced run — force is
    // unconditional. `trailing` is cleared *before* calling start() (both
    // synchronous, same callback tick) so a force arriving once this trailing
    // run has actually begun executing is treated as "encountered an
    // existing flight" and queues a fresh trailing slot of its own, rather
    // than silently merging into a run that already started before it asked.
    entry.promise = base.catch(() => {}).then(() => {
      trailing = null;
      return start(`${reason}-trailing`, true);
    });
    trailing = entry;
    return entry.promise;
  }

  async function shutdown() {
    shuttingDown = true;
    const waitFor = [];
    if (current) waitFor.push(current.promise.catch(() => {}));
    if (trailing) waitFor.push(trailing.promise.catch(() => {}));
    await Promise.all(waitFor);
  }

  return {
    schedule,
    shutdown,
    hasInFlight: () => current != null,
    hasTrailing: () => trailing != null,
    isShuttingDown: () => shuttingDown,
  };
}
