/**
 * The format-agnostic stream worker core, driven through a FAKE source
 * adapter: no FlatCityBuf reader, no module mocks, no `self` global. The core
 * owns the cell cache, bucketing, baking and the fetch/recolor/surfaces/evict
 * protocol; the adapter only opens, counts and decodes.
 *
 * `postMessage` is backed by `structuredClone(msg, {transfer})`, so the
 * transferred buffers really detach, exactly as in the browser.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  dequantizeAll,
  parseCityObject,
  type BBox3,
  type CityJSONObject,
  type CityModel,
  type CityObject,
  type Rule,
} from "@cityjson/navara-core";
import { installStreamWorker } from "../src/streamWorkerCore";
import { createCityParquetSourceAdapter } from "../src/cityParquetSourceAdapter";
import {
  keysCovering,
  makeGrid,
  ownerKey,
  unionOfCellBounds,
} from "../src/tileGrid";
import type {
  AdmissionError,
  OpenedSource,
  OpenRequest,
  StreamSourceAdapter,
} from "../src/streamSourceAdapter";
import {
  assertCellGeometry,
  type WorkerRequest,
  type WorkerResponse,
} from "../src/workerProtocol";

/** 1000 m square in RD New: rootCell 1600, so level 2 cells are 400 m. */
const EXTENT: BBox3 = [0, 0, 0, 1000, 1000, 30];

/** One feature = one Building with a single 10 m roof quad centred at
 *  (cx, cy), decoded through core's real parser so it triangulates. */
function feature(id: string, cx: number, cy: number): CityModel {
  const vertices: [number, number, number][] = [
    [cx - 5, cy - 5, 0],
    [cx + 5, cy - 5, 0],
    [cx + 5, cy + 5, 10],
    [cx - 5, cy + 5, 10],
  ];
  const raw = {
    type: "Building",
    geometry: [
      {
        type: "MultiSurface",
        lod: "2",
        boundaries: [[[0, 1, 2, 3]]],
        semantics: { surfaces: [{ type: "RoofSurface" }], values: [0] },
      },
    ],
  } as unknown as CityJSONObject;
  const real = dequantizeAll(vertices, {
    scale: [1, 1, 1],
    translate: [0, 0, 0],
  });
  const obj: CityObject = parseCityObject(id, raw, real);
  return {
    sourceEncoding: "flatcitybuf",
    metadata: {},
    bbox: obj.bbox,
    objects: { [id]: obj },
    vertexCount: vertices.length,
  };
}

type Box = readonly [number, number, number, number];

function intersects(b: BBox3 | null, q: Box): boolean {
  if (!b) return false;
  return b[0] <= q[2] && b[3] >= q[0] && b[1] <= q[3] && b[4] >= q[1];
}

interface FakeAdapter extends StreamSourceAdapter {
  readonly selectBBoxes: Box[];
  /** When set, `select` awaits this before yielding each feature — lets a
   *  test land a second request mid-traversal. */
  gate: Promise<void> | null;
  closed: number;
  /** Every request that reached `open`. */
  readonly opens: OpenRequest[];
  /** What the next `open` answers. */
  admission: AdmissionError | null;
  /** Per-url extents; a url not listed opens with EXTENT. */
  extents: Record<string, BBox3>;
  /** Per-url gates: an `open` of a listed url awaits its gate first. */
  openGates: Record<string, Promise<void>>;
  /** When set, the next `open` rejects with it. */
  openError: Error | null;
  /** When set, the header's up-front LoDs. */
  lods: string[] | undefined;
  /** When set, `select` throws (rather than returning) once its signal is
   *  aborted — as a real range reader does. */
  throwWhenAborted: boolean;
}

function fakeAdapter(features: CityModel[]): FakeAdapter {
  const adapter: FakeAdapter = {
    selectBBoxes: [],
    gate: null,
    closed: 0,
    opens: [],
    admission: null,
    openError: null,
    extents: {},
    openGates: {},
    lods: undefined,
    throwWhenAborted: false,
    async open(req): Promise<OpenedSource> {
      adapter.opens.push(req);
      const url = "url" in req.source ? req.source.url : "";
      const gate = adapter.openGates[url];
      if (gate) await gate;
      if (adapter.openError) throw adapter.openError;
      return {
        header: {
          version: "fake",
          featuresCount: features.length,
          extent: adapter.extents[url] ?? EXTENT,
          referenceSystem: "EPSG:28992",
          epsg: 28992,
          ...(adapter.lods ? { lods: adapter.lods } : {}),
        },
        admission: adapter.admission,
      };
    },
    probe(bbox): Promise<number> {
      return Promise.resolve(
        features.filter((f) => intersects(f.bbox, bbox)).length + 100,
      );
    },
    async *select(bbox, { signal }) {
      adapter.selectBBoxes.push(bbox);
      // Honours the bbox, like a real spatial index: only intersecting
      // features come back.
      for (const f of features) {
        if (adapter.gate) await adapter.gate;
        if (adapter.throwWhenAborted && signal.aborted) {
          throw new Error("read aborted");
        }
        if (intersects(f.bbox, bbox)) yield f;
      }
    },
    appearance: () => undefined,
    bakeLod: (lod) => lod,
    close() {
      adapter.closed++;
    },
  };
  return adapter;
}

function harness(
  adapter: StreamSourceAdapter,
  options?: { retainedByteBudget?: number },
) {
  const posted: WorkerResponse[] = [];
  const ctx = {
    postMessage(m: WorkerResponse, t?: Transferable[]) {
      posted.push(structuredClone(m, { transfer: t ?? [] }));
    },
    onmessage: null as ((ev: MessageEvent<WorkerRequest>) => void) | null,
  };
  installStreamWorker(ctx, adapter, options);
  const send = async (data: WorkerRequest): Promise<void> => {
    if (!ctx.onmessage) throw new Error("core did not install onmessage");
    await (ctx.onmessage({ data } as MessageEvent<WorkerRequest>) as unknown);
  };
  return { posted, send };
}

const MATCH_ALL: Rule = {
  id: "r1",
  name: "roof",
  color: "#ff0000",
  conditions: [],
  logic: "AND",
  enabled: true,
};

function fetchMsg(
  id: number,
  cells: string[],
  bbox: [number, number, number, number] = [0, 0, 1000, 1000],
  hiddenTypes: string[] = [],
): WorkerRequest {
  return {
    type: "fetch",
    id,
    bbox,
    level: 2,
    cells,
    lod: null,
    hiddenTypes,
    rules: [],
    rulesEnabled: false,
  };
}

const ofType =
  <T extends WorkerResponse["type"]>(type: T) =>
  (m: WorkerResponse): m is Extract<WorkerResponse, { type: T }> =>
    m.type === type;

describe("streamWorkerCore", () => {
  it("open posts 'opened' with the adapter's header and admission", async () => {
    const { posted, send } = harness(fakeAdapter([]));
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    const opened = posted.find(ofType("opened"));
    expect(opened).toMatchObject({
      id: 0,
      header: { version: "fake", epsg: 28992, extent: EXTENT },
      admission: null,
    });
  });

  it("probe posts 'probed' with the adapter's count", async () => {
    const { posted, send } = harness(
      fakeAdapter([feature("a", 100, 100), feature("b", 500, 100)]),
    );
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send({ type: "probe", id: 1, bbox: [0, 0, 1000, 1000] });
    expect(posted.find(ofType("probed"))).toEqual({
      type: "probed",
      id: 1,
      count: 102,
    });
  });

  it("fetch posts one 'cell' per requested non-empty cell, then 'done'", async () => {
    const { posted, send } = harness(
      fakeAdapter([
        feature("a", 100, 100), // 2/0/0
        feature("b", 500, 100), // 2/1/0
      ]),
    );
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, ["2/0/0", "2/1/0", "2/2/0"]));

    const cells = posted.filter(ofType("cell"));
    expect(cells.map((c) => c.key).sort()).toEqual(["2/0/0", "2/1/0"]);
    for (const c of cells) {
      assertCellGeometry(c.geometry);
      expect(c.geometry.triangleCount).toBe(2);
      expect(c.lodsSeen).toEqual(["2"]);
    }
    const byKey = new Map(cells.map((c) => [c.key, c]));
    expect(byKey.get("2/0/0")!.objects.map((o) => o.id)).toEqual(["a"]);
    expect(byKey.get("2/1/0")!.objects.map((o) => o.id)).toEqual(["b"]);
    expect(posted.at(-1)).toEqual({ type: "done", id: 1 });
  });

  it("a fetch superseded by a second fetch posts an aborted error and leaves nothing cached", async () => {
    const adapter = fakeAdapter([
      feature("a", 100, 100), // 2/0/0
      feature("b", 500, 100), // 2/1/0
    ]);
    const { posted, send } = harness(adapter);
    await send({ type: "open", id: 0, source: { url: "fake://x" } });

    let release!: () => void;
    adapter.gate = new Promise((r) => (release = r));
    const first = send(fetchMsg(1, ["2/0/0"]));
    // The first fetch is parked inside the traversal; a second one (for a
    // cell that does NOT hold 'a') supersedes it.
    adapter.gate = null;
    const second = send(fetchMsg(2, ["2/1/0"]));
    release();
    await Promise.all([first, second]);

    const err = posted.find(
      (m): m is Extract<WorkerResponse, { type: "error" }> =>
        m.type === "error" && m.id === 1,
    );
    expect(err).toMatchObject({ aborted: true });
    expect(
      posted.filter(ofType("cell")).filter((c) => c.id === 1),
    ).toHaveLength(0);

    await send({ type: "surfaces", id: 3, objectId: "a" });
    const notFound = posted.find(
      (m): m is Extract<WorkerResponse, { type: "error" }> =>
        m.type === "error" && m.id === 3,
    );
    expect(notFound?.code).toBe("not-found");
  });

  it("a superseded fetch whose read throws on its aborted signal reports aborted", async () => {
    const adapter = fakeAdapter([feature("a", 100, 100)]);
    adapter.throwWhenAborted = true;
    const { posted, send } = harness(adapter);
    await send({ type: "open", id: 0, source: { url: "fake://x" } });

    let release!: () => void;
    adapter.gate = new Promise((r) => (release = r));
    const first = send(fetchMsg(1, ["2/0/0"]));
    adapter.gate = null;
    const second = send(fetchMsg(2, ["2/0/0"]));
    await second; // the newer request finishes; its controller is not aborted
    release();
    await first;

    const err = posted.find(
      (m): m is Extract<WorkerResponse, { type: "error" }> =>
        m.type === "error" && m.id === 1,
    );
    // Judged by fetch 1's OWN signal, not by whichever request is current.
    expect(err).toMatchObject({ message: "read aborted", aborted: true });
  });

  it("surfaces answers from the cache, and 'not-found' once the cell is evicted", async () => {
    const { posted, send } = harness(fakeAdapter([feature("a", 100, 100)]));
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, ["2/0/0"]));

    await send({ type: "surfaces", id: 2, objectId: "a" });
    const data = posted.find(ofType("surfaceData"));
    expect(data?.objectId).toBe("a");
    expect(data?.surfaces.length).toBeGreaterThan(0);
    // A PROJECTED source's cached rings are still in its source CRS, so there
    // is no local frame to name. `null` says exactly that.
    expect(data?.frame).toBeNull();

    await send({ type: "evict", id: 3, cells: ["2/0/0"] });
    await send({ type: "surfaces", id: 4, objectId: "a" });
    const err = posted.find(
      (m): m is Extract<WorkerResponse, { type: "error" }> =>
        m.type === "error" && m.id === 4,
    );
    expect(err?.code).toBe("not-found");
  });

  it("recolor posts 'recolored' for cached cells only", async () => {
    const { posted, send } = harness(fakeAdapter([feature("a", 100, 100)]));
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, ["2/0/0"]));
    const cell = posted.find(ofType("cell"))!;

    await send({
      type: "recolor",
      id: 2,
      cells: ["2/0/0", "2/3/3"],
      rules: [MATCH_ALL],
      rulesEnabled: true,
    });
    const recolored = posted.filter(ofType("recolored"));
    expect(recolored.map((r) => r.key)).toEqual(["2/0/0"]);
    expect(recolored[0]!.ruleColors.length).toBe(
      cell.geometry.triangleCount * 3 * 3,
    );
    expect(posted.at(-1)).toEqual({ type: "done", id: 2 });
  });

  it("folds the header's up-front LoDs into every cell's lodsSeen", async () => {
    const adapter = fakeAdapter([feature("a", 100, 100)]);
    adapter.lods = ["1.2", "2"];
    const bakeLods: (readonly string[])[] = [];
    const base = adapter.bakeLod;
    adapter.bakeLod = (lod, seen) => {
      bakeLods.push(seen);
      return base(lod, seen);
    };
    const { posted, send } = harness(adapter);
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, ["2/0/0"]));

    const cell = posted.find(ofType("cell"))!;
    expect([...cell.lodsSeen].sort()).toEqual(["1.2", "2"]);
    // Baking still reads the cell's OWN LoDs.
    expect(bakeLods).toEqual([["2"]]);
  });

  it("a fetch bakes every requested cell complete, not only its part inside the view", async () => {
    // Cell 2/1/0 spans x 400..800; the view reaches only x 600, so 'e'
    // (centred at x 700, owned by 2/1/0) lies outside it.
    const adapter = fakeAdapter([
      feature("a", 100, 100),
      feature("e", 700, 100),
    ]);
    const { posted, send } = harness(adapter);
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, ["2/0/0", "2/1/0"], [0, 0, 600, 400]));

    // The query is the union of the requested cells, not the view.
    expect(adapter.selectBBoxes).toEqual([
      unionOfCellBounds(makeGrid(EXTENT), ["2/0/0", "2/1/0"]),
    ]);
    expect(adapter.selectBBoxes[0]).toEqual([0, 0, 800, 400]);
    const k = posted.filter(ofType("cell")).find((c) => c.key === "2/1/0");
    expect(k?.objects.map((o) => o.id)).toEqual(["e"]);
  });

  it("a fetch for no cells answers 'done' without a traversal", async () => {
    const adapter = fakeAdapter([feature("a", 100, 100)]);
    const { posted, send } = harness(adapter);
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, []));
    expect(adapter.selectBBoxes).toEqual([]);
    expect(posted.at(-1)).toEqual({ type: "done", id: 1 });
  });

  it("buckets by the adapter's ownership: 'feature' keeps a family in one cell", async () => {
    // One model, two objects: 'p' centred in 2/0/0 and 'q' centred in 2/1/0;
    // the model's bbox (x 95..485) is centred in 2/0/0.
    const p = feature("p", 100, 100);
    const q = feature("q", 480, 100);
    const fam: CityModel = {
      ...p,
      bbox: [95, 95, 0, 485, 105, 10],
      objects: { ...p.objects, ...q.objects },
    };
    const adapter = Object.assign(fakeAdapter([fam]), {
      ownership: "feature" as const,
    });
    const { posted, send } = harness(adapter);
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, ["2/0/0", "2/1/0"]));

    const cells = posted.filter(ofType("cell"));
    expect(cells.map((c) => c.key)).toEqual(["2/0/0"]);
    expect(cells[0]!.objects.map((o) => o.id).sort()).toEqual(["p", "q"]);
  });

  it("bakes a PROJECTED source byte for byte as it did before the frame path", async () => {
    // A baseline PIN, not a failing test: the geographic-to-ENU milestone adds
    // a second bake path (rings already geodetic, converted per cell by
    // arithmetic) beside this one, and a projected source — RD New here, and
    // every FlatCityBuf source — must keep going through proj4 and
    // `projectPositionsToEnu` with the same numbers. Captured from the code as
    // it stood before that change, to the centimetre in ENU and to 1e-4 in
    // each normal component.
    const { posted, send } = harness(fakeAdapter([feature("a", 100, 100)]));
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, ["2/0/0"]));
    const cell = posted.filter(ofType("cell"))[0]!;
    expect(cell.geometry.triangleCount).toBe(2);
    // `+ 0` normalises -0, which `toFixed` keeps and `toEqual` distinguishes.
    const round = (a: Float32Array, dp: number) =>
      [...a].map((v) => Number(v.toFixed(dp)) + 0);
    // EPSG:28992 -> WGS84 -> ENU about the 2/0/0 cell centre (200, 200): the
    // 10 m roof quad sits ~135 m west and ~104 m south of it, tilted by RD
    // New's grid convergence at this (fixture) position.
    // EPSG:28992 -> WGS84 -> ENU about the 2/0/0 cell centre (200, 200): the
    // 10 m roof quad sits ~97 m west and ~102 m south of it, and the ring is
    // wound so its normal points up-and-north.
    expect(round(cell.geometry.positions, 2)).toEqual([
      -92.2, -97.46, 10, -102.18, -97.74, 10, -101.91, -107.72, 0, -101.91,
      -107.72, 0, -91.93, -107.45, 0, -92.2, -97.46, 10,
    ]);
    expect(round(cell.geometry.normals, 4)).toEqual([
      0, -0.7071, 0.7071, 0, -0.7071, 0.7071, 0, -0.7071, 0.7071, 0, -0.7071,
      0.7071, 0, -0.7071, 0.7071, 0, -0.7071, 0.7071,
    ]);
  });

  it("close closes the adapter and clears the cache", async () => {
    const adapter = fakeAdapter([feature("a", 100, 100)]);
    const { posted, send } = harness(adapter);
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, ["2/0/0"]));
    await send({ type: "close", id: 2 });
    expect(adapter.closed).toBe(1);

    await send({ type: "open", id: 3, source: { url: "fake://x" } });
    // A closed source is opened afresh, even under the same url.
    expect(adapter.opens).toHaveLength(2);
    await send({ type: "surfaces", id: 4, objectId: "a" });
    const err = posted.find(
      (m): m is Extract<WorkerResponse, { type: "error" }> =>
        m.type === "error" && m.id === 4,
    );
    expect(err?.code).toBe("not-found");
  });
});

const errorOf =
  (id: number) =>
  (m: WorkerResponse): m is Extract<WorkerResponse, { type: "error" }> =>
    m.type === "error" && m.id === id;

describe("streamWorkerCore — reopening", () => {
  for (const failure of ["refused", "throws"] as const) {
    it(`an open of another source that ${failure} leaves nothing of the previous one`, async () => {
      const adapter = fakeAdapter([feature("a", 100, 100)]);
      const { posted, send } = harness(adapter);
      await send({ type: "open", id: 0, source: { url: "fake://x" } });
      await send(fetchMsg(1, ["2/0/0"]));
      expect(posted.filter(ofType("cell"))).toHaveLength(1);

      if (failure === "refused") {
        adapter.admission = { code: "no-index", message: "refused" };
      } else {
        adapter.openError = new Error("unreadable");
      }
      await send({ type: "open", id: 2, source: { url: "fake://y" } });

      await send({ type: "surfaces", id: 3, objectId: "a" });
      expect(posted.find(errorOf(3))?.code).toBe("not-found");
      await send(fetchMsg(4, ["2/0/0"]));
      expect(posted.find(errorOf(4))?.message).toBe("no file open");
      // The previous source's adapter state is closed too.
      expect(adapter.closed).toBe(1);
    });
  }

  it("a second open of the same url does not reopen the adapter", async () => {
    const adapter = fakeAdapter([]);
    const { posted, send } = harness(adapter);
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send({
      type: "open",
      id: 1,
      source: { url: "fake://x" },
      heightOffset: 40,
    });
    expect(adapter.opens).toHaveLength(1);
    const opened = posted.filter(ofType("opened"));
    expect(opened.map((o) => o.id)).toEqual([0, 1]);
    expect(opened[1]!.header).toEqual(opened[0]!.header);
    expect(opened[1]!.admission).toBeNull();
    expect(adapter.closed).toBe(0);
  });

  it("the same-source reopen re-establishes the placement with its own heightOffset", async () => {
    const reopened = harness(fakeAdapter([feature("a", 100, 100)]));
    await reopened.send({ type: "open", id: 0, source: { url: "fake://x" } });
    await reopened.send({
      type: "open",
      id: 1,
      source: { url: "fake://x" },
      heightOffset: 40,
    });
    await reopened.send(fetchMsg(2, ["2/0/0"]));

    const direct = harness(fakeAdapter([feature("a", 100, 100)]));
    await direct.send({
      type: "open",
      id: 0,
      source: { url: "fake://x" },
      heightOffset: 40,
    });
    await direct.send(fetchMsg(2, ["2/0/0"]));

    const unshifted = harness(fakeAdapter([feature("a", 100, 100)]));
    await unshifted.send({ type: "open", id: 0, source: { url: "fake://x" } });
    await unshifted.send(fetchMsg(2, ["2/0/0"]));

    const positions = (h: { posted: WorkerResponse[] }) =>
      [...h.posted.find(ofType("cell"))!.geometry.positions];
    expect(positions(reopened)).toEqual(positions(direct));
    expect(positions(reopened)).not.toEqual(positions(unshifted));
  });

  it("without a sourceKey, keys a url list by its urls, and never matches a Blob", async () => {
    const adapter = fakeAdapter([]);
    const { send } = harness(adapter);
    await send({ type: "open", id: 0, source: { urls: ["u1", "u2"] } });
    await send({ type: "open", id: 1, source: { urls: ["u1", "u2"] } });
    expect(adapter.opens).toHaveLength(1);
    // A url is not the same source as a url list whose urls join to it.
    await send({ type: "open", id: 2, source: { url: "u1\nu2" } });
    expect(adapter.opens).toHaveLength(2);

    // postMessage structured-clones every request, so two opens of one file
    // never deliver the same Blob object: with no key they are two sources.
    await send({ type: "open", id: 3, source: { blob: new Blob(["x"]) } });
    await send({ type: "open", id: 4, source: { blob: new Blob(["x"]) } });
    expect(adapter.opens).toHaveLength(4);
  });

  it("the same sourceKey is one source, even when each open delivers a new Blob", async () => {
    const adapter = fakeAdapter([]);
    const { send } = harness(adapter);
    // What structured cloning does to the registry's two opens: equal
    // bytes, distinct objects.
    await send({
      type: "open",
      id: 0,
      source: { blob: new Blob(["x"]) },
      sourceKey: "L1",
    });
    await send({
      type: "open",
      id: 1,
      source: { blob: new Blob(["x"]) },
      sourceKey: "L1",
      heightOffset: 40,
    });
    expect(adapter.opens).toHaveLength(1);
    await send({
      type: "open",
      id: 2,
      source: { blobs: [new Blob(["x"])] },
      sourceKey: "L1",
    });
    expect(adapter.opens).toHaveLength(1);
  });

  it("a different sourceKey is another source, even under the same url", async () => {
    const adapter = fakeAdapter([]);
    const { send } = harness(adapter);
    await send({
      type: "open",
      id: 0,
      source: { url: "fake://x" },
      sourceKey: "L1",
    });
    await send({
      type: "open",
      id: 1,
      source: { url: "fake://x" },
      sourceKey: "L2",
    });
    expect(adapter.opens).toHaveLength(2);
    expect(adapter.closed).toBe(1);
  });

  it("overlapping opens of different sources end on the LATER one, whichever resolves first", async () => {
    const OTHER: BBox3 = [10000, 10000, 0, 11000, 11000, 30];
    const adapter = fakeAdapter([]);
    adapter.extents["fake://y"] = OTHER;
    let releaseX!: () => void;
    adapter.openGates["fake://x"] = new Promise((r) => (releaseX = r));
    const { posted, send } = harness(adapter);

    // x is still being read when y is asked for; x resolves LAST.
    const x = send({ type: "open", id: 0, source: { url: "fake://x" } });
    const y = send({ type: "open", id: 1, source: { url: "fake://y" } });
    await new Promise((r) => setTimeout(r, 0));
    releaseX();
    await Promise.all([x, y]);
    expect(posted.filter(ofType("opened")).map((o) => o.id)).toEqual([0, 1]);

    // The grid is y's...
    await send(fetchMsg(2, ["2/0/0"]));
    expect(adapter.selectBBoxes).toEqual([
      unionOfCellBounds(makeGrid(OTHER), ["2/0/0"]),
    ]);
    // ...and so is the remembered source: reopening y reads nothing.
    const opensBefore = adapter.opens.length;
    await send({ type: "open", id: 3, source: { url: "fake://y" } });
    expect(adapter.opens).toHaveLength(opensBefore);
  });

  it("an open still reading when 'close' arrives installs nothing and posts nothing", async () => {
    // Codex milestone review (Minor): `close` aborted the in-flight REQUEST
    // controller, which a slow `open` never consults, so the open landed
    // afterwards — reinstalling grid, placement and the opened source of a
    // stream the main thread had already given up on, and posting an
    // `opened` for a layer that no longer exists.
    const adapter = fakeAdapter([feature("a", 100, 100)]);
    let releaseX!: () => void;
    adapter.openGates["fake://x"] = new Promise((r) => (releaseX = r));
    const { posted, send } = harness(adapter);

    const opening = send({ type: "open", id: 0, source: { url: "fake://x" } });
    await new Promise((r) => setTimeout(r, 0));
    await send({ type: "close", id: 1 });
    releaseX();
    await opening;

    expect(posted.filter(ofType("opened"))).toHaveLength(0);
    // The adapter it did open is closed, not left holding a source.
    expect(adapter.closed).toBeGreaterThanOrEqual(1);
    await send(fetchMsg(2, ["2/0/0"]));
    expect(posted.find(errorOf(2))?.message).toBe("no file open");
  });

  it("an open still QUEUED when 'close' arrives never reaches the adapter", async () => {
    const adapter = fakeAdapter([feature("a", 100, 100)]);
    let releaseX!: () => void;
    adapter.openGates["fake://x"] = new Promise((r) => (releaseX = r));
    const { posted, send } = harness(adapter);

    const first = send({ type: "open", id: 0, source: { url: "fake://x" } });
    const second = send({ type: "open", id: 1, source: { url: "fake://y" } });
    await new Promise((r) => setTimeout(r, 0));
    await send({ type: "close", id: 2 });
    releaseX();
    await Promise.all([first, second]);

    expect(posted.filter(ofType("opened"))).toHaveLength(0);
    // Only the first open ever ran; the queued one was dropped at the gate.
    expect(adapter.opens.map((o) => o.id)).toEqual([0]);
  });

  it("a refused open is not cached: reopening the same source asks the adapter again", async () => {
    const adapter = fakeAdapter([]);
    adapter.admission = { code: "no-index", message: "refused" };
    const { send } = harness(adapter);
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send({ type: "open", id: 1, source: { url: "fake://x" } });
    expect(adapter.opens).toHaveLength(2);
  });
});

/** The multi-row-group CityParquet fixture (20 copies of two-buildings, 60
 *  objects in 40 families, EPSG:7415) as a Blob. */
async function cityParquetFixture(): Promise<Blob> {
  const file = await readFile(
    fileURLToPath(
      new URL(
        "../../navara-cityparquet/tests/fixtures/multigroup-cityparquet/building.parquet",
        import.meta.url,
      ),
    ),
  );
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file);
  return new Blob([bytes]);
}

/** The extent an admitted `opened` carried (the wire types it `unknown`). */
function openedExtent(posted: WorkerResponse[]): BBox3 {
  const opened = posted.find(ofType("opened"))!;
  return (opened.header as OpenedSource["header"]).extent!;
}

function fetchAt(
  id: number,
  level: number,
  cells: string[],
  bbox: [number, number, number, number],
): WorkerRequest {
  return {
    type: "fetch",
    id,
    bbox,
    level,
    cells,
    lod: null,
    hiddenTypes: [],
    rules: [],
    rulesEnabled: false,
  };
}

/**
 * One scenario, every adapter: open, fetch every cell covering the extent at
 * one level, and check the posted cells are well-formed and together hold
 * every object in the source — exactly once.
 */
async function fetchConformance(
  adapter: StreamSourceAdapter,
  source: WorkerRequest & { type: "open" },
  level: number,
  expectedIds: ReadonlyArray<string>,
): Promise<void> {
  const { posted, send } = harness(adapter);
  await send(source);
  const opened = posted.find(ofType("opened"))!;
  expect(opened.admission).toBeNull();
  const extent = openedExtent(posted);
  const grid = makeGrid(extent);
  const box: [number, number, number, number] = [
    extent[0],
    extent[1],
    extent[3],
    extent[4],
  ];
  const cells = keysCovering(grid, box, level);
  await send(fetchAt(1, level, cells, box));

  const posts = posted.filter(ofType("cell"));
  expect(posts.length).toBeGreaterThan(0);
  const ids: string[] = [];
  for (const c of posts) {
    expect(cells).toContain(c.key);
    assertCellGeometry(c.geometry);
    expect(c.geometry.triangleCount).toBeGreaterThan(0);
    ids.push(...c.objects.map((o) => o.id));
  }
  expect(ids.sort()).toEqual([...expectedIds].sort());
  expect(posted.at(-1)).toEqual({ type: "done", id: 1 });
}

describe("streamWorkerCore — adapter conformance", () => {
  it("the fake adapter", async () => {
    await fetchConformance(
      fakeAdapter([
        feature("a", 100, 100),
        feature("b", 500, 100),
        feature("c", 900, 900),
      ]),
      { type: "open", id: 0, source: { url: "fake://x" } },
      2,
      ["a", "b", "c"],
    );
  });

  it("the CityParquet adapter on the multi-row-group fixture", async () => {
    const ids = Array.from({ length: 20 }, (_, k) => [
      `NL.IMBAG.Pand.0001_${k}`,
      `NL.IMBAG.Pand.0001-part1_${k}`,
      `NL.IMBAG.Pand.0002_${k}`,
    ]).flat();
    await fetchConformance(
      createCityParquetSourceAdapter(),
      { type: "open", id: 0, source: { blob: await cityParquetFixture() } },
      5,
      ids,
    );
  });
});

describe("streamWorkerCore — with the CityParquet adapter", () => {
  // The fixture's copies sit every 50 m from the grid origin, which is every
  // cell boundary of every in-range level (the smallest cell is 50 m), so no
  // family can straddle one there. Level 7 (12.5 m cells) splits copy 0's
  // family: the root (x 85000..85010) and its part (x 85012..85016) own
  // different cells, while the family union (x 85000..85016) is centred in
  // the root's. The core does not bound `level` by the grid's maxLevel.
  const LEVEL = 7;
  const ROOT = "NL.IMBAG.Pand.0001_0";
  const PART = "NL.IMBAG.Pand.0001-part1_0";

  it("a family whose parts straddle a cell boundary lands whole in one cell, and leaves with it", async () => {
    const { posted, send } = harness(createCityParquetSourceAdapter());
    await send({
      type: "open",
      id: 0,
      source: { blob: await cityParquetFixture() },
    });
    const extent = openedExtent(posted);
    const grid = makeGrid(extent);
    // Precondition: object-wise, root and part WOULD own different cells.
    const rootBox: BBox3 = [85000, 446000, 0, 85010, 446008, 8.4];
    const partBox: BBox3 = [85012, 446000, 0, 85016, 446005, 3.2];
    const rootKey = ownerKey(grid, rootBox, LEVEL);
    const partKey = ownerKey(grid, partBox, LEVEL);
    expect(rootKey).not.toBe(partKey);

    const box: [number, number, number, number] = [
      85000, 446000, 85040, 446012,
    ];
    const cells = keysCovering(grid, box, LEVEL);
    expect(cells).toContain(partKey);
    await send(fetchAt(1, LEVEL, cells, box));

    const holding = posted
      .filter(ofType("cell"))
      .filter((c) => c.objects.some((o) => o.id === ROOT || o.id === PART));
    expect(holding.map((c) => c.key)).toEqual([rootKey]);
    expect(holding[0]!.objects.map((o) => o.id)).toEqual(
      expect.arrayContaining([ROOT, PART]),
    );

    await send({ type: "evict", id: 2, cells: [rootKey!] });
    await send({ type: "surfaces", id: 3, objectId: ROOT });
    await send({ type: "surfaces", id: 4, objectId: PART });
    expect(posted.find(errorOf(3))?.code).toBe("not-found");
    expect(posted.find(errorOf(4))?.code).toBe("not-found");
  });

  it("a fetch refused by the read budget reports the 'budget' code", async () => {
    const { posted, send } = harness(
      createCityParquetSourceAdapter({ maxFetchReadRows: 10 }),
    );
    await send({
      type: "open",
      id: 0,
      source: { blob: await cityParquetFixture() },
    });
    const extent = openedExtent(posted);
    const grid = makeGrid(extent);
    const box: [number, number, number, number] = [
      extent[0],
      extent[1],
      extent[3],
      extent[4],
    ];
    await send(fetchAt(1, 5, keysCovering(grid, box, 5), box));
    expect(posted.filter(ofType("cell"))).toEqual([]);
    expect(posted.find(errorOf(1))).toMatchObject({
      code: "budget",
      aborted: false,
    });
  });
});

/**
 * Codex milestone review (Critical): the worker keeps a whole decoded
 * `CityModel` per resident cell — geometry, attributes, object records — but
 * the only number it reported was the geometry it transferred away. With
 * every object type hidden, a cell bakes no triangles at all, so the main
 * thread metered it at nearly nothing and never evicted it, while the worker
 * held the decoded rows for as long as the tab lived.
 */
describe("streamWorkerCore — retained memory", () => {
  it("reports the bytes it retains for a cell, even when every type is hidden", async () => {
    const { posted, send } = harness(
      fakeAdapter([feature("a", 100, 100), feature("b", 500, 100)]),
    );
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, ["2/0/0", "2/1/0"], [0, 0, 1000, 1000], ["Building"]));

    const cells = posted.filter(ofType("cell"));
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      // Nothing drawn...
      expect(cell.geometry.triangleCount).toBe(0);
      // ...but the model behind it is still resident here.
      expect(cell.retainedBytes).toBeGreaterThan(0);
    }
  });

  it("charges a cell with more geometry more retained bytes", async () => {
    const small = harness(fakeAdapter([feature("a", 100, 100)]));
    await small.send({ type: "open", id: 0, source: { url: "fake://x" } });
    await small.send(fetchMsg(1, ["2/0/0"]));

    const many = harness(
      fakeAdapter([
        feature("a", 100, 100),
        feature("a2", 110, 110),
        feature("a3", 120, 120),
      ]),
    );
    await many.send({ type: "open", id: 0, source: { url: "fake://x" } });
    await many.send(fetchMsg(1, ["2/0/0"]));

    const bytesOf = (h: { posted: WorkerResponse[] }) =>
      h.posted.filter(ofType("cell"))[0]!.retainedBytes;
    expect(bytesOf(many)).toBeGreaterThan(bytesOf(small));
  });

  it("drops its least recently used cell once the retained estimate passes the cap", async () => {
    const adapter = fakeAdapter([
      feature("a", 100, 100), // 2/0/0
      feature("b", 500, 100), // 2/1/0
    ]);
    // One cell's worth of budget: the second fetch must push the first out.
    const probe = harness(adapter);
    await probe.send({ type: "open", id: 0, source: { url: "fake://x" } });
    await probe.send(fetchMsg(1, ["2/0/0"]));
    const oneCell = probe.posted.filter(ofType("cell"))[0]!.retainedBytes;

    const { posted, send } = harness(adapter, {
      retainedByteBudget: oneCell + 1,
    });
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, ["2/0/0"]));
    await send(fetchMsg(2, ["2/1/0"]));

    // The newest cell still answers...
    await send({ type: "surfaces", id: 3, objectId: "b" });
    expect(posted.find(ofType("surfaceData"))?.objectId).toBe("b");
    // ...and the oldest was dropped rather than retained forever.
    await send({ type: "surfaces", id: 4, objectId: "a" });
    expect(posted.find(errorOf(4))?.code).toBe("not-found");
    // A recolor of the dropped key is skipped, not an error.
    await send({
      type: "recolor",
      id: 5,
      cells: ["2/0/0", "2/1/0"],
      rules: [],
      rulesEnabled: false,
    });
    expect(posted.filter(ofType("recolored")).map((r) => r.key)).toEqual([
      "2/1/0",
    ]);
    expect(posted.find(errorOf(5))).toBeUndefined();
  });

  it("drops the LEAST recently used cell, and reading a cell keeps it alive", async () => {
    // Discriminating case for the LRU order itself: with three cells resident
    // and one to drop, the victim must be the one nobody has touched — not
    // simply the oldest by arrival. `surfaces` (and `recolor`) count as a
    // touch, or the cell the inspector is reading is the first to go.
    const adapter = fakeAdapter([
      feature("a", 100, 100), // 2/0/0
      feature("b", 500, 100), // 2/1/0
      feature("c", 900, 100), // 2/2/0
      feature("d", 100, 500), // 2/0/1
    ]);
    const probe = harness(adapter);
    await probe.send({ type: "open", id: 0, source: { url: "fake://x" } });
    await probe.send(fetchMsg(1, ["2/0/0"]));
    const oneCell = probe.posted.filter(ofType("cell"))[0]!.retainedBytes;

    const { posted, send } = harness(adapter, {
      retainedByteBudget: oneCell * 3,
    });
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, ["2/0/0"]));
    await send(fetchMsg(2, ["2/1/0"]));
    await send(fetchMsg(3, ["2/2/0"]));
    // Read the OLDEST cell: that makes it the most recently used.
    await send({ type: "surfaces", id: 4, objectId: "a" });
    expect(posted.find(ofType("surfaceData"))?.objectId).toBe("a");

    // A fourth cell pushes the cache over its cap by one.
    await send(fetchMsg(5, ["2/0/1"]));
    // The victim is the middle cell, not the one just read...
    await send({ type: "surfaces", id: 6, objectId: "b" });
    expect(posted.find(errorOf(6))?.code).toBe("not-found");
    // ...and "a" is still here because reading it counted as a touch.
    await send({ type: "surfaces", id: 7, objectId: "a" });
    expect(
      posted.filter(ofType("surfaceData")).filter((m) => m.id === 7),
    ).toHaveLength(1);
    await send({ type: "surfaces", id: 8, objectId: "d" });
    expect(
      posted.filter(ofType("surfaceData")).filter((m) => m.id === 8),
    ).toHaveLength(1);
  });

  it("never drops a cell the fetch in flight was asked for", async () => {
    const adapter = fakeAdapter([
      feature("a", 100, 100), // 2/0/0
      feature("b", 500, 100), // 2/1/0
    ]);
    // A budget below even one cell: the trim must still leave this commit's
    // own cells alone, or the main thread adopts cells the worker has
    // already forgotten.
    const { posted, send } = harness(adapter, { retainedByteBudget: 1 });
    await send({ type: "open", id: 0, source: { url: "fake://x" } });
    await send(fetchMsg(1, ["2/0/0", "2/1/0"]));
    expect(posted.filter(ofType("cell"))).toHaveLength(2);
    await send({ type: "surfaces", id: 2, objectId: "a" });
    expect(posted.find(ofType("surfaceData"))?.objectId).toBe("a");
  });
});
