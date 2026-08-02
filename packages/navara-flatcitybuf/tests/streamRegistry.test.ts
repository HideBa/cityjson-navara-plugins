/**
 * Task C11: the FlatCityBuf plugin's behaviour — the camera-driven commit
 * loop, `suppressSettle`, and `openStream`'s admission / CRS / vertical-datum
 * orchestration.
 *
 * These drive `StreamLayerRegistry`, not `FlatCityBufPlugin`: the plugin class
 * imports `@navaramap/three`, which crashes at module scope under Node (Task
 * B1's `NODE_IMPORT_SAFE = false` — reconfirmed for this task), so it is the
 * three-line binding and this is everything it forwards to. Every engine seam
 * is injected: the worker client, the mesh factory, the pick-ray source and
 * the geoid sampler.
 *
 * The fakes are local rather than imported from `navara-cityjson/tests`
 * (Task B2's carry-forward: those are not importable across packages), and
 * deliberately minimal — the event sources here are the structural `on`/`off`
 * pair `attachSettleController` binds to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import proj4 from "proj4";
import { ensureProjDef, makeEnuFrame, enuToEcef } from "@cityjson/navara-core";
import { StreamLayerRegistry } from "../src/streamRegistry";
import type { StreamLayerLike } from "../src/streamRegistry";
import type { CellMeshFactory } from "../src/cellMeshes";
import type { PickRaySource } from "../src/navaraRays";
import type { WorkerClient } from "../src/workerClient";
import type { WorkerResponse } from "../src/workerProtocol";
import type { Ray } from "../src/viewportFootprint";
import { SETTLE_MS } from "../src/constants";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** The structural `on`/`off` event source `attachSettleController` binds to. */
class FakeEmitter {
  readonly handlers = new Map<string, Set<() => void>>();
  on(k: string, f: () => void): void {
    (this.handlers.get(k) ?? this.handlers.set(k, new Set()).get(k)!).add(f);
  }
  off(k: string, f: () => void): void {
    this.handlers.get(k)?.delete(f);
  }
  emit(k: string): void {
    for (const f of [...(this.handlers.get(k) ?? [])]) f();
  }
  count(k: string): number {
    return this.handlers.get(k)?.size ?? 0;
  }
}

/**
 * Stand-in for `ThreeView`: camera events on `view.camera`, `idle` on the view
 * itself (Task B1 finding 6). NOTE: no `canvas` property — `ThreeView`
 * documents `canvas` as a constructor OPTION, so the viewport measurement
 * arrives through the injected `getViewportSize` instead (Task C4).
 */
class FakeView extends FakeEmitter {
  readonly camera = new FakeEmitter();
  readonly registeredMeshes = new Map<string, unknown>();
  registerMesh(name: string, desc: unknown): void {
    this.registeredMeshes.set(name, desc);
  }
  /** One user gesture: movestart, N moves, moveend. */
  gesture(moves = 1): void {
    this.camera.emit("movestart");
    for (let i = 0; i < moves; i++) this.camera.emit("move");
    this.camera.emit("moveend");
  }
}

/** A layer stub: the three members the driver touches. */
function fakeLayer(): StreamLayerLike & {
  commit: ReturnType<typeof vi.fn>;
  abortInFlight: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    commit: vi.fn(async () => {}),
    abortInFlight: vi.fn(),
    delete: vi.fn(),
  };
}

/** Four identical straight-down rays — enough for the driver tests, which
 *  only care about how OFTEN `commit` is called. */
const flatRays: PickRaySource = {
  width: 800,
  height: 600,
  getPickRay: () => ({ origin: [0, 0, 0], direction: [0, 0, -1] }),
};

const noMeshes: CellMeshFactory = {
  create: () => {
    throw new Error("no mesh factory in this test");
  },
};

function makeRegistry(
  over: Partial<ConstructorParameters<typeof StreamLayerRegistry>[0]> = {},
) {
  return new StreamLayerRegistry({
    createClient: () => {
      throw new Error("no worker client in this test");
    },
    createMeshFactory: () => noMeshes,
    getPickRays: () => flatRays,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// The camera-driven driver
// ---------------------------------------------------------------------------

describe("StreamLayerRegistry — camera driver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("subscribes to movestart/move/moveend on the camera and idle on the view, and unsubscribes on dispose", () => {
    const view = new FakeView();
    const r = makeRegistry();
    r.attach(view);

    for (const e of ["movestart", "move", "moveend"]) {
      expect(view.camera.count(e)).toBe(1);
    }
    expect(view.count("idle")).toBe(1);

    r.dispose();
    for (const e of ["movestart", "move", "moveend"]) {
      expect(view.camera.count(e)).toBe(0);
    }
    expect(view.count("idle")).toBe(0);
  });

  it("registers its descriptors on attach", () => {
    const view = new FakeView();
    class Desc {}
    makeRegistry({ descriptors: [["cityMeshArrays", Desc]] }).attach(view);
    expect(view.registeredMeshes.get("cityMeshArrays")).toBe(Desc);
  });

  it("commits every registered layer once per settle, and none while no layer is open", () => {
    const view = new FakeView();
    const r = makeRegistry();
    r.attach(view);

    // No layers registered: nothing to do, and nothing throws.
    view.gesture();
    vi.advanceTimersByTime(SETTLE_MS + 50);

    const a = fakeLayer();
    const b = fakeLayer();
    r.register("a", a);
    r.register("b", b);

    view.camera.emit("movestart");
    expect(a.abortInFlight).toHaveBeenCalledTimes(1);
    expect(b.abortInFlight).toHaveBeenCalledTimes(1);
    expect(a.commit).not.toHaveBeenCalled();

    view.camera.emit("moveend");
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(a.commit).toHaveBeenCalledTimes(1);
    expect(b.commit).toHaveBeenCalledTimes(1);
    // Every layer commits against ONE ray set.
    expect(a.commit.mock.calls[0]![0]).toEqual(b.commit.mock.calls[0]![0]);
    expect(a.commit.mock.calls[0]![0] as Ray[]).toHaveLength(4);
  });

  it("does not commit while there is no view to take rays from", () => {
    const view = new FakeView();
    const r = makeRegistry({ getPickRays: () => null });
    r.attach(view);
    const layer = fakeLayer();
    r.register("a", layer);

    view.gesture();
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(layer.commit).not.toHaveBeenCalled();
  });

  it("does not commit for a camera move wrapped in suppressSettle", async () => {
    const view = new FakeView();
    const r = makeRegistry();
    r.attach(view);
    const layer = fakeLayer();
    r.register("l1", layer);

    await r.suppressSettle(() => {
      // Stand-in for view.flyTo(...), which emits a full camera burst.
      view.gesture(1);
    });
    vi.advanceTimersByTime(5000);

    expect(layer.commit).not.toHaveBeenCalled();
    expect(layer.abortInFlight).not.toHaveBeenCalled();
  });

  it("still commits for a real user gesture after the suppressed move", async () => {
    const view = new FakeView();
    const r = makeRegistry();
    r.attach(view);
    const layer = fakeLayer();
    r.register("l1", layer);

    await r.suppressSettle(() => view.gesture());
    vi.advanceTimersByTime(5000);

    view.gesture();
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(layer.commit).toHaveBeenCalledTimes(1);
  });

  it("holds the gate for the whole of an awaited (animated) move, not just the call", async () => {
    vi.useRealTimers();
    const view = new FakeView();
    const r = makeRegistry({ settleMs: 10 });
    r.attach(view);
    const layer = fakeLayer();
    r.register("l1", layer);

    // A `flyTo` that resolves later, emitting its burst in the meantime — the
    // shape `suppress(fn)` alone cannot cover, because its quiet window would
    // start when the call returned.
    await r.suppressSettle(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            view.gesture(2);
            resolve();
          }, 30);
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(layer.commit).not.toHaveBeenCalled();
  });

  it("suppressSettle before attach just runs the function", async () => {
    await expect(makeRegistry().suppressSettle(() => 42)).resolves.toBe(42);
  });

  it("remove() deletes one layer and drops it from the loop; dispose() deletes the rest", () => {
    const view = new FakeView();
    const r = makeRegistry();
    r.attach(view);
    const a = fakeLayer();
    const b = fakeLayer();
    r.register("a", a);
    r.register("b", b);

    r.remove("a");
    expect(a.delete).toHaveBeenCalledTimes(1);
    expect(r.getHandle("a")).toBeUndefined();
    expect(r.handles()).toEqual([b]);
    r.remove("nope"); // unknown id is ignored

    view.gesture();
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(a.commit).not.toHaveBeenCalled();
    expect(b.commit).toHaveBeenCalledTimes(1);

    r.dispose();
    expect(b.delete).toHaveBeenCalledTimes(1);
    expect(r.handles()).toEqual([]);
    r.dispose(); // idempotent
    expect(b.delete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// openStream
// ---------------------------------------------------------------------------

/** Delft, in RD New (EPSG:28992) — a real metre-based CRS proj4 only knows
 *  after `ensureProjDef`, which is exactly what the CRS gate calls. */
const EXTENT = [84000, 446000, 0, 86000, 448000, 30] as const;
const EPSG = 28992;

function centreLngLat(): readonly [number, number] {
  ensureProjDef(EPSG);
  const converter = proj4(`EPSG:${EPSG}`, "WGS84") as {
    forward(c: [number, number]): [number, number];
  };
  return converter.forward([
    (EXTENT[0] + EXTENT[3]) / 2,
    (EXTENT[1] + EXTENT[4]) / 2,
  ]);
}

const GEOID_M = 43;

/** Four downward rays spanning +-`half` metres around the layer frame's
 *  origin, so a commit produces a real footprint and reaches `fetch`. */
function topDownRays(): PickRaySource {
  const [lng, lat] = centreLngLat();
  const frame = makeEnuFrame(lng, lat, GEOID_M);
  const corners: Array<[number, number]> = [
    [-400, -400],
    [400, -400],
    [400, 400],
    [-400, 400],
  ];
  const rays = corners.map((c) => {
    const o = enuToEcef(frame, [0, 0, 500]);
    const t = enuToEcef(frame, [c[0], c[1], 0]);
    const d = [t[0] - o[0], t[1] - o[1], t[2] - o[2]] as const;
    const len = Math.hypot(d[0], d[1], d[2]);
    return { origin: o, direction: [d[0] / len, d[1] / len, d[2] / len] };
  });
  return {
    width: 800,
    height: 600,
    getPickRay: (x, y) => rays[x === 0 ? (y === 0 ? 0 : 3) : y === 0 ? 1 : 2]!,
  };
}

interface FakeClientOpts {
  readonly epsg?: number | null;
  readonly extent?: readonly number[] | undefined;
  readonly admission?: { code: string; message: string } | null;
  /** Every request/side effect, in order — the timeline the geoid ordering
   *  assertion reads. */
  readonly trace: string[];
}

function makeFakeClient(opts: FakeClientOpts) {
  let epoch = 0;
  const terminate = vi.fn(() => opts.trace.push("terminate"));
  const client = {
    newEpoch: vi.fn(() => ++epoch),
    isCurrent: vi.fn((e: number) => e === epoch),
    send: vi.fn(
      async (msg: Record<string, unknown>): Promise<WorkerResponse> => {
        if (msg.type === "open") {
          opts.trace.push(`open:${String(msg.heightOffset)}`);
          return {
            type: "opened",
            id: 0,
            header: {
              version: "2.0",
              featuresCount: 100,
              extent: opts.extent === undefined ? EXTENT : opts.extent,
              referenceSystem: `https://www.opengis.net/def/crs/EPSG/0/${opts.epsg ?? EPSG}`,
              epsg: opts.epsg === undefined ? EPSG : opts.epsg,
            },
            admission: opts.admission ?? null,
          };
        }
        opts.trace.push(String(msg.type));
        if (msg.type === "probe") return { type: "probed", id: 0, count: 5 };
        return { type: "done", id: 0 };
      },
    ),
    sendStreaming: vi.fn(
      (
        msg: Record<string, unknown>,
        onMessage: (r: WorkerResponse) => void,
      ): Promise<void> => {
        opts.trace.push(String(msg.type));
        onMessage({ type: "done", id: 0 });
        return Promise.resolve();
      },
    ),
    notify: vi.fn((msg: Record<string, unknown>) =>
      opts.trace.push(`notify:${String(msg.type)}`),
    ),
    terminate,
  };
  return { client: client as unknown as WorkerClient, terminate };
}

/** Lets every pending microtask (and the commit's awaited worker round trips)
 *  run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("StreamLayerRegistry.openStream", () => {
  const openOpts = { id: "L1", source: { url: "https://example/x.fcb" } };

  it("resolves the geoid BEFORE the open that establishes the worker's placement, and sends it there", async () => {
    const trace: string[] = [];
    const { client } = makeFakeClient({ trace });
    const r = makeRegistry({
      createClient: () => client,
      getPickRays: () => topDownRays(),
      sampleGeoidHeight: async () => {
        trace.push("geoid");
        return GEOID_M;
      },
    });

    const handle = await r.openStream(openOpts);
    await flush();

    // The MUST from Task C5: no cell can be requested until the offset the
    // worker bakes with is known, because re-placing a streaming layer would
    // mean re-decoding every resident cell.
    expect(trace.slice(0, 4)).toEqual([
      "open:undefined",
      "geoid",
      `open:${GEOID_M}`,
      "probe",
    ]);
    expect(trace).toContain("fetch");
    expect(trace.indexOf("fetch")).toBeGreaterThan(
      trace.indexOf(`open:${GEOID_M}`),
    );
    // ...and the same offset reaches the handle, which rebuilds each cell's
    // ENU frame with it (a disagreement floats or sinks every cell).
    expect(handle.getBoundsGeodetic()).toBeNull(); // no cell resident yet
    expect(handle.frame.matrix).toEqual(
      makeEnuFrame(...centreLngLat(), GEOID_M).matrix,
    );
  });

  it("a caller-supplied heightOffset wins outright and costs a single open", async () => {
    const trace: string[] = [];
    const { client } = makeFakeClient({ trace });
    const sample = vi.fn(async () => 999);
    const r = makeRegistry({
      createClient: () => client,
      getPickRays: () => null,
      sampleGeoidHeight: sample,
    });

    const handle = await r.openStream({ ...openOpts, heightOffset: 12 });
    expect(sample).not.toHaveBeenCalled();
    expect(trace.filter((t) => t.startsWith("open:"))).toEqual(["open:12"]);
    expect(handle.frame.matrix).toEqual(
      makeEnuFrame(...centreLngLat(), 12).matrix,
    );
  });

  it("refuses an unsupported CRS and terminates the worker", async () => {
    for (const epsg of [null, 424242]) {
      const trace: string[] = [];
      const { client, terminate } = makeFakeClient({ trace, epsg });
      const r = makeRegistry({
        createClient: () => client,
        getPickRays: () => null,
      });
      await expect(r.openStream(openOpts)).rejects.toThrow(
        `Cannot georeference "L1": unsupported CRS (EPSG:${epsg ?? "unknown"})`,
      );
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(r.handles()).toEqual([]);
      // Nothing was fetched, and the placement open never happened.
      expect(trace.filter((t) => t.startsWith("open:"))).toEqual([
        "open:undefined",
      ]);
    }
  });

  it("refuses an admission failure with the worker's own message, and terminates", async () => {
    const trace: string[] = [];
    const { client, terminate } = makeFakeClient({
      trace,
      admission: {
        code: "no-index",
        message: "This file has no spatial index, so it cannot be streamed.",
      },
    });
    const r = makeRegistry({
      createClient: () => client,
      getPickRays: () => null,
    });
    await expect(r.openStream(openOpts)).rejects.toThrow(
      "This file has no spatial index",
    );
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("refuses a header with no extent, and terminates", async () => {
    const trace: string[] = [];
    const { client, terminate } = makeFakeClient({ trace, extent: undefined });
    // `extent: undefined` in the fake means "use EXTENT", so nudge it to a
    // genuinely absent one.
    (client.send as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        type: "opened",
        id: 0,
        header: { version: "2.0", epsg: EPSG },
        admission: null,
      }),
    );
    const r = makeRegistry({
      createClient: () => client,
      getPickRays: () => null,
    });
    await expect(r.openStream(openOpts)).rejects.toThrow(
      "no usable geographical extent",
    );
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("refuses a duplicate layer id without opening a worker", async () => {
    const trace: string[] = [];
    const { client } = makeFakeClient({ trace });
    const createClient = vi.fn(() => client);
    const r = makeRegistry({
      createClient,
      getPickRays: () => null,
      sampleGeoidHeight: async () => GEOID_M,
    });
    await r.openStream(openOpts);
    await expect(r.openStream(openOpts)).rejects.toThrow(
      'a layer with id "L1" is already registered',
    );
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("seeds visibility and rules before the first commit", async () => {
    const trace: string[] = [];
    const { client } = makeFakeClient({ trace });
    const r = makeRegistry({
      createClient: () => client,
      getPickRays: () => topDownRays(),
      sampleGeoidHeight: async () => GEOID_M,
    });

    const handle = await r.openStream({
      ...openOpts,
      rules: [
        {
          id: "r1",
          name: "roofs",
          color: "#ff0000",
          logic: "AND",
          conditions: [],
          enabled: true,
        },
      ],
      rulesEnabled: true,
      visible: false,
    });
    await flush();

    expect(handle.visible).toBe(false);
    // The fetch the initial commit dispatched carries the seeded rules — an
    // unseeded handle defaults to rulesEnabled:false and would bake no rule
    // colours into the very first cells (C10a/C10b ledger).
    const fetches = (
      client.sendStreaming as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(fetches.at(-1)).toMatchObject({ type: "fetch", rulesEnabled: true });
    expect((fetches.at(-1)!.rules as unknown[]).length).toBe(1);
  });

  it("registers the layer under the settle loop, and a LoD change forces a commit", async () => {
    const trace: string[] = [];
    const view = new FakeView();
    const { client } = makeFakeClient({ trace });
    const r = makeRegistry({
      createClient: () => client,
      getPickRays: () => topDownRays(),
      sampleGeoidHeight: async () => GEOID_M,
    });
    r.attach(view);

    const handle = await r.openStream(openOpts);
    await flush();
    expect(r.getHandle("L1")).toBe(handle);

    const probesAfterOpen = trace.filter((t) => t === "probe").length;
    // No camera movement at all — hysteresis would skip this, so without the
    // forced commit the old LoD would stay resident indefinitely (B1).
    handle.setLod("manual", "2.2");
    await flush();
    expect(trace.filter((t) => t === "probe").length).toBe(probesAfterOpen + 1);

    // And it is under the settle loop: a user gesture commits it too.
    view.gesture();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 50));
    expect(trace.filter((t) => t === "probe").length).toBe(probesAfterOpen + 2);

    r.remove("L1");
    expect(trace).toContain("terminate");
  });
});
