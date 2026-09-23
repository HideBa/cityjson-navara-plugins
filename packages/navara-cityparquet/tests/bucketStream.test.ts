/**
 * What changes when a streamed EPSG:6697 source is indexed in BUCKET space
 * instead of UTM, and what must not change for a projected one.
 *
 * Three claims:
 *
 * 1. **No proj4.** Opening the 6697 fixture — packing 18 bboxes, building the
 *    index — and reading a family must not build a single proj4 converter. On
 *    Yokohama that pass is about 4 s of a 7.2 s open.
 * 2. **Conservative coverage, not row equality.** The bucket transform and the
 *    UTM projection are different maps, so an axis-aligned box need not select
 *    the same rows. What is binding is that every row the UTM index returned
 *    for a view is still returned.
 * 3. **A projected source is untouched**, field for field and vertex for
 *    vertex, against values captured from the code before the change.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { BBox3 } from "@cityjson/navara-core";
import { localMetricFrameFromDescriptor } from "@cityjson/navara-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readBBox } from "../src/decodeTable";
import type {
  FamilyColumns,
  FamilyIndex,
  FamilyRange,
} from "../src/familyIndex";
import { buildFamilyIndex } from "../src/familyIndex";
import { coordinateTargetFor, projectBBox } from "../src/geographicToProjected";
import type { RangeBuffer } from "../src/rangeSource";
import { asyncBufferFromBlob } from "../src/rangeSource";
import { openCityParquetStream } from "../src/streamReader";
import { readCityParquetTable } from "../src/tableReader";

/**
 * Calls of the proj4 FACTORY. A converter cannot exist without one, so a zero
 * here is also zero per-vertex `forward` calls. `defs` and the rest of proj4's
 * surface are copied onto the spy, because navara-core's metric-CRS gate reads
 * `proj4.defs` on the projected path.
 */
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

const fixture = (dir: string) =>
  fileURLToPath(new URL(`./fixtures/${dir}/building.parquet`, import.meta.url));

async function bytesOf(dir: string): Promise<Uint8Array<ArrayBuffer>> {
  const file = await readFile(fixture(dir));
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file);
  return bytes;
}

async function bufferOf(dir: string): Promise<RangeBuffer> {
  return asyncBufferFromBlob(new Blob([await bytesOf(dir)]));
}

const GEOGRAPHIC = "plateau-6697-cityparquet";
const PROJECTED = "two-buildings-cityparquet";

async function collect(
  stream: Awaited<ReturnType<typeof openCityParquetStream>>,
  ranges: ReadonlyArray<FamilyRange>,
  signal: AbortSignal = new AbortController().signal,
) {
  const batches = [];
  for await (const batch of stream.readRows(ranges, null, signal)) {
    batches.push(batch);
  }
  return batches;
}

beforeEach(() => {
  proj4Calls.count = 0;
});

describe("a streamed EPSG:6697 source", () => {
  it("opens, indexes and reads without building a proj4 converter", async () => {
    const stream = await openCityParquetStream([await bufferOf(GEOGRAPHIC)]);
    expect(proj4Calls.count).toBe(0);

    const [x0, y0, , , y1] = stream.header.extent;
    const ranges = stream.index.query([x0 - 1, y0 - 1, x0 + 40, y1 + 1]);
    const batches = await collect(stream, ranges);
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]!.objects)).toHaveLength(3);
    expect(proj4Calls.count).toBe(0);
  });

  it("builds no converter for a projected source either, as before", async () => {
    // The projected path is untouched: 7415 passes through as an identity, so
    // it never built a converter to begin with — only the metric-units gate
    // (`proj4.defs`) runs, which is not a factory call.
    const stream = await openCityParquetStream([await bufferOf(PROJECTED)]);
    expect(stream.header.epsg).toBe(7415);
    expect(proj4Calls.count).toBe(0);
  });

  it("still budgets and aborts its reads the way it did", async () => {
    // Neither gate knows about coordinates: the byte estimate is read from the
    // footer and the abort check runs before a row is decoded, let alone
    // placed. Pinned here because this is the read path that changed.
    const stream = await openCityParquetStream([await bufferOf(GEOGRAPHIC)]);
    const [x0, y0, , x1, y1] = stream.header.extent;
    const whole = stream.index.query([x0 - 1, y0 - 1, x1 + 1, y1 + 1]);
    expect(stream.index.readCost([x0 - 1, y0 - 1, x1 + 1, y1 + 1])).toBe(18);
    expect(stream.estimateReadBytes(whole, null)).toBeGreaterThan(0);
    expect(stream.estimateReadBytes(whole, "0")).toBeLessThan(
      stream.estimateReadBytes(whole, null),
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(stream, whole, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

/** One table's `bbox` + `parents` columns, packed as the reader packs them. */
function columnsOf(
  rows: ReadonlyArray<Record<string, unknown>>,
): FamilyColumns {
  const n = rows.length;
  const cols = {
    minX: new Float64Array(n).fill(Number.NaN),
    minY: new Float64Array(n).fill(Number.NaN),
    minZ: new Float64Array(n).fill(Number.NaN),
    maxX: new Float64Array(n).fill(Number.NaN),
    maxY: new Float64Array(n).fill(Number.NaN),
    maxZ: new Float64Array(n).fill(Number.NaN),
    isRoot: new Uint8Array(n).fill(1),
  };
  rows.forEach((row, i) => {
    const parents = row.parents;
    cols.isRoot[i] =
      Array.isArray(parents) && parents.some((p) => typeof p === "string")
        ? 0
        : 1;
    const box = readBBox(row.bbox);
    if (box === null) return;
    cols.minX[i] = box[0];
    cols.minY[i] = box[1];
    cols.minZ[i] = box[2];
    cols.maxX[i] = box[3];
    cols.maxY[i] = box[4];
    cols.maxZ[i] = box[5];
  });
  return cols;
}

interface Space {
  toTarget(x: number, y: number): [number, number];
}

/** The index the same rows produce in `space`. */
function indexIn(
  rows: ReadonlyArray<Record<string, unknown>>,
  space: Space,
): FamilyIndex {
  const cols = columnsOf(rows);
  for (let i = 0; i < cols.isRoot.length; i++) {
    const box = [
      cols.minX[i]!,
      cols.minY[i]!,
      cols.minZ[i]!,
      cols.maxX[i]!,
      cols.maxY[i]!,
      cols.maxZ[i]!,
    ] as unknown as BBox3;
    if (!box.every(Number.isFinite)) continue;
    const p = projectBBox(box, space as never);
    cols.minX[i] = p[0];
    cols.minY[i] = p[1];
    cols.maxX[i] = p[3];
    cols.maxY[i] = p[4];
  }
  return buildFamilyIndex([cols]);
}

/** Which rows `index` would read for a GEOGRAPHIC box put through `space`. */
function rowsFor(
  index: FamilyIndex,
  space: Space,
  box: readonly [number, number, number, number],
): Set<number> {
  const p = projectBBox(
    [box[0], box[1], 0, box[2], box[3], 0] as unknown as BBox3,
    space as never,
  );
  const rows = new Set<number>();
  for (const range of index.query([p[0], p[1], p[3], p[4]])) {
    for (let r = range.start; r < range.end; r++) rows.add(r);
  }
  return rows;
}

describe("the bucket index covers what the UTM index returned", () => {
  /**
   * The fixture's six copies, 250 m apart, each about 35 m wide, all in the
   * same thin latitude band. Query boxes are geographic and either cut THROUGH
   * a copy or clear every copy's edge by more than a metre: UTM re-boxes
   * rotated corners (grid convergence 0.813 degrees here), which inflates
   * both a family's box and the query's, so within about 0.2 m of an edge the
   * UTM index legitimately returns a family the box does not geographically
   * touch — measured on this fixture: at 1e-6 degrees (0.09 m) west of copy 1
   * the UTM index returns it and the bucket index does not; at 3e-6 degrees
   * (0.27 m) neither does.
   */
  const boxes: Array<[string, [number, number, number, number]]> = [
    ["the whole extent", [139.5988, 35.4998, 139.6149, 35.5002]],
    ["copy 0, tight", [139.59975, 35.49989, 139.60024, 35.50011]],
    ["copy 3, tight", [139.60802, 35.49989, 139.60851, 35.50011]],
    ["copy 5, at the east edge", [139.61353, 35.49989, 139.6141, 35.50011]],
    ["a box that cuts copy 1 in half", [139.60275, 35.4999, 139.6035, 35.5001]],
    ["a gap between two copies", [139.6008, 35.4999, 139.6018, 35.5001]],
    [
      "a band thinner than the buildings",
      [139.5988, 35.49995, 139.6149, 35.50005],
    ],
    [
      "an oblique corner of the city",
      [139.61357, 35.500016, 139.61417, 35.500076],
    ],
  ];

  it("returns every row the UTM index did, for each of those boxes", async () => {
    const table = await readCityParquetTable(await bytesOf(GEOGRAPHIC));
    // The dataset centre, as the reader computes it from the same bboxes.
    const cols = columnsOf(table.rows);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < cols.isRoot.length; i++) {
      x0 = Math.min(x0, cols.minX[i]!);
      y0 = Math.min(y0, cols.minY[i]!);
      x1 = Math.max(x1, cols.maxX[i]!);
      y1 = Math.max(y1, cols.maxY[i]!);
    }
    const centre: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];

    // The bucket side is the stream's OWN index, through the frame the stream
    // reports; only the "before" is rebuilt here, since the reader no longer
    // has a UTM path for a geographic source.
    const stream = await openCityParquetStream([await bufferOf(GEOGRAPHIC)]);
    expect(stream.header.frame).toEqual({
      kind: "local-metric",
      lngDeg: centre[0],
      latDeg: centre[1],
    });
    const frame = localMetricFrameFromDescriptor(stream.header.frame!);
    const bucket: Space = { toTarget: (x, y) => frame.toMetric(x, y) };
    const utm = coordinateTargetFor(6697, centre);

    const bucketIndex = stream.index;
    const utmIndex = indexIn(table.rows, utm);
    // Same rows, same families, only a different space.
    expect(bucketIndex.rowCount).toBe(utmIndex.rowCount);
    // The UTM "before" as a live number rather than a commit message: UTM
    // zone 54N metres, whose 1284.868 m easting span is bucket space's
    // 1285.082 m times UTM's 0.99980 scale factor at this latitude — a CHANGED
    // number, not a more precise one (Task 2 review, Minor).
    expect(utmIndex.extent.map((v) => Math.round(v))).toEqual([
      373008, 3929371, 0, 374293, 3929401, 12,
    ]);

    for (const [name, box] of boxes) {
      const before = rowsFor(utmIndex, utm, box);
      const after = rowsFor(bucketIndex, bucket, box);
      const missing = [...before].filter((row) => !after.has(row));
      expect(missing, `${name} lost rows`).toEqual([]);
    }
    // The set is not vacuous: the boxes between them select every row, and one
    // of them selects none.
    const all = new Set<number>();
    for (const [, box] of boxes) {
      for (const row of rowsFor(bucketIndex, bucket, box)) all.add(row);
    }
    expect(all.size).toBe(18);
    expect(rowsFor(bucketIndex, bucket, boxes[5]![1]).size).toBe(0);
  });
});

describe("a centre the bucket frame cannot be built about", () => {
  it("is an admission refusal, not a raw RangeError out of openCityParquetStream", () => {
    // `makeLocalMetricFrame` refuses past +/-89.9 degrees, where cos(phi0)
    // collapses — with a plain `RangeError`, which escaped the reader's
    // `NonMetricCrsError`/`AdmissionRefusedError` wrapping and reached the
    // worker as an unexplained error instead of "this source cannot be
    // streamed" (Task 2 review, Minor).
    return expect(
      bufferOf(GEOGRAPHIC).then((buffer) =>
        openCityParquetStream([buffer], { lngLatCentre: [136.9, 89.95] }),
      ),
    ).rejects.toMatchObject({
      name: "AdmissionRefusedError",
      code: "non-metric-crs",
    });
  });
});

describe("a streamed projected (EPSG:7415) source", () => {
  it("opens with the same header it opened with before the bucket path existed", async () => {
    const stream = await openCityParquetStream([await bufferOf(PROJECTED)]);
    // Captured from the code as it stood before this task, field for field —
    // plus `frame: null`, the one field this task adds, saying there is no
    // bucket frame for a source that already has a metric CRS.
    expect(stream.header).toEqual({
      version: "0.1.0-draft",
      objectsCount: 3,
      tables: [{ name: "table-0", rowCount: 3 }],
      extent: [85000, 446000, 0, 85035, 446012, 12.1],
      epsg: 7415,
      frame: null,
      referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/7415",
      lods: ["0", "2.2"],
      unlabelledGeometry: false,
      invalidBBoxRows: 0,
    });
  });

  it("indexes and reads exactly what it read before", async () => {
    const stream = await openCityParquetStream([await bufferOf(PROJECTED)]);
    const ranges = stream.index.query([84999, 445999, 85036, 446013]);
    expect(ranges).toEqual([{ table: 0, start: 0, end: 3 }]);
    expect(stream.estimateReadBytes(ranges, null)).toBe(2299);

    const batches = await collect(stream, ranges);
    expect(batches).toHaveLength(1);
    const objects = batches[0]!.objects;
    expect(Object.keys(objects)).toEqual([
      "NL.IMBAG.Pand.0001",
      "NL.IMBAG.Pand.0001-part1",
      "NL.IMBAG.Pand.0002",
    ]);
    const first = objects["NL.IMBAG.Pand.0001"]!;
    expect(first.surfaces[0]!.rings[0]).toEqual([
      [85000, 446000, 0],
      [85010, 446000, 0],
      [85010, 446008, 0],
      [85000, 446008, 0],
    ]);
    expect(first.bbox).toEqual([85000, 446000, 0, 85010, 446008, 8.4]);
  });
});
