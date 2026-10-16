/** Every streaming tunable. All distances are metres. Provisional — tune
 *  against delft.fcb and one large real dataset before treating as settled. */
export const SETTLE_MS = 350;
/** Trailing quiet window for a suppressed animated `flyTo`.
 *
 *  Measured (B1 §5b): `flyTo` emits a full `movestart … move … moveend` burst
 *  that is indistinguishable from a user drag, so it must be bracketed by
 *  `SettleController.suppressUntil(flight, FLYTO_QUIET_MS)` — the promise
 *  covers the flight itself and this window absorbs the tail (the trace showed
 *  `moveend` ~280 ms after the last `move` and `idle` ~300 ms after that, on a
 *  2–3 fps host). 2 s is generous on purpose: over-suppressing costs at most
 *  one deferred commit, under-suppressing fetches a whole flight path. */
export const FLYTO_QUIET_MS = 2000;
/** How long `openStream` will wait for the geoid sample before opening the
 *  layer at heightOffset 0.
 *
 *  The sample is the one await that blocks a layer's entire existence (the
 *  worker's placement is established with it, so no cell can be fetched
 *  first), and core's sampler issues a bare `fetch` — browser `fetch` has no
 *  default timeout, so an unanswered request would stall the open forever.
 *  10 s is generous for one 256 px terrain tile on a slow connection and
 *  still short enough that a dead service degrades to the pre-geoid
 *  behaviour (model ~43 m low for NAP) instead of an empty viewport. */
export const GEOID_TIMEOUT_MS = 10_000;
/**
 * Liveness bound on ONE commit's fetch. Not a performance deadline — a
 * LIVENESS one.
 *
 * The predecessor of this constant, `LEVEL_SWAP_TIMEOUT_MS = 1500`, was a
 * performance deadline applied to a swap, and it is why the streaming layer
 * stalled on any host where a full-cover swap took longer than 1.5 s: work
 * that merely needed more time was cancelled, and the cancelling path recorded
 * nothing, so the next settle recomputed the same plan (see
 * `docs/superpowers/reviews/2026-08-03-uxfix-report.md` § Wave 3). Removing it
 * left the fetch unbounded, which has its own failure: a `.fcb` range read
 * that never answers (browser `fetch` has no default timeout, exactly as with
 * the geoid sample above) leaves the layer reporting "fetching" forever, with
 * `commit()` pending until the layer is deleted.
 *
 * 30 s is chosen to be far beyond anything a healthy commit can take — the
 * slowest real one measured is ~10 s (1115 features, 7.6 MB in ~1 MB ranges,
 * on a GPU-less host) — so hitting it means the transport is genuinely stuck,
 * never that the work was merely large. On expiry the commit reports an error
 * and abandons the fetch, but records NOTHING: the next settle therefore
 * re-plans from the unchanged cache (still holed, or still a swap) and retries
 * in full. Retrying a stalled transport is correct; retrying work that was
 * cancelled for being slow was not.
 */
export const COMMIT_FETCH_TIMEOUT_MS = 30_000;
export const MOVE_FRAC = 0.2;
export const SCALE_FACTOR = 1.3;
export const T_MAX_M = 5000;
export const MAX_FOOTPRINT_SPAN_M = 8000;
export const VIEWPORT_FEATURE_BUDGET = 20000;
export const RESIDENT_TRIANGLE_BUDGET = 4_000_000;
export const RESIDENT_BYTE_BUDGET = 512 * 1024 * 1024;
/**
 * The worker's own residency cap. A backstop, not the primary mechanism: the
 * main thread's `CellCache` is what normally decides what stays resident, and
 * its `evict` message is what releases entries here. This bounds the damage
 * when that conversation breaks down — a commit abandoned after cells were
 * posted, a main thread whose budget is larger than this one's, a layer that
 * is never closed.
 *
 * The same 512 MiB as `RESIDENT_BYTE_BUDGET`, deliberately: the two caches
 * hold one entry per resident cell each, so a worker cap below the main
 * thread's would drop cells the main thread still believes it can `recolor`
 * or read `surfaces` from. Both degrade gracefully (`recolor` skips an
 * unknown key, `surfaces` answers `not-found`), which is why this can be a
 * hard cap at all.
 */
export const WORKER_RETAINED_BYTE_BUDGET = 512 * 1024 * 1024;
export const MIN_COVER_CELLS = 9;
export const MAX_COVER_CELLS = 64;
export const MIN_CELL_M = 50;
export const BASE_CELL_M = 100;
