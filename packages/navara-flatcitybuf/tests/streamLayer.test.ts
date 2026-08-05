/**
 * Tasks C10a/C10b: `FcbStreamLayerHandle`'s commit loop, and the recolor /
 * LoD / interaction-parity surface built on top of it.
 *
 * These are the driver-level regressions from the app's
 * `tests/unit/features/streaming/useTileStreaming.test.ts` (B1 ladder, B5
 * sparse backfill, the epoch guard, the too-far and worker-rejection paths),
 * ported onto `handle.commit(rays)` — no React, no
 * OrbitControls, no store. The camera is four ECEF pick rays; everything the
 * old hook read from Zustand is now the handle's own state.
 *
 * Engine-free: the mesh factory is injected as a recording fake implementing
 * the REAL `CityMeshHandle`, so nothing here reaches `@navaramap/*` (Global
 * Constraints -> Testing conventions).
 *
 * Cell keys are never hardcoded. `chooseLevel` picks the level from the real
 * footprint, so the desired cover is a property of the fixture geometry;
 * every case reads the keys it needs off the fetch request the handle
 * actually sent.
 */
import { describe, it, expect, vi } from "vitest";
import {
  enuToEcef,
  makeEnuFrame,
  srgbHexToLinear,
  type Rule,
} from "@cityjson/navara-core";
import {
  HIGHLIGHT_COLOR_HEX,
  type CityMeshHandle,
  type Selection,
} from "@cityjson/navara-cityjson";
import {
  FcbStreamLayerHandle,
  type CellEntry,
  type StreamStatus,
} from "../src/streamLayer";
import { CellCache } from "../src/cellCache";
import type { CellMeshFactory } from "../src/cellMeshes";
import { keysCovering, type CellKey, type Grid } from "../src/tileGrid";
import { chooseLevel } from "../src/levelPolicy";
import type { FcbHeaderModel } from "../src/fcbSource";
import { viewportFootprint, type Ray } from "../src/viewportFootprint";
import type { PickRaySource } from "../src/navaraRays";
import type { WorkerClient } from "../src/workerClient";
import type { WorkerResponse } from "../src/workerProtocol";
import {
  RESIDENT_BYTE_BUDGET,
  RESIDENT_TRIANGLE_BUDGET,
  VIEWPORT_FEATURE_BUDGET,
} from "../src/constants";

const FRAME = makeEnuFrame(4.3571, 52.0116, 0);
const GRID: Grid = {
  originX: -5000,
  originY: -5000,
  rootCell: 10000,
  maxLevel: 8,
};
const HEADER: FcbHeaderModel = {
  version: "1.0",
  featuresCount: 100,
  extent: [-5000, -5000, 0, 5000, 5000, 50],
  referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/28992",
  epsg: 28992,
};

/** Four downward rays from `height` metres up, spanning +-`half` metres around
 *  ENU (cx, cy) — the ENU equivalent of the old top-down PerspectiveCamera
 *  fixture. */
function raysFrom(
  height: number,
  half: number,
  cx = 0,
  cy = 0,
): readonly [Ray, Ray, Ray, Ray] {
  const eye: readonly [number, number, number] = [cx, cy, height];
  const corner = (x: number, y: number): Ray => {
    const o = enuToEcef(FRAME, eye);
    const t = enuToEcef(FRAME, [x, y, 0]);
    const d = [t[0] - o[0], t[1] - o[1], t[2] - o[2]] as const;
    const len = Math.hypot(d[0], d[1], d[2]);
    return { origin: o, direction: [d[0] / len, d[1] / len, d[2] / len] };
  };
  return [
    corner(cx - half, cy - half),
    corner(cx + half, cy - half),
    corner(cx + half, cy + half),
    corner(cx - half, cy + half),
  ];
}
const topDownRays = () => raysFrom(500, 400);

/** Deliberately a plain linearisation around the frame origin rather than a
 *  real proj4 inverse: `viewportFootprint`'s CRS step has its own tests, and
 *  this file is about the handle. */
const TO_SOURCE_XY = (lng: number, lat: number) =>
  [(lng - FRAME.lngDeg) * 68000, (lat - FRAME.latDeg) * 111000] as const;
const TO_LNG_LAT = (x: number, y: number) =>
  [FRAME.lngDeg + x / 68000, FRAME.latDeg + y / 111000] as const;

/**
 * The cell cover a commit from `rays` MUST fetch, computed from the fixture
 * geometry rather than read back off the request. Pins "the fetch asks for
 * exactly the footprint's cover at the chosen level" — without it, every
 * key-derived assertion in this file is self-consistent with whatever the
 * handle happened to ask for, including nothing at all.
 */
function coverFor(rays: readonly [Ray, Ray, Ray, Ray]): CellKey[] {
  const footprint = viewportFootprint({
    cornerRays: rays,
    frame: FRAME,
    toSourceXY: TO_SOURCE_XY,
  });
  if (!footprint) throw new Error("fixture rays produced no footprint");
  const level = chooseLevel(GRID, footprint.bbox);
  if (level === null) throw new Error("fixture footprint chose no level");
  return keysCovering(GRID, footprint.bbox, level);
}

/** One triangle, with `objectKey` as its only object — distinct per cell, so
 *  a pick assertion can tell which cell answered. */
function geom(triangleCount: number, objectKey = "B1") {
  const v = triangleCount * 3;
  return {
    positions: new Float32Array(v * 3).fill(1),
    normals: new Float32Array(v * 3).fill(2),
    baseColors: new Float32Array(v * 3).fill(0.25),
    ruleColors: null,
    objectIndices: new Uint32Array(v).fill(0),
    surfaceIndices: new Uint32Array(v).fill(0),
    objectKeys: [objectKey],
    triangleCount,
  };
}
/** Vertex count of the fixture cell above — the length every colour buffer
 *  the fake worker returns must match. */
const CELL_COLOR_LEN = 1 * 3 * 3;

interface FakeClientOpts {
  /** Requested cells the worker genuinely finds nothing in, BY REQUEST ORDER
   *  — the real keys depend on `chooseLevel`, so a test names positions, not
   *  keys. Mirrors the worker's "only a POPULATED bucket gets a 'cell'
   *  message" contract (fcb.worker.ts), which is exactly what B5 is about. */
  readonly emptyCellIndices?: readonly number[];
  readonly lodsSeen?: string[];
  readonly probeCount?: number;
  readonly probeDelayMs?: number;
  /** Delays a `fetch` before it delivers anything. Set beyond the retired
   *  1500 ms swap deadline to prove a slow commit still lands. */
  readonly fetchDelayMs?: number;
  /** Runs after a `fetch` request has been dispatched but before any cell is
   *  delivered — the only point at which a test can change the layer's rules
   *  "while the fetch is in flight" (B2). */
  readonly onFetchDispatched?: () => void;
  /** Held before a `recolor` request's responses are delivered, so a test can
   *  make the world change underneath an in-flight recolor. */
  readonly recolorGate?: Promise<void>;
  /** Every vertex component of the colours the fake worker bakes for a
   *  `recolor` (exactly representable, so `toEqual` is safe). */
  readonly recolorValue?: number;
  /** What a `surfaces` request resolves with. Absent = the worker's
   *  "not resident in any cached cell" error response. */
  readonly surfaces?: ReadonlyArray<unknown>;
}

function makeFakeClient(opts: FakeClientOpts) {
  let epoch = 0;
  const sendCalls: Array<Record<string, unknown>> = [];
  const sendStreamingCalls: Array<Record<string, unknown>> = [];
  const notifyCalls: Array<Record<string, unknown>> = [];
  const empty = new Set(opts.emptyCellIndices ?? []);

  const send = vi.fn(async (msg: Record<string, unknown>) => {
    sendCalls.push(msg);
    if (opts.probeDelayMs !== undefined) {
      await new Promise((r) => setTimeout(r, opts.probeDelayMs));
    }
    if (msg.type === "probe") {
      return {
        type: "probed",
        id: 0,
        count: opts.probeCount ?? 5,
      } satisfies WorkerResponse;
    }
    if (msg.type === "surfaces") {
      // Mirrors fcb.worker.ts: an object resident in no cached cell comes
      // back as an 'error' response, NOT as a rejection.
      return opts.surfaces
        ? ({
            type: "surfaceData",
            id: 0,
            objectId: msg.objectId as string,
            surfaces: opts.surfaces as unknown[],
          } satisfies WorkerResponse)
        : ({
            type: "error",
            id: 0,
            message: `object not resident in any cached cell: ${String(msg.objectId)}`,
            code: "not-found",
            aborted: false,
          } satisfies WorkerResponse);
    }
    return { type: "done", id: 0 } satisfies WorkerResponse;
  });

  const sendStreaming = vi.fn(
    (
      msg: Record<string, unknown>,
      onMessage: (r: WorkerResponse) => void,
    ): Promise<void> => {
      sendStreamingCalls.push(msg);
      const cells = msg.cells as string[];

      if (msg.type === "recolor") {
        // Mirrors fcb.worker.ts's handler: one 'recolored' per still-cached
        // cell, then 'done'.
        const deliver = () => {
          for (const key of cells) {
            onMessage({
              type: "recolored",
              id: 0,
              key,
              ruleColors: new Float32Array(CELL_COLOR_LEN).fill(
                opts.recolorValue ?? 0.5,
              ),
            });
          }
          onMessage({ type: "done", id: 0 });
        };
        if (!opts.recolorGate) {
          deliver();
          return Promise.resolve();
        }
        return opts.recolorGate.then(deliver);
      }

      opts.onFetchDispatched?.();
      const deliverCells = () =>
        cells.forEach((key, i) => {
          if (empty.has(i)) return;
          onMessage({
            type: "cell",
            id: 0,
            key,
            // A distinct object per cell: `resolvePick` must be provably
            // answering from the cell it says it is.
            geometry: geom(1, `B_${key}`),
            objects: [],
            surfaceAttrKeys: [],
            lodsSeen: opts.lodsSeen ?? [],
          });
        });
      const finish = (): Promise<void> => {
        deliverCells();
        onMessage({ type: "done", id: 0 });
        return Promise.resolve();
      };
      return opts.fetchDelayMs === undefined
        ? finish()
        : new Promise<void>((r) => setTimeout(r, opts.fetchDelayMs)).then(
            finish,
          );
    },
  );

  const notify = vi.fn((msg: Record<string, unknown>) => {
    notifyCalls.push(msg);
  });

  const terminate = vi.fn();
  const client = {
    newEpoch: vi.fn(() => ++epoch),
    isCurrent: vi.fn((e: number) => e === epoch),
    send,
    sendStreaming,
    notify,
    terminate,
  };
  return {
    client: client as unknown as WorkerClient,
    send,
    sendStreaming,
    notify,
    terminate,
    sendCalls,
    sendStreamingCalls,
    notifyCalls,
  };
}

/** Requests of one kind, in the order they were dispatched. */
const requestsOfType = (
  calls: ReadonlyArray<Record<string, unknown>>,
  type: string,
) => calls.filter((m) => m.type === type);

/** Recording mesh factory implementing the REAL `CityMeshHandle`, so a member
 *  added to the shared contract breaks this file loudly. */
function recordingFactory() {
  const created: Array<{ key: string; entry: CellEntry; deleted: boolean }> =
    [];
  const factory: CellMeshFactory = {
    create(key, entry) {
      const rec = { key, entry, deleted: false };
      created.push(rec);
      const handle: CityMeshHandle = {
        ref: null,
        setColors: vi.fn(),
        setVisible: vi.fn(),
        triangleCount: () => entry.geometry.triangleCount,
        batchIdMap: () => [],
        resolveRaycast: () => null,
        delete: () => {
          rec.deleted = true;
        },
      };
      return handle;
    },
  };
  return { factory, created };
}

/**
 * A mesh factory whose handles record what they were told, and whose raycast
 * answers for the nominated cells at the nominated ray distances — enough to
 * drive `resolvePick` and `setHighlight` without a renderer.
 * `hitDistances` maps cellKey -> metres; a cell absent from it never hits.
 *
 * `created` is the LATEST record per key; `all` keeps every record ever made,
 * including the ones a rebuild replaced — which is the only way to prove a
 * response was NOT applied to a superseded handle.
 */
function pickingFactory(hitDistances: Readonly<Record<string, number>> = {}) {
  interface Rec {
    readonly key: string;
    colors: Float32Array | null;
    visible: boolean;
    deleted: boolean;
    readonly objectKeys: readonly string[];
  }
  const created = new Map<string, Rec>();
  const all: Rec[] = [];
  const factory: CellMeshFactory = {
    create(key, entry) {
      const rec: Rec = {
        key,
        colors: null,
        visible: true,
        deleted: false,
        objectKeys: entry.geometry.objectKeys,
      };
      created.set(key, rec);
      all.push(rec);
      const handle: CityMeshHandle = {
        ref: null,
        setColors: (c: Float32Array) => {
          rec.colors = c;
        },
        setVisible: (v: boolean) => {
          rec.visible = v;
        },
        triangleCount: () => 7,
        batchIdMap: () => [{ objectIndex: 0, surfaceIndex: 4 }],
        resolveRaycast: () =>
          key in hitDistances
            ? { objectIndex: 0, surfaceIndex: 4, distance: hitDistances[key]! }
            : null,
        delete: () => {
          rec.deleted = true;
        },
      };
      return handle;
    },
  };
  return { factory, created, all };
}

/** Any well-formed ECEF ray: the picking factory's `resolveRaycast` ignores
 *  it, so the interaction tests are about the nearest-hit arbitration, not the
 *  ray maths (which `navaraRays`/`viewportFootprint` own). */
const FAKE_PICK_RAYS: PickRaySource = {
  width: 800,
  height: 600,
  getPickRay: () => ({ origin: [0, 0, 0], direction: [0, 0, -1] }),
};

/** The same ray in the shape `resolveRaycast` takes (the app's router hands it
 *  an ECEF ray it built itself, not a screen point). */
const DOWNWARD_RAY = {
  origin: { x: 0, y: 0, z: 0 },
  direction: { x: 0, y: 0, z: -1 },
};

function makeHandle(
  opts: FakeClientOpts & {
    meshFactory?: CellMeshFactory;
    pickRays?: PickRaySource | null;
    onLodChanged?: () => void;
    /** The vertical-datum offset every cell is placed with. 0 unless a test is
     *  specifically about it, so the bounds assertions stay readable. */
    heightOffsetM?: number;
  },
) {
  const fake = makeFakeClient(opts);
  const meshes = recordingFactory();
  const handle = new FcbStreamLayerHandle({
    id: "l1",
    client: fake.client,
    grid: GRID,
    header: HEADER,
    cache: new CellCache<CellEntry>({
      maxTriangles: RESIDENT_TRIANGLE_BUDGET,
      maxBytes: RESIDENT_BYTE_BUDGET,
    }),
    frame: FRAME,
    toSourceXY: TO_SOURCE_XY,
    toLngLat: TO_LNG_LAT,
    heightOffsetM: opts.heightOffsetM ?? 0,
    // Injected, so streamLayer.ts never imports addCityMeshArrays and
    // therefore never reaches @navaramap/*. Task C11 supplies the real one.
    meshFactory: opts.meshFactory ?? meshes.factory,
    pickRays: opts.pickRays === undefined ? FAKE_PICK_RAYS : opts.pickRays,
    onLodChanged: opts.onLodChanged,
  });
  return { handle, client: fake, meshes };
}

/** Lets every already-settled microtask run — the fire-and-forget recolor
 *  round trip `setRules`/`syncMeshes` kick off. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("FcbStreamLayerHandle.commit", () => {
  it("backfills a zero-triangle entry for a requested cell the worker found empty, so it counts as resident (B5)", async () => {
    const { handle, client } = makeHandle({ emptyCellIndices: [0] });
    await handle.commit(topDownRays());

    const requested = client.sendStreamingCalls[0]!.cells as string[];
    expect(requested.length).toBeGreaterThan(1);
    const sparseKey = requested[0]!;
    // Resident even though the worker never sent a 'cell' message for it.
    expect(handle.cacheKeysForTest()).toContain(sparseKey);

    const after = client.sendStreamingCalls.length;
    await handle.commit(topDownRays());
    // Hysteresis now applies: no second fetch for an unmoved, hole-free view.
    expect(client.sendStreamingCalls.length).toBe(after);
    expect(handle.status).toBe("idle");
  });

  it("folds each commit's observed LoD labels into the persisted ladder (B1)", async () => {
    const { handle } = makeHandle({ lodsSeen: ["1.2", "2.2"] });
    const seen: Array<ReadonlyArray<string>> = [];
    handle.onLadder((l) => seen.push(l));
    await handle.commit(topDownRays());
    expect(handle.ladder).toEqual(["1.2", "2.2"]);
    expect(seen).toHaveLength(1);
  });

  it("does not emit a ladder update when a later commit observes no NEW label", async () => {
    const { handle, client } = makeHandle({ lodsSeen: ["2.2"] });
    await handle.commit(topDownRays());
    expect(handle.ladder).toEqual(["2.2"]);

    const seen: Array<ReadonlyArray<string>> = [];
    handle.onLadder((l) => seen.push(l));
    await handle.commit(topDownRays());
    // A real second fetch happened (the ladder learned in commit 1 changes the
    // auto LoD selection, which is a swap) — so this is "fetched again and
    // observed nothing new", not "skipped".
    expect(client.sendStreamingCalls).toHaveLength(2);
    expect(seen).toHaveLength(0);
    expect(handle.ladder).toEqual(["2.2"]);
  });

  it(
    "a swap fetch slower than the retired 1500 ms deadline still commits, so the layer cannot livelock (2026-08-05)",
    async () => {
      // THE REGRESSION. Reported as "FlatCityBuf doesn't load when I move the
      // camera; only when I switch LoD it loads once".
      //
      // A layer's SECOND commit is always a swap: commit 1 runs with an empty
      // ladder, so the auto LoD resolves to `{kind:"all"}` and that is what is
      // recorded as the previous selection; the ladder is only LEARNED from
      // the cells commit 1 returns, after which the same camera resolves to an
      // exact label. `planCommit` calls that a swap.
      //
      // A swap used to be raced against LEVEL_SWAP_TIMEOUT_MS (1500 ms), and
      // the timeout path returned BEFORE recording the level/LoD/view it had
      // planned — so the next settle recomputed the identical doomed swap and
      // the layer never loaded anything again. This pins the fix: a slow swap
      // is WAITED OUT, adopted, and recorded.
      const opts = { lodsSeen: ["1.2", "2.2"], fetchDelayMs: 0 };
      const { handle, client } = makeHandle(opts);
      await handle.commit(topDownRays());
      const firstCover = handle.cacheKeysForTest();
      expect(firstCover.length).toBeGreaterThan(0);
      expect(handle.ladder).toEqual(["1.2", "2.2"]);
      // Commit 1 asked for everything: the ladder was empty, so there was no
      // label to filter on.
      expect(client.sendStreamingCalls[0]!.lod).toBeNull();

      // Well past the old deadline, from the same camera.
      opts.fetchDelayMs = 1500 + 400;
      await handle.commit(topDownRays());

      // The swap happened: a second fetch went out, under the LEARNED label,
      // and it was adopted rather than cancelled and rolled back.
      expect(client.sendStreamingCalls).toHaveLength(2);
      expect(client.sendStreamingCalls[1]!.lod).toBe("1.2");
      expect(client.notifyCalls).not.toContainEqual(
        expect.objectContaining({ type: "cancel" }),
      );
      expect(handle.status).toBe("idle");
      expect(handle.cacheKeysForTest().sort()).toEqual([...firstCover].sort());

      // And it CONVERGED — the whole point. The LoD decision is now recorded,
      // so a third commit from the same camera is an ordinary hysteresis skip,
      // not a third doomed swap.
      await handle.commit(topDownRays());
      expect(client.sendStreamingCalls).toHaveLength(2);
      expect(handle.status).toBe("idle");
    },
    10_000,
  );

  it("a slow FIRST fetch still commits (the M7.5 auto-fit case)", async () => {
    // `planCommit` calls every initial load a swap (`prevLevel` is null, so
    // `levelChanged` is true). When swaps were raced, a slow first fetch
    // produced an EMPTY layer and an error status with no previous level to
    // fall back to — the M7.5 browser smoke's "auto-fit frames the whole file,
    // host is slow, nothing ever renders".
    const { handle, client } = makeHandle({ fetchDelayMs: 1700 });
    await handle.commit(topDownRays());

    expect(handle.status).toBe("idle");
    expect(handle.level).not.toBeNull();
    expect(handle.cacheKeysForTest().length).toBeGreaterThan(0);
    expect(client.notifyCalls).not.toContainEqual(
      expect.objectContaining({ type: "cancel" }),
    );
  });

  it("discards a stale commit whose probe response arrives after abortInFlight() bumped the epoch", async () => {
    const { handle, client } = makeHandle({ probeDelayMs: 20 });
    const p = handle.commit(topDownRays());
    handle.abortInFlight();
    await p;
    expect(client.sendStreamingCalls).toHaveLength(0);
    expect(client.notifyCalls).toContainEqual(
      expect.objectContaining({ type: "cancel" }),
    );
  });

  it("reports too-far with a reason when the probe exceeds VIEWPORT_FEATURE_BUDGET", async () => {
    const { handle } = makeHandle({ probeCount: VIEWPORT_FEATURE_BUDGET + 1 });
    const statuses: Array<[StreamStatus, string | null]> = [];
    handle.onStatus((s, m) => statuses.push([s, m]));
    await handle.commit(topDownRays());
    expect(statuses.at(-1)![0]).toBe("too-far");
    expect(statuses.at(-1)![1]).toMatch(/feature-budget/);
  });

  it("surfaces a worker rejection as an error status instead of an unhandled rejection", async () => {
    const { handle, client } = makeHandle({});
    client.send.mockRejectedValueOnce(new Error("WorkerClient terminated"));
    const statuses: Array<[StreamStatus, string | null]> = [];
    handle.onStatus((s, m) => statuses.push([s, m]));
    await expect(handle.commit(topDownRays())).resolves.toBeUndefined();
    expect(statuses.at(-1)).toEqual(["error", "WorkerClient terminated"]);
  });

  it("builds one mesh per resident cell through the INJECTED factory, stamps the layer id on its picking index, and bumps the version once", async () => {
    const { handle, client, meshes } = makeHandle({});
    const commits: number[] = [];
    handle.onCommit((v) => commits.push(v));
    await handle.commit(topDownRays());

    const requested = client.sendStreamingCalls[0]!.cells as string[];
    // Pinned to the footprint's real cover, not just to itself: the mesh
    // assertion below compares two numbers the handle produced, so without
    // this an implementation that fetched nothing would satisfy both.
    expect([...requested].sort()).toEqual(coverFor(topDownRays()).sort());
    expect(meshes.created.map((c) => c.key).sort()).toEqual(
      [...requested].sort(),
    );
    expect(handle.version).toBe(1);
    expect(commits).toEqual([1]);
    expect(handle.level).not.toBeNull();
    for (const cell of handle.cellsForTest().values()) {
      expect(cell.pickingIndex.layerId).toBe("l1");
    }
    // The B2 hand-off is wired but must stay quiet here: every arriving cell
    // was baked with the rules that were current at dispatch, so nothing is
    // stale and no recolor round trip is made. (The positive case is the
    // "rules edited mid-fetch" test below.)
    expect(
      client.sendStreamingCalls.filter((m) => m.type === "recolor"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Task C10b: worker-baked recolor, LoD control, lifecycle, and the
// interaction-parity surface.
// ---------------------------------------------------------------------

const RULE_G: Rule = {
  id: "r",
  name: "n",
  color: "#0f0",
  conditions: [],
  logic: "AND",
  enabled: true,
};

/** The base colour every fixture cell is baked with (`geom`). */
const BASE = 0.25;
/** What a cell would render right now: whatever it was last told, or — if it
 *  was never told anything — the colours it was built with. Keeps the
 *  assertions independent of WHETHER an unaffected cell got a redundant
 *  `setColors`, and dependent only on what it would show. */
const rendered = (rec: { colors: Float32Array | null }): number[] => [
  ...(rec.colors ?? new Float32Array(CELL_COLOR_LEN).fill(BASE)),
];

/** A pan far enough east to expose new cells while keeping the old ones
 *  resident (`commitNormal` never evicts outside the cover). */
const pannedRays = () => raysFrom(500, 400, 600, 0);

describe("FcbStreamLayerHandle rules and LoD", () => {
  it("stamps every cached entry — real AND backfilled — with the rules active at dispatch time (B2)", async () => {
    const { handle } = makeHandle({ emptyCellIndices: [0] });
    handle.setRules([RULE_G], true);
    await handle.commit(topDownRays());

    const keys = handle.cacheKeysForTest();
    expect(keys.length).toBeGreaterThan(1);
    for (const key of keys) {
      const e = handle.cacheEntryForTest(key)!;
      expect(e.builtWithRulesEnabled).toBe(true);
      expect(e.builtWithRules).toEqual([RULE_G]);
    }
    // Exactly one of them came back with no 'cell' message at all (B5's
    // backfill) and is stamped identically — otherwise it would look stale
    // forever and be recolored on every commit.
    const backfilled = keys.filter(
      (k) => handle.cacheEntryForTest(k)!.geometry.triangleCount === 0,
    );
    expect(backfilled).toHaveLength(1);
  });

  it("recolors, through the worker, exactly the cells whose fetch landed after the rules changed (B2)", async () => {
    const factory = pickingFactory();
    let onDispatch: (() => void) | null = null;
    const { handle, client } = makeHandle({
      meshFactory: factory.factory,
      onFetchDispatched: () => onDispatch?.(),
    });
    await handle.commit(topDownRays());
    const residentBefore = handle.cacheKeysForTest();

    // The user edits a rule after the second commit's fetch has been
    // dispatched: those cells are already being baked with the OLD rules.
    onDispatch = () => handle.setRules([RULE_G], true);
    await handle.commit(pannedRays());
    await flush();

    const fetches = requestsOfType(client.sendStreamingCalls, "fetch");
    const recolors = requestsOfType(client.sendStreamingCalls, "recolor");
    expect(recolors).toHaveLength(2);

    // #1 is `setRules`' own call: every cell resident at that moment.
    expect([...(recolors[0]!.cells as string[])].sort()).toEqual(
      [...residentBefore].sort(),
    );
    // #2 is the B2 hand-off from the mesh sync: ONLY the cells that landed
    // carrying the stale bake — not every resident cell all over again. The
    // pan is a NORMAL commit (holes only), so "the cells that landed" is a
    // strict subset of both the new cover and the resident set — which is
    // what makes the assertion below a targeting assertion at all.
    const landed = fetches[1]!.cells as string[];
    expect(landed.length).toBeLessThan(coverFor(pannedRays()).length);
    expect(landed.length).toBeLessThan(handle.cacheKeysForTest().length);
    expect([...(recolors[1]!.cells as string[])].sort()).toEqual(
      [...landed].sort(),
    );
    expect(recolors[1]!.rules).toEqual([RULE_G]);
    expect(recolors[1]!.rulesEnabled).toBe(true);

    // ...and the worker's colours actually reached the meshes.
    for (const key of landed) {
      expect(rendered(factory.created.get(key)!)).toEqual(
        new Array(CELL_COLOR_LEN).fill(0.5),
      );
    }
  });

  it("discards a recolor response for a cell that was rebuilt under the same key while the request was in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const factory = pickingFactory();
    const { handle } = makeHandle({
      meshFactory: factory.factory,
      recolorGate: gate,
      recolorValue: 0.5,
    });
    await handle.commit(topDownRays());

    handle.setRules([RULE_G], true); // dispatched; responses held by the gate
    const superseded = [...factory.all];
    expect(superseded.length).toBeGreaterThan(0);

    // A LoD change is a swap: the whole cover is refetched and every cell is
    // rebuilt under its OWN key, with a brand new mesh.
    handle.setLod("manual", "2.2");
    await handle.commit(topDownRays());
    expect(factory.all.length).toBeGreaterThan(superseded.length);

    release();
    await flush();

    // Every response was computed for geometry that no longer exists: neither
    // the superseded meshes nor — the bug this guards — the new ones may be
    // painted from it.
    for (const rec of factory.all) expect(rec.colors).toBeNull();
    for (const rec of superseded) expect(rec.deleted).toBe(true);
  });

  it("a recolor does not wipe an active highlight", async () => {
    const factory = pickingFactory();
    const { handle } = makeHandle({ meshFactory: factory.factory });
    await handle.commit(topDownRays());

    const [ownerKey, otherKey] = [...factory.created.keys()] as [
      string,
      string,
    ];
    const objectId = factory.created.get(ownerKey)!.objectKeys[0]!;
    handle.setHighlight([{ kind: "object", layerId: "l1", objectId }]);

    handle.setRules([RULE_G], true);
    await flush();

    // Every unselected cell takes the worker's new rule colours...
    expect(rendered(factory.created.get(otherKey)!)).toEqual(
      new Array(CELL_COLOR_LEN).fill(0.5),
    );
    // ...and the selected one keeps the highlight layered OVER them. Writing
    // the response straight to `setColors` would clear it until the next
    // pointer move.
    const highlight = srgbHexToLinear(HIGHLIGHT_COLOR_HEX);
    expect(rendered(factory.created.get(ownerKey)!)[0]!).toBeCloseTo(
      highlight[0]!,
      6,
    );
  });

  it("drops a no-op setRules instead of re-baking every resident cell", async () => {
    const { handle, client } = makeHandle({});
    await handle.commit(topDownRays());

    handle.setRules([], false); // identical to the handle's initial state
    await flush();
    expect(requestsOfType(client.sendStreamingCalls, "recolor")).toEqual([]);

    handle.setRules([RULE_G], true);
    await flush();
    expect(requestsOfType(client.sendStreamingCalls, "recolor")).toHaveLength(
      1,
    );
  });

  it("setLod forces a commit through onLodChanged, and only when the selection really changed", () => {
    const forced = vi.fn();
    const { handle } = makeHandle({ onLodChanged: forced });

    handle.setLod("manual", "2.2");
    expect(forced).toHaveBeenCalledTimes(1);
    handle.setLod("manual", "2.2");
    expect(forced).toHaveBeenCalledTimes(1); // nothing changed: no refetch
    handle.setLod("auto", null);
    expect(forced).toHaveBeenCalledTimes(2);
    expect(handle.lodMode).toBe("auto");
    expect(handle.selectedLod).toBeNull();
  });

  it("puts the manually selected LoD on the wire for the next fetch", async () => {
    const { handle, client } = makeHandle({});
    handle.setLod("manual", "2.2");
    await handle.commit(topDownRays());
    expect(requestsOfType(client.sendStreamingCalls, "fetch")[0]!.lod).toBe(
      "2.2",
    );
  });
});

describe("FcbStreamLayerHandle interaction parity", () => {
  it("triangleCount sums the RESIDENT cells, so the status bar is non-zero for an FCB-only workspace", async () => {
    const factory = pickingFactory();
    const { handle } = makeHandle({ meshFactory: factory.factory });
    expect(handle.triangleCount()).toBe(0);
    await handle.commit(topDownRays());
    expect(factory.created.size).toBeGreaterThan(0);
    expect(handle.triangleCount()).toBe(factory.created.size * 7);
  });

  it("getBoundsGeodetic reports the header extent from the moment the layer is open, before any commit", async () => {
    // NOT gated on the first commit: cells only become resident once the
    // camera is already close enough, so an FCB-only workspace could never
    // fly TO the layer if its bounds appeared only after it had arrived
    // (found by Task C14's browser smoke — "Fit all" was a no-op on the globe).
    const { handle } = makeHandle({ meshFactory: pickingFactory().factory });
    const before = handle.getBoundsGeodetic()!;
    expect(before.west).toBeGreaterThan(3.5);
    expect(before.east).toBeLessThan(5.5);

    await handle.commit(topDownRays());

    const b = handle.getBoundsGeodetic()!;
    // The commit does not move them: the extent is the whole file's, not the
    // resident cells' union.
    expect(b).toEqual(before);
    expect(b.west).toBeLessThan(b.east);
    expect(b.south).toBeLessThan(b.north);
    // Delft-ish, from the HEADER extent reprojected — this is what makes
    // fitLayer work for a streaming layer: the whole file's extent, not the
    // handful of cells the camera happens to be over.
    expect(b.west).toBeGreaterThan(3.5);
    expect(b.east).toBeLessThan(5.5);
    expect(b.minHeight).toBe(HEADER.extent![2]);
    expect(b.maxHeight).toBe(HEADER.extent![5]);
  });

  /** The keys a top-down commit makes resident, in commit order. Taken from a
   *  throwaway handle so the real assertions can nominate specific cells. */
  async function residentKeys(): Promise<string[]> {
    const probe = pickingFactory();
    const { handle } = makeHandle({ meshFactory: probe.factory });
    await handle.commit(topDownRays());
    return [...probe.created.keys()];
  }

  it("resolvePick raycasts the resident cells and returns a surface selection carrying THIS layer's id", async () => {
    const [hitKey] = await residentKeys();
    const factory = pickingFactory({ [hitKey!]: 120 });
    const { handle } = makeHandle({ meshFactory: factory.factory });
    await handle.commit(topDownRays());

    expect(handle.resolvePick({ x: 400, y: 300 })).toEqual({
      kind: "surface",
      layerId: "l1",
      objectId: factory.created.get(hitKey!)!.objectKeys[0]!,
      surfaceIndex: 4,
    });
  });

  it("returns the NEAREST hit when two resident cells overlap, not the first one committed", async () => {
    const keys = await residentKeys();
    expect(keys.length).toBeGreaterThan(1); // otherwise this proves nothing
    const [firstCommitted, secondCommitted] = keys as [string, string];

    // The cell committed SECOND is the nearer one. A first-hit-wins
    // implementation returns the far cell, because Map iteration is
    // insertion order.
    const factory = pickingFactory({
      [firstCommitted]: 900,
      [secondCommitted]: 120,
    });
    const { handle } = makeHandle({ meshFactory: factory.factory });
    await handle.commit(topDownRays());

    const nearObjectId = factory.created.get(secondCommitted)!.objectKeys[0]!;
    const farObjectId = factory.created.get(firstCommitted)!.objectKeys[0]!;
    // Guards against the fixture giving both cells the same objectId, which
    // would make the assertion below vacuous.
    expect(nearObjectId).not.toBe(farObjectId);
    expect(handle.resolvePick({ x: 400, y: 300 })).toEqual({
      kind: "surface",
      layerId: "l1",
      objectId: nearObjectId,
      surfaceIndex: 4,
    });
  });

  it("resolveRaycast answers with the nearest cell's hit AND its cellKey, so the app's cross-layer router can round-trip it", async () => {
    // The fourth `InteractionHandle` member (Task B15's `resolveNearestHit`
    // calls it on EVERY visible layer per mousemove). Without the cellKey the
    // router's follow-up `resolvePick` cannot tell which cell the indices came
    // from, and a streamed building would resolve to nothing.
    const keys = await residentKeys();
    const [far, near] = keys as [string, string];
    const factory = pickingFactory({ [far]: 900, [near]: 120 });
    const { handle } = makeHandle({ meshFactory: factory.factory });
    await handle.commit(topDownRays());

    const hit = handle.resolveRaycast(DOWNWARD_RAY);
    expect(hit).toEqual({
      objectIndex: 0,
      surfaceIndex: 4,
      distance: 120,
      cellKey: near,
    });

    // The exact round trip the app performs: nearest hit -> the winner
    // interprets its own indices.
    expect(
      handle.resolvePick({
        layerId: "l1",
        properties: {
          layerId: "l1",
          cellKey: hit!.cellKey,
          objectIndex: hit!.objectIndex,
          surfaceIndex: hit!.surfaceIndex,
        },
      }),
    ).toEqual({
      kind: "surface",
      layerId: "l1",
      objectId: factory.created.get(near)!.objectKeys[0]!,
      surfaceIndex: 4,
    });
  });

  it("publishes the vertical-datum offset its cells were placed with", async () => {
    // The cursor readout subtracts it to get the source file's own z back
    // (`layerHeightOffset`, app-side); a streaming layer that reported 0 would
    // read ~43 m high over a NAP model.
    const { handle } = makeHandle({ heightOffsetM: 43.2 });
    expect(handle.heightOffset()).toBe(43.2);
  });

  it("resolveRaycast is null when nothing is resident, or nothing is hit", async () => {
    const { handle } = makeHandle({ meshFactory: pickingFactory().factory });
    expect(handle.resolveRaycast(DOWNWARD_RAY)).toBeNull(); // no cells yet
    await handle.commit(topDownRays());
    expect(handle.resolveRaycast(DOWNWARD_RAY)).toBeNull(); // none hit
  });

  it("resolvePick returns null when no resident cell is hit, and when there is no ray source at all", async () => {
    const { handle } = makeHandle({ meshFactory: pickingFactory().factory });
    await handle.commit(topDownRays());
    expect(handle.resolvePick({ x: 400, y: 300 })).toBeNull();

    const keys = await residentKeys();
    const blind = makeHandle({
      meshFactory: pickingFactory({ [keys[0]!]: 10 }).factory,
      pickRays: null, // the plugin has not injected one (Task C4)
    });
    await blind.handle.commit(topDownRays());
    expect(blind.handle.resolvePick({ x: 400, y: 300 })).toBeNull();
  });

  it("resolves an already-indexed picked feature through its cellKey, and refuses another layer's", async () => {
    const factory = pickingFactory();
    const { handle } = makeHandle({ meshFactory: factory.factory });
    await handle.commit(topDownRays());
    const key = [...factory.created.keys()][0]!;
    const objectId = factory.created.get(key)!.objectKeys[0]!;

    expect(
      handle.resolvePick({
        properties: {
          layerId: "l1",
          cellKey: key,
          objectIndex: 0,
          surfaceIndex: 2,
        },
      }),
    ).toEqual({ kind: "surface", layerId: "l1", objectId, surfaceIndex: 2 });

    expect(
      handle.resolvePick({
        properties: {
          layerId: "OTHER",
          cellKey: key,
          objectIndex: 0,
          surfaceIndex: 2,
        },
      }),
    ).toBeNull();
    expect(
      handle.resolvePick({
        properties: { cellKey: "5/0/0", objectIndex: 0, surfaceIndex: 2 },
      }),
    ).toBeNull();
  });

  it("has NO batchId branch, and warns once about an unresolvable engine pick (C10b fold-in)", async () => {
    const factory = pickingFactory();
    // `batchIdMap()` here reports one entry — i.e. a batchId branch WOULD
    // resolve `batchId: 0` to `{objectIndex: 0, surfaceIndex: 4}`. It must
    // not: the spike measured PickableMeshWrapper allocating ONE uniform
    // batch id per MESH, so a batch id is not a triangle index and the match
    // could only ever be a coincidence. Deleted here exactly as on the static
    // path (`CityModelRegistry.resolvePick`, Task B7).
    const { handle } = makeHandle({ meshFactory: factory.factory });
    await handle.commit(topDownRays());
    const key = [...factory.created.keys()][0]!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      handle.resolvePick({ batchId: 0, properties: { cellKey: key } }),
    ).toBeNull();
    // The shape the engine actually delivers under `pickable-wrapper`:
    // `properties: null`, `layerId: undefined` (spike §3).
    expect(
      handle.resolvePick({ batchId: 4666372, properties: undefined }),
    ).toBeNull();
    // Once per layer, however many clicks arrive.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("[navara-flatcitybuf]");

    // A feature ROUTED AWAY is not an unresolvable pick — it belongs to
    // another layer, which is a normal outcome and must stay silent.
    const other = makeHandle({ meshFactory: pickingFactory().factory });
    await other.handle.commit(topDownRays());
    warn.mockClear();
    expect(
      other.handle.resolvePick({
        properties: { layerId: "OTHER", cellKey: key },
      }),
    ).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("paints a highlight set BEFORE the first commit onto the cells when they arrive (C10b fold-in)", async () => {
    const factory = pickingFactory();
    const { handle } = makeHandle({ meshFactory: factory.factory });

    // The real ordering the app produces: a share link (or a restored
    // session) applies its selection while the layer is still empty, and the
    // first cells land seconds later. Nothing revisits them afterwards, so if
    // the post-sync re-apply does not run, the selected object renders
    // unhighlighted until the user clicks something.
    const objectId = "B_5/14/14";
    handle.setHighlight([{ kind: "object", layerId: "l1", objectId }]);
    expect(factory.all).toHaveLength(0); // nothing resident yet

    await handle.commit(topDownRays());

    const owner = [...factory.created.values()].find((rec) =>
      rec.objectKeys.includes(objectId),
    );
    expect(owner).toBeDefined();
    const highlight = srgbHexToLinear(HIGHLIGHT_COLOR_HEX);
    expect(rendered(owner!)[0]!).toBeCloseTo(highlight[0]!, 6);
    // ...and only that cell.
    for (const rec of factory.all) {
      if (rec === owner) continue;
      expect(rendered(rec)).toEqual(new Array(CELL_COLOR_LEN).fill(BASE));
    }
  });

  it("setHighlight paints the selected object's cell and leaves every other cell at its base colours", async () => {
    const factory = pickingFactory();
    const { handle } = makeHandle({ meshFactory: factory.factory });
    await handle.commit(topDownRays());

    const [ownerKey, otherKey] = [...factory.created.keys()] as [
      string,
      string,
    ];
    const objectId = factory.created.get(ownerKey)!.objectKeys[0]!;
    handle.setHighlight([{ kind: "object", layerId: "l1", objectId }]);

    const highlight = srgbHexToLinear(HIGHLIGHT_COLOR_HEX);
    const painted = rendered(factory.created.get(ownerKey)!);
    for (let v = 0; v < CELL_COLOR_LEN; v += 3) {
      for (let c = 0; c < 3; c++) {
        expect(painted[v + c]!).toBeCloseTo(highlight[c]!, 6);
      }
    }
    expect(rendered(factory.created.get(otherKey)!)).toEqual(
      new Array(CELL_COLOR_LEN).fill(BASE),
    );

    // Clearing restores the base colours it was painted over.
    handle.setHighlight([]);
    expect(rendered(factory.created.get(ownerKey)!)).toEqual(
      new Array(CELL_COLOR_LEN).fill(BASE),
    );
  });

  it("RE-APPLIES the current highlight to a cell REBUILT by a later commit", async () => {
    const factory = pickingFactory();
    const { handle } = makeHandle({ meshFactory: factory.factory });
    await handle.commit(topDownRays());

    const key = [...factory.created.keys()][0]!;
    const objectId = factory.created.get(key)!.objectKeys[0]!;
    handle.setHighlight([{ kind: "object", layerId: "l1", objectId }]);
    const firstMesh = factory.created.get(key)!;

    // A LoD swap rebuilds every cell: the new mesh starts from the worker's
    // baked colours and must not render the selected object unhighlighted.
    handle.setLod("manual", "2.2");
    await handle.commit(topDownRays());
    const rebuilt = factory.created.get(key)!;
    expect(rebuilt).not.toBe(firstMesh);

    const highlight = srgbHexToLinear(HIGHLIGHT_COLOR_HEX);
    expect(rendered(rebuilt)[0]!).toBeCloseTo(highlight[0]!, 6);
  });

  it("ignores selections belonging to another layer", async () => {
    const factory = pickingFactory();
    const { handle } = makeHandle({ meshFactory: factory.factory });
    await handle.commit(topDownRays());
    handle.setHighlight([
      { kind: "object", layerId: "OTHER", objectId: "whatever" },
    ]);
    for (const rec of factory.all) {
      expect(rendered(rec)).toEqual(new Array(CELL_COLOR_LEN).fill(BASE));
    }
  });

  it("hovering is filtered to this layer too", async () => {
    const factory = pickingFactory();
    const { handle } = makeHandle({ meshFactory: factory.factory });
    await handle.commit(topDownRays());
    const key = [...factory.created.keys()][0]!;
    const objectId = factory.created.get(key)!.objectKeys[0]!;
    const foreign: Selection = {
      kind: "object",
      layerId: "OTHER",
      objectId,
    };
    handle.setHighlight([], foreign);
    expect(rendered(factory.created.get(key)!)).toEqual(
      new Array(CELL_COLOR_LEN).fill(BASE),
    );
  });

  it("setVisible fans out to existing cells AND to cells created afterwards", async () => {
    const factory = pickingFactory();
    const { handle } = makeHandle({ meshFactory: factory.factory });
    await handle.commit(topDownRays());

    handle.setVisible(false);
    expect(handle.visible).toBe(false);
    for (const rec of factory.all) expect(rec.visible).toBe(false);

    const before = factory.all.length;
    await handle.commit(pannedRays());
    expect(factory.all.length).toBeGreaterThan(before);
    for (const rec of factory.all) expect(rec.visible).toBe(false);
  });
});

describe("FcbStreamLayerHandle lifecycle", () => {
  it("getResidentModel is memoised per commit version", async () => {
    const { handle } = makeHandle({ meshFactory: pickingFactory().factory });
    await handle.commit(topDownRays());

    const first = handle.getResidentModel();
    expect(handle.getResidentModel()).toBe(first);
    expect(first.cellCount).toBe(handle.cacheKeysForTest().length);

    await handle.commit(pannedRays());
    expect(handle.getResidentModel()).not.toBe(first);
  });

  it("fetchSurfaces resolves the worker's rings, and rejects with its message when the object is not resident", async () => {
    const withRings = makeHandle({ surfaces: [{ rings: [], lod: "2.2" }] });
    await expect(withRings.handle.fetchSurfaces("B1")).resolves.toEqual([
      { rings: [], lod: "2.2" },
    ]);

    const without = makeHandle({});
    await expect(without.handle.fetchSurfaces("B1")).rejects.toThrow(
      /not resident/,
    );
  });

  it("delete() closes the worker and drops every resident mesh, idempotently", async () => {
    const factory = pickingFactory();
    const { handle, client } = makeHandle({ meshFactory: factory.factory });
    await handle.commit(topDownRays());
    expect(factory.all.length).toBeGreaterThan(0);

    handle.delete();
    expect(client.notifyCalls).toContainEqual(
      expect.objectContaining({ type: "close" }),
    );
    expect(client.terminate).toHaveBeenCalledTimes(1);
    for (const rec of factory.all) expect(rec.deleted).toBe(true);
    expect(handle.triangleCount()).toBe(0);
    expect(handle.getBoundsGeodetic()).toBeNull();

    handle.delete();
    expect(client.terminate).toHaveBeenCalledTimes(1);
  });

  it("a commit whose fetch resolves after delete() admits nothing and builds nothing", async () => {
    const factory = pickingFactory();
    let onDispatch: (() => void) | null = null;
    const { handle, client } = makeHandle({
      meshFactory: factory.factory,
      onFetchDispatched: () => onDispatch?.(),
    });
    // The layer is removed after the fetch went out; its cells arrive anyway.
    onDispatch = () => handle.delete();
    await expect(handle.commit(topDownRays())).resolves.toBeUndefined();

    expect(handle.cacheKeysForTest()).toEqual([]);
    expect(factory.all).toEqual([]);
    expect(handle.version).toBe(0);
    // No status is emitted for a layer nobody can see any more.
    expect(handle.status).not.toBe("error");
    expect(requestsOfType(client.sendStreamingCalls, "recolor")).toEqual([]);
  });

  it("a later commit after delete() is a no-op", async () => {
    const { handle, client } = makeHandle({
      meshFactory: pickingFactory().factory,
    });
    handle.delete();
    await handle.commit(topDownRays());
    expect(client.sendCalls).toEqual([]);
    expect(client.sendStreamingCalls).toEqual([]);
  });
});
