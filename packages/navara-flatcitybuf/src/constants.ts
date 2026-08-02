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
export const MOVE_FRAC = 0.2;
export const SCALE_FACTOR = 1.3;
export const T_MAX_M = 5000;
export const MAX_FOOTPRINT_SPAN_M = 8000;
export const VIEWPORT_FEATURE_BUDGET = 20000;
export const RESIDENT_TRIANGLE_BUDGET = 4_000_000;
export const RESIDENT_BYTE_BUDGET = 512 * 1024 * 1024;
export const MIN_COVER_CELLS = 9;
export const MAX_COVER_CELLS = 64;
export const LEVEL_SWAP_TIMEOUT_MS = 1500;
export const MIN_CELL_M = 50;
export const BASE_CELL_M = 100;
