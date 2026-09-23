/**
 * The stream worker baking a GEOGRAPHIC (EPSG:6697) source: ownership decided
 * in bucket space, geometry and metrics in each cell's own ENU frame, record
 * bboxes still in bucket space, and no proj4 anywhere in the bake
 * (`docs/plans/2026-09-23-geographic-to-enu.md`, Task 3).
 *
 * The binding gate is the plan's: baked vertices are compared in COMMON ECEF
 * (cell frame x local position), matched per SOURCE VERTEX rather than by
 * triangle-buffer order, against an independent double-precision reference —
 * `geodeticToEcef` of the source lon/lat/h. The OLD UTM+ENU path is rebuilt
 * here (the reader no longer has one for a geographic source) and held to the
 * same reference, which bounds old against new transitively.
 *
 * Its own file because of the proj4 factory counter: `vi.mock` is file-scoped,
 * and `streamWorkerCore.test.ts` opens EPSG:28992 sources that legitimately
 * build converters.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dequantizeAll,
  enuToEcef,
  geodeticToEcef,
  localMetricFrameFromDescriptor,
  makeLocalMetricFrame,
  parseCityObject,
  type BBox3,
  type CityJSONObject,
  type CityModel,
  type CityObject,
  type EnuFrame,
  type LocalMetricFrameDescriptor,
  type Vec3,
} from "@cityjson/navara-core";
import {
  asyncBufferFromBlob,
  coordinateTargetFor,
  openCityParquetStream,
  projectCityObjects,
  type ReadBatch,
} from "@cityjson/navara-cityparquet";
import proj4 from "proj4";
import { cellFrame } from "../src/cellMeshes";
import {
  createCityParquetSourceAdapter,
  familyModels,
} from "../src/cityParquetSourceAdapter";
import { installStreamWorker } from "../src/streamWorkerCore";
import type {
  OpenedSource,
  OpenRequest,
  StreamHeader,
  StreamSourceAdapter,
} from "../src/streamSourceAdapter";
import { keysCovering, makeGrid, type Grid } from "../src/tileGrid";
import type { WorkerRequest, WorkerResponse } from "../src/workerProtocol";

/** Calls of the proj4 FACTORY: no converter, no per-vertex `forward`. */
const proj4Calls = vi.hoisted(() => ({ count: 0 }));

vi.mock("proj4", async (importOriginal) => {
  const actual = await importOriginal<{ default: unknown }>();
  const real = actual.default as (...args: unknown[]) => unknown;
  const spy = (...args: unknown[]) => {
    proj4Calls.count += 1;
    return real(...args);
  };
  return { ...actual, default: Object.assign(spy, real) };
});

beforeEach(() => {
  proj4Calls.count = 0;
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ofType =
  <T extends WorkerResponse["type"]>(type: T) =>
  (m: WorkerResponse): m is Extract<WorkerResponse, { type: T }> =>
    m.type === type;

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

function fetchMsg(
  id: number,
  cells: string[],
  bbox: [number, number, number, number],
  lod: string | null = null,
): WorkerRequest {
  return {
    type: "fetch",
    id,
    bbox,
    level: 2,
    cells,
    lod,
    hiddenTypes: [],
    rules: [],
    rulesEnabled: false,
  };
}

const box2 = (b: BBox3): [number, number, number, number] => [
  b[0],
  b[1],
  b[3],
  b[4],
];

function intersects(b: BBox3 | null, q: readonly number[]): boolean {
  if (!b) return false;
  return b[0] <= q[2]! && b[3] >= q[0]! && b[1] <= q[3]! && b[4] >= q[1]!;
}

/**
 * A fake adapter over ready-made family models, in the shape the CityParquet
 * adapter yields them: `ownership: "feature"`, bboxes in the header's INDEX
 * space, and — for a header that carries a frame — rings still in lon/lat/h.
 */
function fakeAdapter(
  models: CityModel[],
  header: Pick<StreamHeader, "extent" | "epsg" | "frame">,
): StreamSourceAdapter {
  return {
    ownership: "feature",
    open: (): Promise<OpenedSource> =>
      Promise.resolve({
        header: {
          version: "fake",
          featuresCount: models.length,
          referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/6697",
          ...header,
        },
        admission: null,
      }),
    probe: () => Promise.resolve(models.length),
    async *select(bbox) {
      for (const m of models) if (intersects(m.bbox, bbox)) yield m;
    },
    appearance: () => undefined,
    bakeLod: (lod) => lod,
    close: () => undefined,
  };
}

const openReq = (extras: Partial<OpenRequest> = {}): WorkerRequest => ({
  type: "open",
  id: 0,
  source: { url: "fake://geo" },
  ...extras,
});

// ---------------------------------------------------------------------------
// Synthetic geographic families
// ---------------------------------------------------------------------------

/** A building as lon/lat/h: one roof quad and one wall, through core's real
 *  parser so it triangulates exactly as a decoded row would. */
function geoObject(
  id: string,
  lng: number,
  lat: number,
  opts: { lods?: [string, string]; height?: number } = {},
): CityObject {
  const [lodA, lodB] = opts.lods ?? ["2", "2"];
  const h = opts.height ?? 9;
  const d = 0.0001; // ~9 m east, ~11 m north
  const vertices: Vec3[] = [
    [lng, lat, 0],
    [lng + d, lat, 0],
    [lng + d, lat + d, h],
    [lng, lat + d, h],
  ];
  const raw = {
    type: "Building",
    geometry: [
      {
        type: "MultiSurface",
        lod: lodA,
        boundaries: [[[0, 1, 2, 3]]],
        semantics: { surfaces: [{ type: "RoofSurface" }], values: [0] },
      },
      {
        type: "MultiSurface",
        lod: lodB,
        boundaries: [[[0, 1, 2]]],
        semantics: { surfaces: [{ type: "WallSurface" }], values: [0] },
      },
    ],
  } as unknown as CityJSONObject;
  return parseCityObject(
    id,
    raw,
    dequantizeAll(vertices, { scale: [1, 1, 1], translate: [0, 0, 0] }),
  );
}

/** The bucket-space box of a geographic one, all four horizontal corners. */
function toBucketBBox(
  bbox: BBox3,
  frame: ReturnType<typeof makeLocalMetricFrame>,
): BBox3 {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const lng of [bbox[0], bbox[3]]) {
    for (const lat of [bbox[1], bbox[4]]) {
      const [x, y] = frame.toMetric(lng, lat);
      xs.push(x);
      ys.push(y);
    }
  }
  return [
    Math.min(...xs),
    Math.min(...ys),
    bbox[2],
    Math.max(...xs),
    Math.max(...ys),
    bbox[5],
  ];
}

/** One family model: geographic rings, BUCKET bboxes (index space). */
function geoFamily(
  objects: CityObject[],
  frame: ReturnType<typeof makeLocalMetricFrame>,
): CityModel {
  const out: Record<string, CityObject> = {};
  let union: BBox3 | null = null;
  for (const object of objects) {
    const bucket = toBucketBBox(object.bbox!, frame);
    out[object.id] = { ...object, bbox: bucket };
    union = union
      ? [
          Math.min(union[0], bucket[0]),
          Math.min(union[1], bucket[1]),
          Math.min(union[2], bucket[2]),
          Math.max(union[3], bucket[3]),
          Math.max(union[4], bucket[4]),
          Math.max(union[5], bucket[5]),
        ]
      : bucket;
  }
  return {
    sourceEncoding: "cityparquet",
    metadata: { referenceSystem: "EPSG:6697" },
    bbox: union,
    objects: out,
    vertexCount: 0,
  };
}

// ---------------------------------------------------------------------------
// The ECEF gate
// ---------------------------------------------------------------------------

/** Every distinct source vertex's ECEF position, in doubles. */
function referenceEcef(
  objects: Iterable<CityObject>,
  heightOffset = 0,
): [number, number, number][] {
  const seen = new Set<string>();
  const out: [number, number, number][] = [];
  for (const object of objects) {
    for (const surface of object.surfaces) {
      for (const ring of surface.rings) {
        for (const [lng, lat, z] of ring) {
          const key = `${String(lng)}|${String(lat)}|${String(z)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(geodeticToEcef(lng, lat, z + heightOffset));
        }
      }
    }
  }
  return out;
}

/**
 * Every baked vertex of `cells`, converted to ECEF through its own cell frame
 * and matched to the NEAREST reference vertex: the worst match distance, and
 * which references were hit. Matching by proximity rather than by buffer order
 * is what makes this a per-SOURCE-VERTEX comparison — triangulation is free to
 * emit them in any order, and does.
 */
function matchToReference(
  cells: ReadonlyArray<{ key: string; positions: Float32Array }>,
  frameOf: (key: string) => EnuFrame,
  reference: ReadonlyArray<readonly [number, number, number]>,
): { worst: number; hit: Set<number>; vertices: number } {
  let worst = 0;
  const hit = new Set<number>();
  let vertices = 0;
  for (const cell of cells) {
    const frame = frameOf(cell.key);
    for (let i = 0; i < cell.positions.length; i += 3) {
      const ecef = enuToEcef(frame, [
        cell.positions[i]!,
        cell.positions[i + 1]!,
        cell.positions[i + 2]!,
      ]);
      let best = Infinity;
      let bestIndex = -1;
      for (const [r, ref] of reference.entries()) {
        const d = Math.hypot(
          ecef[0] - ref[0],
          ecef[1] - ref[1],
          ecef[2] - ref[2],
        );
        if (d < best) {
          best = d;
          bestIndex = r;
        }
      }
      if (best > worst) worst = best;
      hit.add(bestIndex);
      vertices++;
    }
  }
  return { worst, hit, vertices };
}

// ---------------------------------------------------------------------------
// The real EPSG:6697 fixture
// ---------------------------------------------------------------------------

const GEOGRAPHIC = "plateau-6697-cityparquet";

async function fixtureBlob(): Promise<Blob> {
  const file = await readFile(
    fileURLToPath(
      new URL(
        `../../navara-cityparquet/tests/fixtures/${GEOGRAPHIC}/building.parquet`,
        import.meta.url,
      ),
    ),
  );
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file);
  return new Blob([bytes]);
}

/** The fixture's rows as the reader yields them: geographic, in batches. */
async function fixtureBatches(blob: Blob): Promise<{
  batches: ReadBatch[];
  extent: BBox3;
  frame: LocalMetricFrameDescriptor;
}> {
  const stream = await openCityParquetStream([asyncBufferFromBlob(blob)]);
  const whole = box2(stream.header.extent);
  const ranges = stream.index.query([
    whole[0] - 1,
    whole[1] - 1,
    whole[2] + 1,
    whole[3] + 1,
  ]);
  const batches: ReadBatch[] = [];
  for await (const batch of stream.readRows(
    ranges,
    null,
    new AbortController().signal,
  )) {
    batches.push(batch);
  }
  return {
    batches,
    extent: stream.header.extent,
    frame: stream.header.frame!,
  };
}

function allObjects(batches: ReadonlyArray<ReadBatch>): CityObject[] {
  return batches.flatMap((b) => Object.values(b.objects));
}

describe("the worker's bake for a geographic (EPSG:6697) source", () => {
  it("places every vertex within 1 cm of a double-precision reference, in common ECEF", async () => {
    const blob = await fixtureBlob();
    const { batches, extent, frame: descriptor } = await fixtureBatches(blob);
    const bucket = localMetricFrameFromDescriptor(descriptor);
    const reference = referenceEcef(allObjects(batches));
    expect(reference.length).toBeGreaterThan(50);

    const grid = makeGrid(extent);
    const cells = keysCovering(grid, box2(extent), 2);
    const { posted, send } = harness(createCityParquetSourceAdapter());
    await send(openReq({ source: { blob } }));
    await send(fetchMsg(1, cells, box2(extent)));
    const baked = posted.filter(ofType("cell")).map((c) => ({
      key: c.key,
      positions: c.geometry.positions,
    }));
    expect(baked.length).toBeGreaterThan(1); // really more than one cell

    const match = matchToReference(
      baked,
      (key) => cellFrame(grid, key, (x, y) => bucket.toLngLat(x, y), 0),
      reference,
    );
    expect(match.worst).toBeLessThan(0.01);
    // Every source vertex really is drawn somewhere, so a "worst" of 0 cannot
    // come from a cell that baked nothing.
    expect(match.hit.size).toBe(reference.length);
  });

  it("agrees with the OLD UTM+ENU path, which is held to the same reference", async () => {
    const blob = await fixtureBlob();
    const { batches } = await fixtureBatches(blob);
    const reference = referenceEcef(allObjects(batches));

    // The path as it was: lon/lat -> UTM zone of the dataset centre (proj4),
    // then UTM -> WGS84 -> ENU per cell (proj4 again, per vertex).
    const stream = await openCityParquetStream([asyncBufferFromBlob(blob)]);
    const geoCentre: [number, number] = [
      stream.header.frame!.lngDeg,
      stream.header.frame!.latDeg,
    ];
    const utm = coordinateTargetFor(6697, geoCentre);
    const utmModels: CityModel[] = [];
    let utmExtent: BBox3 | null = null;
    for (const batch of batches) {
      const objects = { ...batch.objects };
      projectCityObjects(objects, utm);
      for (const model of familyModels({ objects, rows: batch.rows }, [
        -Infinity,
        -Infinity,
        Infinity,
        Infinity,
      ])) {
        utmModels.push(model);
        const b = model.bbox!;
        utmExtent = utmExtent
          ? [
              Math.min(utmExtent[0], b[0]),
              Math.min(utmExtent[1], b[1]),
              Math.min(utmExtent[2], b[2]),
              Math.max(utmExtent[3], b[3]),
              Math.max(utmExtent[4], b[4]),
              Math.max(utmExtent[5], b[5]),
            ]
          : [...b];
      }
    }
    const oldExtent = utmExtent!;
    const oldGrid = makeGrid(oldExtent);
    const toLngLat = proj4(`EPSG:${String(utm.epsg!)}`, "WGS84") as {
      forward(c: [number, number]): [number, number];
    };
    const { posted, send } = harness(
      fakeAdapter(utmModels, {
        extent: oldExtent,
        epsg: utm.epsg,
        frame: null,
      }),
    );
    await send(openReq());
    await send(
      fetchMsg(1, keysCovering(oldGrid, box2(oldExtent), 2), box2(oldExtent)),
    );
    const baked = posted.filter(ofType("cell")).map((c) => ({
      key: c.key,
      positions: c.geometry.positions,
    }));

    const match = matchToReference(
      baked,
      (key) => cellFrame(oldGrid, key, (x, y) => toLngLat.forward([x, y]), 0),
      reference,
    );
    // The same 1 cm gate: both paths within 1 cm of the reference bounds them
    // within 2 cm of each other, and in practice far tighter.
    expect(match.worst).toBeLessThan(0.01);
    expect(match.hit.size).toBe(reference.length);
  });

  it("bakes without building a single proj4 converter", async () => {
    const blob = await fixtureBlob();
    const { extent } = await fixtureBatches(blob);
    const grid = makeGrid(extent);
    const { posted, send } = harness(createCityParquetSourceAdapter());
    await send(openReq({ source: { blob } }));
    const opened = posted.find(ofType("opened"))!;
    expect(opened.header).toMatchObject({
      epsg: null,
      frame: { kind: "local-metric" },
    });

    proj4Calls.count = 0;
    await send(fetchMsg(1, keysCovering(grid, box2(extent), 2), box2(extent)));
    expect(posted.filter(ofType("cell")).length).toBeGreaterThan(1);
    expect(proj4Calls.count).toBe(0);
  });

  it("reports record bboxes in BUCKET space and carries the frame on every cell", async () => {
    const blob = await fixtureBlob();
    const { extent, frame: descriptor } = await fixtureBatches(blob);
    const grid = makeGrid(extent);
    const { posted, send } = harness(createCityParquetSourceAdapter());
    await send(openReq({ source: { blob } }));
    await send(fetchMsg(1, keysCovering(grid, box2(extent), 2), box2(extent)));

    const cells = posted.filter(ofType("cell"));
    for (const cell of cells) expect(cell.frame).toEqual(descriptor);

    // Copy 5 sits ~620 m east of the dataset centre in bucket metres. In
    // lon/lat it would read 139.6x; in its own cell's ENU frame (cell centre
    // 757 m east) it would read about -140. Bucket space is the only reading
    // that gives +6xx, so this pins the SPACE, not just a magnitude.
    const records = cells.flatMap((c) => c.objects);
    const copy5 = records.find((r) => r.id === "NL.IMBAG.Pand.0002_5")!;
    expect(copy5).toBeDefined();
    expect(copy5.bbox[0]).toBeGreaterThan(600);
    expect(copy5.bbox[0]).toBeLessThan(643);
    expect(Math.abs(copy5.bbox[1])).toBeLessThan(10);
    // And every record is inside the header's own extent, which is bucket too.
    for (const record of records) {
      expect(record.bbox[0]).toBeGreaterThanOrEqual(extent[0] - 0.001);
      expect(record.bbox[3]).toBeLessThanOrEqual(extent[3] + 0.001);
    }
  });
});

// ---------------------------------------------------------------------------
// Ownership, metrics, the geoid, and the NaN gate — on synthetic families
// ---------------------------------------------------------------------------

const LNG = 139.6069;
const LAT = 35.5;

/** A bucket frame and a grid whose level-2 cells are 200 m. */
function syntheticSpace(centre: [number, number], half = 300) {
  const frame = makeLocalMetricFrame(centre[0], centre[1]);
  const extent: BBox3 = [-half, -half, 0, half, half, 30];
  const grid: Grid = makeGrid(extent);
  return { frame, extent, grid, descriptor: frame.descriptor };
}

describe("cell ownership in bucket space", () => {
  it("keeps a family whose parts straddle a cell boundary whole, in one cell", async () => {
    // The 6697 fixture has no such family (its six copies are 250 m apart on
    // one axis, each well inside a cell), so the case is built explicitly.
    const { frame, extent, grid, descriptor } = syntheticSpace([LNG, LAT]);
    expect(grid.rootCell / 4).toBe(200); // level 2 = 200 m cells
    // The parent sits just west of the x = -100 boundary (bucket x ~ -108);
    // the part sits ~110 m east of it, in the next cell.
    const west = geoObject("fam", LNG - 0.0012, LAT);
    const east = geoObject("fam-part", LNG + 0.0001, LAT);
    const family = geoFamily([west, east], frame);
    const cells = keysCovering(grid, box2(extent), 2);

    const { posted, send } = harness(
      fakeAdapter([family], { extent, epsg: null, frame: descriptor }),
    );
    await send(openReq());
    await send(fetchMsg(1, cells, box2(extent)));

    const posted2 = posted.filter(ofType("cell"));
    expect(posted2).toHaveLength(1);
    expect(posted2[0]!.objects.map((o) => o.id).sort()).toEqual([
      "fam",
      "fam-part",
    ]);
    // Both parts really have geometry — a part outside its cell must be baked,
    // not dropped. Three triangles each: a roof quad plus a wall.
    expect(posted2[0]!.geometry.triangleCount).toBe(6);
    // And the far part is baked well outside the owning cell's own 200 m box,
    // which is the whole point of feature ownership.
    const xs: number[] = [];
    const positions = posted2[0]!.geometry.positions;
    for (let i = 0; i < positions.length; i += 3) xs.push(positions[i]!);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(100);
  });
});

describe("metrics in the cell's own frame", () => {
  it("agree for the same building sitting in two different cells", async () => {
    const building = geoObject("b", LNG, LAT, { height: 7 });
    const records = [];
    // Two datasets whose bucket frames (and therefore grids and cell centres)
    // differ: the same building lands in a different cell of each.
    for (const centre of [
      [LNG, LAT],
      [LNG + 0.004, LAT + 0.003],
    ] as [number, number][]) {
      const { frame, extent, grid, descriptor } = syntheticSpace(centre, 400);
      const family = geoFamily([building], frame);
      const { posted, send } = harness(
        fakeAdapter([family], { extent, epsg: null, frame: descriptor }),
      );
      await send(openReq());
      await send(
        fetchMsg(1, keysCovering(grid, box2(extent), 2), box2(extent)),
      );
      const cells = posted.filter(ofType("cell"));
      expect(cells).toHaveLength(1);
      records.push({ key: cells[0]!.key, record: cells[0]!.objects[0]! });
    }
    // Different cells, so the two frames are a few hundred metres apart.
    expect(records[0]!.key).not.toBe(records[1]!.key);

    const [a, b] = records.map((r) => r.record);
    expect(a!.footprintAreaSqM).toBeCloseTo(b!.footprintAreaSqM, 3); // 1 mm^2
    expect(a!.volumeCuM ?? 0).toBeCloseTo(b!.volumeCuM ?? 0, 3);
    const roofA = a!.roofMetrics[0]!;
    const roofB = b!.roofMetrics[0]!;
    expect(roofA.areaSqM).toBeCloseTo(roofB.areaSqM, 3);
    expect(Math.abs(roofA.inclinationDeg - roofB.inclinationDeg)).toBeLessThan(
      0.01,
    );
    expect(Math.abs(roofA.azimuthDeg - roofB.azimuthDeg)).toBeLessThan(0.01);
    // Elevation is the one metric that is NOT frame-independent: it is the z of
    // the cell's own tangent plane, so it carries d^2/2R for the building's
    // distance d from the cell centre — about 1.3 cm at 400 m. Measured 3 mm
    // between these two cells.
    expect(Math.abs(roofA.elevationM - roofB.elevationM)).toBeLessThan(0.02);
  });
});

describe("the vertical datum", () => {
  it("raises a newly baked cell by the CURRENT height offset, on every build", async () => {
    const offset = 37.25;
    const building = geoObject("b", LNG, LAT, { lods: ["2", "1"] });
    const { frame, extent, grid, descriptor } = syntheticSpace([LNG, LAT]);
    const family = geoFamily([building], frame);
    const cells = keysCovering(grid, box2(extent), 2);

    const { posted, send } = harness(
      fakeAdapter([family], { extent, epsg: null, frame: descriptor }),
    );
    await send(openReq({ heightOffset: offset }));
    await send(fetchMsg(1, cells, box2(extent), "2"));
    // A LoD REBUILD: the same cells, a different rung, baked afresh — the
    // offset must be applied again rather than only at the first fetch.
    await send(fetchMsg(2, cells, box2(extent), "1"));

    const baked = posted.filter(ofType("cell"));
    expect(baked).toHaveLength(2);
    const raised = referenceEcef([building], offset);
    const unraised = referenceEcef([building], 0);
    for (const cell of baked) {
      const match = matchToReference(
        [{ key: cell.key, positions: cell.geometry.positions }],
        (key) => cellFrame(grid, key, (x, y) => frame.toLngLat(x, y), offset),
        raised,
      );
      expect(match.worst).toBeLessThan(0.01);
      // And NOT where an unraised bake would put them: 37 m away.
      const wrong = matchToReference(
        [{ key: cell.key, positions: cell.geometry.positions }],
        (key) => cellFrame(grid, key, (x, y) => frame.toLngLat(x, y), offset),
        unraised,
      );
      expect(wrong.worst).toBeGreaterThan(30);
    }
  });
});

describe("the coordinate gate", () => {
  it("refuses a non-finite vertex by name, and bakes no cell for it", async () => {
    const { frame, extent, grid, descriptor } = syntheticSpace([LNG, LAT]);
    const bad = geoObject("bldg-nan", LNG, LAT);
    const broken: CityObject = {
      ...bad,
      surfaces: bad.surfaces.map((s, i) =>
        i === 0
          ? {
              ...s,
              rings: s.rings.map((ring) =>
                ring.map((p, v): Vec3 =>
                  v === 1 ? [Number.NaN, p[1], p[2]] : p,
                ),
              ),
            }
          : s,
      ),
    };
    const family = geoFamily([broken], frame);
    const { posted, send } = harness(
      fakeAdapter([family], { extent, epsg: null, frame: descriptor }),
    );
    await send(openReq());
    await send(fetchMsg(1, keysCovering(grid, box2(extent), 2), box2(extent)));

    expect(posted.filter(ofType("cell"))).toEqual([]);
    const error = posted.find(ofType("error"))!;
    expect(error.message).toMatch(/bldg-nan/);
    expect(error.message).toMatch(/longitude\/latitude/);
    // Nothing was left in the worker's cache for the rolled-back key.
    await send({ type: "surfaces", id: 2, objectId: "bldg-nan" });
    expect(posted.filter(ofType("error")).find((e) => e.id === 2)?.code).toBe(
      "not-found",
    );
  });
});
