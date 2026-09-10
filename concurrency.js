// Batch 4: minimal bounded-concurrency limiter for native session I/O.
//
// Scanning hundreds of JSONL files with unbounded `Promise.all` would open that
// many file descriptors at once and let CPU-bound JSON.parse calls pile up in
// an unpredictable order. This is a plain FIFO gate, not a queue with
// priorities or cancellation — that is all refresh scanning needs.
//
// Kept dependency-free (no p-limit) since this is the only concurrency-limiting
// use case in the codebase today.

export function createLimiter(limit) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
  let active = 0;
  const queue = [];

  function drain() {
    while (active < cap && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve()
        .then(fn)
        .then(
          (value) => { active -= 1; resolve(value); drain(); },
          (error) => { active -= 1; reject(error); drain(); },
        );
    }
  }

  function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      drain();
    });
  }

  return {
    run,
    get limit() { return cap; },
    get active() { return active; },
    get queued() { return queue.length; },
  };
}
