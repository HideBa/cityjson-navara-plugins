/**
 * Task C10a: `FcbStreamLayerHandle`'s commit loop.
 *
 * These are the driver-level regressions from the app's
 * `tests/unit/features/streaming/useTileStreaming.test.ts` (B1 ladder, B3
 * swap-timeout evict, B5 sparse backfill, the epoch guard, the too-far and
 * worker-rejection paths), ported onto `handle.commit(rays)` — no React, no
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
import { enuToEcef, makeEnuFrame } from "@cityjson/navara-core";
import type { CityMeshHandle } from "@cityjson/navara-cityjson";
import {
  FcbStreamLayerHandle,
  type CellEntry,
  type StreamStatus,
} from "../src/streamLayer";
import { CellCache } from "../src/cellCache";
import type { CellMeshFactory } from "../src/cellMeshes";
import type { Grid } from "../src/tileGrid";
import type { FcbHeaderModel } from "../src/fcbSource";
import type { Ray } from "../src/viewportFootprint";
import type { WorkerClient } from "../src/workerClient";
import type { WorkerResponse } from "../src/workerProtocol";
import {
  LEVEL_SWAP_TIMEOUT_MS,
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

function geom(triangleCount: number) {
  const v = triangleCount * 3;
  return {
    positions: new Float32Array(v * 3).fill(1),
    normals: new Float32Array(v * 3).fill(2),
    baseColors: new Float32Array(v * 3).fill(0.25),
    ruleColors: null,
    objectIndices: new Uint32Array(v).fill(0),
    surfaceIndices: new Uint32Array(v).fill(0),
    objectKeys: ["B1"],
    triangleCount,
  };
}

interface FakeClientOpts {
  /** Requested cells the worker genuinely finds nothing in, BY REQUEST ORDER
   *  — the real keys depend on `chooseLevel`, so a test names positions, not
   *  keys. Mirrors the worker's "only a POPULATED bucket gets a 'cell'
   *  message" contract (fcb.worker.ts), which is exactly what B5 is about. */
  readonly emptyCellIndices?: readonly number[];
  readonly lodsSeen?: string[];
  readonly probeCount?: number;
  readonly probeDelayMs?: number;
  /** The fetch delivers `deliverCells` cells and then never settles, so a
   *  level swap hits LEVEL_SWAP_TIMEOUT_MS with a partial arrival (B3). */
  readonly stallFetch?: boolean;
  readonly deliverCells?: number;
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
    return { type: "done", id: 0 } satisfies WorkerResponse;
  });

  const sendStreaming = vi.fn(
    (
      msg: Record<string, unknown>,
      onMessage: (r: WorkerResponse) => void,
    ): Promise<void> => {
      sendStreamingCalls.push(msg);
      const cells = msg.cells as string[];
      const limit = opts.stallFetch
        ? Math.min(opts.deliverCells ?? 0, cells.length)
        : cells.length;
      cells.slice(0, limit).forEach((key, i) => {
        if (empty.has(i)) return;
        onMessage({
          type: "cell",
          id: 0,
          key,
          geometry: geom(1),
          objects: [],
          surfaceAttrKeys: [],
          lodsSeen: opts.lodsSeen ?? [],
        });
      });
      if (opts.stallFetch) return new Promise<void>(() => {});
      onMessage({ type: "done", id: 0 });
      return Promise.resolve();
    },
  );

  const notify = vi.fn((msg: Record<string, unknown>) => {
    notifyCalls.push(msg);
  });

  const client = {
    newEpoch: vi.fn(() => ++epoch),
    isCurrent: vi.fn((e: number) => e === epoch),
    send,
    sendStreaming,
    notify,
    terminate: vi.fn(),
  };
  return {
    client: client as unknown as WorkerClient,
    send,
    sendStreaming,
    notify,
    sendCalls,
    sendStreamingCalls,
    notifyCalls,
  };
}

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

function makeHandle(opts: FakeClientOpts & { meshFactory?: CellMeshFactory }) {
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
    // Deliberately a plain linearisation around the frame origin rather than a
    // real proj4 inverse: `viewportFootprint`'s CRS step has its own tests, and
    // this file is about the commit loop.
    toSourceXY: (lng, lat) => [
      (lng - FRAME.lngDeg) * 68000,
      (lat - FRAME.latDeg) * 111000,
    ],
    toLngLat: (x, y) => [FRAME.lngDeg + x / 68000, FRAME.latDeg + y / 111000],
    heightOffsetM: 0,
    // Injected, so streamLayer.ts never imports addCityMeshArrays and
    // therefore never reaches @navaramap/*. Task C11 supplies the real one.
    meshFactory: opts.meshFactory ?? meshes.factory,
    pickRays: null,
  });
  return { handle, client: fake, meshes };
}

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
    "on a level-swap timeout, keeps the old cache and evicts the partially-arrived cells from the worker (B3)",
    async () => {
      const { handle, client } = makeHandle({
        stallFetch: true,
        deliverCells: 1,
      });
      await handle.commit(topDownRays());

      const arrived = (client.sendStreamingCalls[0]!.cells as string[])[0]!;
      expect(client.notifyCalls).toContainEqual(
        expect.objectContaining({ type: "cancel" }),
      );
      expect(client.notifyCalls).toContainEqual(
        expect.objectContaining({ type: "evict", cells: [arrived] }),
      );
      expect(handle.cacheKeysForTest()).toEqual([]);
      expect(handle.level).toBeNull();
      expect(handle.status).toBe("error");
      // Tracks the constant rather than a magic number: the whole point of this
      // case is that the commit waits out LEVEL_SWAP_TIMEOUT_MS.
    },
    LEVEL_SWAP_TIMEOUT_MS + 3000,
  );

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
    // stale and no recolor is queued. (The positive case needs `setRules` to
    // change mid-flight, which lands with the recolor round trip in C10b.)
    expect(handle.pendingRecolorForTest()).toEqual([]);
  });
});
