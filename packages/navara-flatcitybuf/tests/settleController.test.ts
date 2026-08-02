import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachSettleController,
  createSettleController,
} from "../src/settleController";

describe("createSettleController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calls onFirstChange synchronously on movestart, and not onSettle", () => {
    const onFirstChange = vi.fn();
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange,
      onSettle,
    });
    c.onMoveStart();
    expect(onFirstChange).toHaveBeenCalledTimes(1);
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("does not call onFirstChange again for `move` ticks inside the same interaction", () => {
    const onFirstChange = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange,
      onSettle: vi.fn(),
    });
    c.onMoveStart();
    c.onMove();
    c.onMove();
    expect(onFirstChange).toHaveBeenCalledTimes(1);
  });

  it("never settles while `move` ticks keep arriving — no commit mid-drag", () => {
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    c.onMoveStart();
    for (let i = 0; i < 10; i++) {
      c.onMove();
      vi.advanceTimersByTime(300);
    }
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("settles settleMs after moveend", () => {
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(349);
    expect(onSettle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("idle FLUSHES an armed settle immediately instead of waiting out settleMs", () => {
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    c.onMoveStart();
    c.onMoveEnd();
    c.onIdle();
    expect(onSettle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(onSettle).toHaveBeenCalledTimes(1); // the armed timer was cleared
  });

  it("ignores idle when nothing is armed — a static scene's idle ticks never re-commit", () => {
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    c.onIdle();
    c.onIdle();
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("ignores the idle that follows a bare setCamera — it emits no move* at all", () => {
    // B1 §5(c): `setCamera` emits ONLY the ambient `idle`. Keying the commit
    // off `idle` alone would turn every programmatic camera write into a
    // streaming commit; keying it off `moveend` is what makes the restore path
    // safe without a bracket.
    const onSettle = vi.fn();
    const onFirstChange = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange,
      onSettle,
    });
    c.onIdle();
    vi.advanceTimersByTime(1000);
    expect(onFirstChange).not.toHaveBeenCalled();
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("treats the interaction after a settle as a new burst (onFirstChange fires again)", () => {
    const onFirstChange = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange,
      onSettle: vi.fn(),
    });
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(350);
    c.onMoveStart();
    expect(onFirstChange).toHaveBeenCalledTimes(2);
  });

  it("defers, rather than double-commits, when a second burst opens inside the armed window", () => {
    // Measured shape (B1 §5a) is one burst per gesture with inertia INSIDE it,
    // so this is defensive: a fast second gesture landing inside the armed
    // window must push the commit out, not add one.
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(200);
    c.onMoveStart(); // second gesture, armed window not yet elapsed
    vi.advanceTimersByTime(1000);
    expect(onSettle).not.toHaveBeenCalled(); // still dragging
    c.onMoveEnd();
    vi.advanceTimersByTime(350);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels an armed settle — onSettle never fires", () => {
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    c.onMoveStart();
    c.onMoveEnd();
    c.dispose();
    vi.advanceTimersByTime(1000);
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("ignores events that arrive after dispose", () => {
    const onSettle = vi.fn();
    const onFirstChange = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange,
      onSettle,
    });
    c.dispose();
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(1000);
    expect(onFirstChange).not.toHaveBeenCalled();
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("ignores a programmatic camera burst wrapped in suppress()", () => {
    const onSettle = vi.fn();
    const onFirstChange = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange,
      onSettle,
    });
    c.suppress(() => {
      c.onMoveStart();
      c.onMove();
      c.onMoveEnd();
    });
    vi.advanceTimersByTime(1000);
    expect(onFirstChange).not.toHaveBeenCalled();
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("keeps ignoring for the trailing quiet window, so an animated flyTo cannot leak a commit", () => {
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    c.suppress(() => {}, 2000);
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(1000);
    expect(onSettle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(400);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("returns fn's value and still opens the quiet window when fn throws", () => {
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    expect(c.suppress(() => 42)).toBe(42);
    expect(() =>
      c.suppress(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // The throw must not leave the gate stuck open OR stuck closed: events
    // inside the quiet window are still ignored…
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(1000);
    expect(onSettle).not.toHaveBeenCalled();
    // …and once it elapses the controller is live again.
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(350);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("suppressUntil holds the gate for the whole awaited flyTo, not just the call", async () => {
    const onSettle = vi.fn();
    const onFirstChange = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange,
      onSettle,
    });
    let resolve!: () => void;
    const flight = new Promise<void>((r) => {
      resolve = r;
    });
    c.suppressUntil(flight, 2000);

    // The animated burst arrives long after the `suppressUntil` call returned.
    c.onMoveStart();
    vi.advanceTimersByTime(5000);
    c.onMove();
    c.onMoveEnd();
    vi.advanceTimersByTime(1000);
    expect(onFirstChange).not.toHaveBeenCalled();
    expect(onSettle).not.toHaveBeenCalled();

    resolve();
    await flight;
    // Trailing events inside the quiet window are still ignored.
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(1999);
    expect(onSettle).not.toHaveBeenCalled();
    // After the quiet window, a real gesture commits again.
    vi.advanceTimersByTime(1);
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(350);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("releases the suppressUntil gate when the promise rejects, without an unhandled rejection", async () => {
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    const failed = Promise.reject(new Error("flyTo aborted"));
    c.suppressUntil(failed, 100);
    await failed.catch(() => {});
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(350);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("a suppressed moveend still ENDS the burst, so the next gesture aborts in-flight work", () => {
    // Regression: the gate closing mid-burst (e.g. a keyboard "reset view"
    // while the pointer is still down) swallowed the burst's `moveend`, which
    // is the only event that would have cleared burst liveness. `inBurst` then
    // stayed stuck and the NEXT real gesture's `movestart` skipped
    // `onFirstChange` — silently failing to abort in-flight work.
    const onFirstChange = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange,
      onSettle: vi.fn(),
    });
    c.onMoveStart(); // burst starts, onFirstChange fires (1)
    c.suppress(() => {}, 100); // programmatic camera move mid-drag
    vi.advanceTimersByTime(50);
    c.onMoveEnd(); // swallowed — gate still held
    vi.advanceTimersByTime(1000);
    c.onMoveStart(); // next gesture
    expect(onFirstChange).toHaveBeenCalledTimes(2);
  });

  it("…and that suppressed moveend still commits nothing", () => {
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    c.onMoveStart();
    c.suppress(() => {}, 100);
    vi.advanceTimersByTime(50);
    c.onMoveEnd(); // suppressed: ends the burst, arms nothing
    vi.advanceTimersByTime(1000);
    expect(onSettle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); // no settle timer was armed
  });

  it("does the same for suppressUntil — an awaited flyTo mid-drag", async () => {
    const onFirstChange = vi.fn();
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange,
      onSettle,
    });
    let resolve!: () => void;
    const flight = new Promise<void>((r) => {
      resolve = r;
    });
    c.onMoveStart();
    c.suppressUntil(flight, 100);
    c.onMoveEnd(); // swallowed
    resolve();
    await flight;
    vi.advanceTimersByTime(100); // quiet window elapses
    c.onMoveStart();
    expect(onFirstChange).toHaveBeenCalledTimes(2);
    c.onMoveEnd();
    vi.advanceTimersByTime(350);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("stays dead when a pending suppressUntil promise settles after dispose", async () => {
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    let resolve!: () => void;
    const flight = new Promise<void>((r) => {
      resolve = r;
    });
    c.suppressUntil(flight, 2000);
    c.dispose();
    resolve();
    await flight;
    expect(vi.getTimerCount()).toBe(0); // no quiet window opened post-dispose
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(1000);
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("nests: an inner suppress's quiet window cannot unlock the outer one", () => {
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    c.suppress(() => {
      c.suppress(() => {}, 10);
      vi.advanceTimersByTime(50); // inner quiet window elapsed
      c.onMoveStart();
      c.onMoveEnd();
    }, 0);
    vi.advanceTimersByTime(1000);
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("dispose drops a pending quiet window instead of leaking its timer", () => {
    const onSettle = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    c.suppress(() => {}, 5000);
    c.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the injected timer seam rather than the ambient globals", () => {
    const setTimeoutSpy = vi.fn(
      (_fn: () => void, _ms: number) =>
        7 as unknown as ReturnType<typeof setTimeout>,
    );
    const clearTimeoutSpy = vi.fn();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle: vi.fn(),
      timers: { setTimeout: setTimeoutSpy, clearTimeout: clearTimeoutSpy },
    });
    c.onMoveStart();
    c.onMoveEnd();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(350);
    c.dispose();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(7);
  });
});

/** Minimal stand-in for Navara's `EventHandler` — structural, no engine import. */
function fakeEmitter<K extends string>() {
  const listeners = new Map<K, Set<() => void>>();
  return {
    on(k: K, f: () => void): void {
      let s = listeners.get(k);
      if (!s) {
        s = new Set();
        listeners.set(k, s);
      }
      s.add(f);
    },
    off(k: K, f: () => void): void {
      listeners.get(k)?.delete(f);
    },
    emit(k: K): void {
      for (const f of [...(listeners.get(k) ?? [])]) f();
    },
    count(k: K): number {
      return listeners.get(k)?.size ?? 0;
    },
  };
}

describe("attachSettleController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drives the controller from camera move* and view idle", () => {
    const onFirstChange = vi.fn();
    const onSettle = vi.fn();
    const camera = fakeEmitter<"movestart" | "move" | "moveend">();
    const view = fakeEmitter<"idle">();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange,
      onSettle,
    });
    attachSettleController(c, { camera, view });

    camera.emit("movestart");
    expect(onFirstChange).toHaveBeenCalledTimes(1);
    camera.emit("move");
    expect(onFirstChange).toHaveBeenCalledTimes(1);
    camera.emit("moveend");
    expect(onSettle).not.toHaveBeenCalled();
    view.emit("idle"); // flushes the armed settle
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("works without a view — no idle flush, plain settleMs debounce", () => {
    const onSettle = vi.fn();
    const camera = fakeEmitter<"movestart" | "move" | "moveend">();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    attachSettleController(c, { camera });
    camera.emit("movestart");
    camera.emit("moveend");
    vi.advanceTimersByTime(350);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("detach removes every listener it added and leaves the controller alive", () => {
    const onSettle = vi.fn();
    const camera = fakeEmitter<"movestart" | "move" | "moveend">();
    const view = fakeEmitter<"idle">();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle,
    });
    const detach = attachSettleController(c, { camera, view });
    detach();
    expect(camera.count("movestart")).toBe(0);
    expect(camera.count("move")).toBe(0);
    expect(camera.count("moveend")).toBe(0);
    expect(view.count("idle")).toBe(0);

    camera.emit("movestart");
    camera.emit("moveend");
    vi.advanceTimersByTime(1000);
    expect(onSettle).not.toHaveBeenCalled();

    // Detach unsubscribes; it does not dispose. Direct calls still work.
    c.onMoveStart();
    c.onMoveEnd();
    vi.advanceTimersByTime(350);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("detach is idempotent", () => {
    const camera = fakeEmitter<"movestart" | "move" | "moveend">();
    const c = createSettleController({
      settleMs: 350,
      onFirstChange: vi.fn(),
      onSettle: vi.fn(),
    });
    const detach = attachSettleController(c, { camera });
    detach();
    detach();
    expect(camera.count("move")).toBe(0);
  });
});
