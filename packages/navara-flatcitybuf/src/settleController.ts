/**
 * "Interaction has stopped" for the streaming driver.
 *
 * Pre-migration this debounced OrbitControls' `change` event, which fired
 * continuously while damping decayed. Navara instead emits a discrete
 * movestart/move/moveend triple on `view.camera` plus a view-level `idle`, so:
 *   movestart -> abort in-flight work (onFirstChange), open a burst
 *   move      -> stay in the burst and keep any deadline pushed out (no
 *                mid-drag commit)
 *   moveend   -> arm the settleMs debounce
 *   idle      -> flush an armed debounce now; ignored when nothing is armed
 *
 * MEASURED, not assumed — the branch this file takes comes from Task B1
 * Step 7's real-browser trace (`docs/superpowers/research/
 * 2026-08-01-navara-spike-findings.md` §5, verdicts table §1):
 *
 * - `CAMERA_BURST_SHAPE` = **one** `movestart` … N `move` … **one** `moveend`
 *   per user gesture, with inertia contained INSIDE that burst (`move` kept
 *   firing ≈6.9 s after pointer-up without opening a second burst). So the
 *   plan's "a second burst may arrive" branch does NOT apply; the plain
 *   "settles settleMs after moveend" case stands. `onMoveStart` clears the
 *   armed timer anyway, so a second burst (a fast follow-up gesture) defers
 *   the commit instead of double-committing.
 * - Commit is keyed off **`moveend`, never `idle`**: §5(c) measured that
 *   `view.setCamera` emits *no* `move*` events at all but *does* produce the
 *   ambient `idle`, so an idle-keyed commit would fire on every programmatic
 *   camera write (share-link restore, fitAll). `idle` therefore only ever
 *   *flushes* a debounce that a `moveend` already armed (~270–460 ms of
 *   latency saved), and idle ticks on a static scene are ignored.
 * - `PROGRAMMATIC_MOVE_EMITS` is **split**: `flyTo` emits a full
 *   `movestart…moveend` burst that is indistinguishable from a drag (§5b),
 *   while `setCamera` (§5c) and `resize` (§5d, `resize` + `frustumChanged`
 *   only) emit no `move*`. The trailing quiet window is therefore
 *   **load-bearing, not defensive**: `flyTo` is the case it exists for, and
 *   `suppressUntil` — which holds the gate until the flight's promise settles
 *   and only then starts the quiet window — is the shape an awaited `flyTo`
 *   needs, because a plain `suppress(fn)` would start counting when the call
 *   returns, i.e. before the animation has emitted anything.
 *
 * `suppress` / `suppressUntil` are published contract, not an afterthought:
 * every programmatic camera move (camera restore, share link, `fitAll`,
 * `fitLayer`, `alignView`, `flyTo`) goes through them so it cannot masquerade
 * as a user gesture. Task C11 re-publishes them as
 * `FlatCityBufPlugin.suppressSettle`; Task C13 wraps `NavaraViewport`'s camera
 * methods in that.
 *
 * Engine-free by construction (Task B1's NODE_IMPORT_SAFE = false rule): the
 * event sources are structural (`on`/`off`, the shape of Navara's
 * `EventHandler`) and the timers are injectable, so this module never imports
 * `@navaramap/*`.
 */

/** The subset of Navara's `EventHandler` API this module needs. */
export interface EventSource<K extends string> {
  on(k: K, f: () => void): void;
  off(k: K, f: () => void): void;
}

/** `view.camera` (a `ThreeViewCamera`, `EventHandler<CameraEvent>`). */
export type CameraEventSource = EventSource<"movestart" | "move" | "moveend">;

/** `view` (a `ThreeView`, whose `ViewEvents` carry `idle`). */
export type IdleEventSource = EventSource<"idle">;

/** Injectable timer seam; defaults to the ambient globals. */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface SettleController {
  onMoveStart(): void;
  onMove(): void;
  onMoveEnd(): void;
  onIdle(): void;
  /** Run `fn` with every camera event ignored, then keep ignoring for
   *  `quietMs` after it returns (default `settleMs`). */
  suppress<T>(fn: () => T, quietMs?: number): T;
  /** Same, but the gate is held until `promise` settles — the shape an
   *  animated `flyTo` needs, and what `FlatCityBufPlugin.suppressSettle`
   *  (Task C11) is built on. */
  suppressUntil(promise: Promise<unknown>, quietMs?: number): void;
  dispose(): void;
}

export interface SettleControllerOptions {
  readonly settleMs: number;
  readonly onFirstChange: () => void;
  readonly onSettle: () => void;
  readonly timers?: TimerApi;
}

const defaultTimers: TimerApi = {
  // Resolved at call time, so a test's fake timers (installed after the
  // controller was created) are still honoured.
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export function createSettleController(
  opts: SettleControllerOptions,
): SettleController {
  const timers = opts.timers ?? defaultTimers;
  type Handle = ReturnType<typeof setTimeout>;

  let timer: Handle | null = null;
  let armed = false;
  let inBurst = false;
  let disposed = false;
  /** How many suppression holds are open (nested `suppress` + quiet windows). */
  let holds = 0;
  const quietTimers = new Set<Handle>();

  const clear = (): void => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const fire = (): void => {
    clear();
    armed = false;
    inBurst = false;
    opts.onSettle();
  };
  /** True while camera events must be ignored (programmatic move in flight). */
  const gated = (): boolean => disposed || holds > 0;

  const beginBurst = (): void => {
    if (!inBurst) {
      inBurst = true;
      opts.onFirstChange();
    }
  };
  /** Hold the gate open for `quietMs` more, then release this hold. */
  const holdQuietly = (quietMs: number): void => {
    if (disposed || quietMs <= 0) return;
    holds++;
    const handle = timers.setTimeout(() => {
      quietTimers.delete(handle);
      holds--;
    }, quietMs);
    quietTimers.add(handle);
  };

  return {
    onMoveStart() {
      if (gated()) return;
      beginBurst();
      // A follow-up gesture inside the armed window defers the commit rather
      // than letting the stale deadline fire mid-drag.
      clear();
      armed = false;
    },
    onMove() {
      if (gated()) return;
      // A `move` during an armed window means the interaction resumed;
      // disarm so a stale deadline can't commit mid-drag.
      clear();
      armed = false;
      beginBurst();
    },
    onMoveEnd() {
      if (gated()) return;
      clear();
      armed = true;
      timer = timers.setTimeout(fire, opts.settleMs);
    },
    onIdle() {
      if (gated()) return;
      // Only ever a flush: `idle` also follows a bare `setCamera` (B1 §5c),
      // which must not commit anything.
      if (armed) fire();
    },
    suppress<T>(fn: () => T, quietMs: number = opts.settleMs): T {
      holds++;
      try {
        return fn();
      } finally {
        // Open the trailing window before releasing this hold, so the gate
        // never blinks shut between the two.
        holdQuietly(quietMs);
        holds--;
      }
    },
    suppressUntil(promise: Promise<unknown>, quietMs: number = opts.settleMs) {
      holds++;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        // `dispose` already zeroed the hold count; decrementing again would
        // drive it negative and quietly re-open the gate.
        if (disposed) return;
        holdQuietly(quietMs);
        holds--;
      };
      // Both arms: a rejected flight must release the gate, and attaching a
      // rejection handler is also what keeps it from becoming unhandled.
      promise.then(release, release);
    },
    dispose() {
      disposed = true;
      clear();
      for (const handle of quietTimers) timers.clearTimeout(handle);
      quietTimers.clear();
      holds = 0;
      armed = false;
      inBurst = false;
    },
  };
}

/**
 * Subscribe a controller to a Navara camera (and optionally the view, for the
 * `idle` flush). Returns an idempotent detach; detaching does NOT dispose the
 * controller, so a caller can re-attach it to a new view.
 */
export function attachSettleController(
  controller: SettleController,
  sources: {
    readonly camera: CameraEventSource;
    readonly view?: IdleEventSource;
  },
): () => void {
  const onMoveStart = (): void => controller.onMoveStart();
  const onMove = (): void => controller.onMove();
  const onMoveEnd = (): void => controller.onMoveEnd();
  const onIdle = (): void => controller.onIdle();

  sources.camera.on("movestart", onMoveStart);
  sources.camera.on("move", onMove);
  sources.camera.on("moveend", onMoveEnd);
  sources.view?.on("idle", onIdle);

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    sources.camera.off("movestart", onMoveStart);
    sources.camera.off("move", onMove);
    sources.camera.off("moveend", onMoveEnd);
    sources.view?.off("idle", onIdle);
  };
}
