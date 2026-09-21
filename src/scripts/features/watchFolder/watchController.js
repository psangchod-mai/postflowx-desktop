// scripts/features/watchFolder/watchController.js
//
// D1 watch-folder orchestration brain. Ties together the tested pieces:
//   fs events → createBatcher (settle/debounce + ignore) → proposeAction → onProposal
// Everything external is INJECTED (clock, scheduler, the fs event source, the
// proposal sink) so the whole controller is unit-testable with a fake clock and
// a fake event stream. The only live-wire left is a ~20-line Electron adapter:
//   const ctl = createWatchController({ onProposal });
//   ctl.start();                                  // begins the settle poll
//   fsWatcher.on('event', p => ctl.onFsEvent(p)); // feed real fs.watch paths
//   // onProposal(proposal) → show the one-click prompt, switch to proposal.tab
// and ctl.stop() on folder change / teardown.

import { createBatcher } from './settleBatch.js';
import { proposeAction } from './proposeAction.js';

/**
 * @param {object} opts
 * @param {number}   [opts.settleMs=1500] quiet period before a batch fires
 * @param {number}   [opts.pollMs=500]    how often to check for a settled batch
 * @param {function} [opts.now]           () → ms clock (injectable for tests)
 * @param {function} [opts.onProposal]    (proposal, files) → void; called once per settled batch
 */
export function createWatchController({ settleMs = 1500, pollMs = 500, now, onProposal } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const batcher = createBatcher({ settleMs });
  let timer = null;
  let active = false;

  // Drain a settled batch (if any) into a single proposal. Public so tests can
  // drive it deterministically without a real timer.
  function tick() {
    if (!active) return null;
    const batch = batcher.ready(clock());
    if (!batch) return null;
    const proposal = proposeAction(batch);
    if (proposal && typeof onProposal === 'function') {
      try { onProposal(proposal, batch); } catch { /* a bad sink must not kill the watcher */ }
    }
    return proposal;   // null when the batch was only junk/non-actionable
  }

  return {
    /** Feed one filesystem path (junk/temp files are filtered downstream). */
    onFsEvent(path) { if (active) batcher.add(path, clock()); },

    /** Begin watching. `scheduler` defaults to setInterval; injectable for tests. */
    start(scheduler) {
      active = true;
      const set = scheduler || ((fn, ms) => setInterval(fn, ms));
      timer = set(tick, pollMs);
      return timer;
    },

    /** Stop watching, drop pending state. `clearer` defaults to clearInterval. */
    stop(clearer) {
      active = false;
      const clr = clearer || ((h) => clearInterval(h));
      if (timer != null) clr(timer);
      timer = null;
      batcher.clear();
    },

    tick,
    isActive: () => active,
    pendingCount: () => batcher.pendingCount(),
  };
}
