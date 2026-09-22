/**
 * The format-agnostic stream worker core, driven through a FAKE source
 * adapter: no FlatCityBuf reader, no module mocks, no `self` global. The core
 * owns the cell cache, bucketing, baking and the fetch/recolor/surfaces/evict
 * protocol; the adapter only opens, counts and decodes.
 *
 * `postMessage` is backed by `structuredClone(msg, {transfer})`, so the
 * transferred buffers really detach, exactly as in the browser.
 */
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
import { makeGrid, unionOfCellBounds } from "../src/tileGrid";
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
    lods: undefined,
    throwWhenAborted: false,
    open(req): Promise<OpenedSource> {
      adapter.opens.push(req);
      if (adapter.openError) return Promise.reject(adapter.openError);
      return Promise.resolve({
        header: {
          version: "fake",
          featuresCount: features.length,
          extent: EXTENT,
          referenceSystem: "EPSG:28992",
          epsg: 28992,
          ...(adapter.lods ? { lods: adapter.lods } : {}),
        },
        admission: adapter.admission,
      });
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

function harness(adapter: StreamSourceAdapter) {
  const posted: WorkerResponse[] = [];
  const ctx = {
    postMessage(m: WorkerResponse, t?: Transferable[]) {
      posted.push(structuredClone(m, { transfer: t ?? [] }));
    },
    onmessage: null as ((ev: MessageEvent<WorkerRequest>) => void) | null,
  };
  installStreamWorker(ctx, adapter);
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
): WorkerRequest {
  return {
    type: "fetch",
    id,
    bbox,
    level: 2,
    cells,
    lod: null,
    hiddenTypes: [],
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

  it("keys a url list by its urls, and a blob by its identity", async () => {
    const adapter = fakeAdapter([]);
    const { send } = harness(adapter);
    await send({ type: "open", id: 0, source: { urls: ["u1", "u2"] } });
    await send({ type: "open", id: 1, source: { urls: ["u1", "u2"] } });
    expect(adapter.opens).toHaveLength(1);

    const blob = new Blob(["x"]);
    await send({ type: "open", id: 2, source: { blob } });
    await send({ type: "open", id: 3, source: { blob } });
    expect(adapter.opens).toHaveLength(2);
    await send({ type: "open", id: 4, source: { blob: new Blob(["x"]) } });
    expect(adapter.opens).toHaveLength(3);

    const b1 = new Blob(["1"]);
    const b2 = new Blob(["2"]);
    await send({ type: "open", id: 5, source: { blobs: [b1, b2] } });
    await send({ type: "open", id: 6, source: { blobs: [b1, b2] } });
    expect(adapter.opens).toHaveLength(4);
    await send({ type: "open", id: 7, source: { blobs: [b2, b1] } });
    expect(adapter.opens).toHaveLength(5);
    // A url is not the same source as a one-url list's neighbour.
    await send({ type: "open", id: 8, source: { url: "u1\nu2" } });
    expect(adapter.opens).toHaveLength(6);
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
