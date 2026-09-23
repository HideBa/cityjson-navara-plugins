/**
 * The EPSG:6697 fixture: a PLATEAU-shaped source — JGD2011 geographic, WKB in
 * lon/lat/h order, gravity-related heights in metres — which is the ONE case
 * the streamed path reprojects twice today. It is `two-buildings` reprojected
 * and relocated to Japan by `make_fixture.py` (see the fixtures README for why
 * that is synthetic and in what way).
 *
 * Two jobs. First, that the fixture really is what it claims: 6697 in its
 * footer, coordinates that look like lon/lat, heights unchanged from the 7415
 * source. Second, what the stream path makes of it: bucket-space index
 * coordinates and rings left geographic, with the UTM numbers the same tests
 * pinned before the change recorded beside each assertion.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { makeLocalMetricFrame } from "@cityjson/navara-core";
import { describe, expect, it } from "vitest";
import { decodeTableObjects } from "../src/decodeTable";
import type { RangeBuffer } from "../src/rangeSource";
import { asyncBufferFromBlob } from "../src/rangeSource";
import { openCityParquetStream } from "../src/streamReader";
import { readCityParquetTable } from "../src/tableReader";

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

const FIXTURE = "plateau-6697-cityparquet";
const COPIES = 6;
/** The copies' east step, in metres of the fixture's own latitude. */
const STEP_M = 250;
const SOURCE_IDS = [
  "NL.IMBAG.Pand.0001",
  "NL.IMBAG.Pand.0001-part1",
  "NL.IMBAG.Pand.0002",
];

/** Generous, but only satisfiable by degrees around Tokyo Bay. */
const LNG_RANGE = [139.0, 140.0] as const;
const LAT_RANGE = [35.0, 36.0] as const;

const inLngRange = (v: number) => v > LNG_RANGE[0] && v < LNG_RANGE[1];
const inLatRange = (v: number) => v > LAT_RANGE[0] && v < LAT_RANGE[1];

describe(`${FIXTURE} fixture`, () => {
  it("declares EPSG:6697 in its footer", async () => {
    const table = await readCityParquetTable(await bytesOf(FIXTURE));
    expect(table.footer.epsg).toBe(6697);
  });

  it("decodes to 6 copies of the source family, in lon/lat with the source's heights", async () => {
    const source = decodeTableObjects(
      await readCityParquetTable(await bytesOf("two-buildings-cityparquet")),
    );
    const objects = decodeTableObjects(
      await readCityParquetTable(await bytesOf(FIXTURE)),
    );
    expect(Object.keys(objects)).toHaveLength(COPIES * SOURCE_IDS.length);

    for (let k = 0; k < COPIES; k++) {
      for (const id of SOURCE_IDS) {
        const src = source[id]!;
        const copy = objects[`${id}_${k}`];
        expect(copy, `${id}_${k}`).toBeDefined();
        expect(copy!.objectType).toBe(src.objectType);
        expect(copy!.parents).toEqual(src.parents.map((p) => `${p}_${k}`));
        expect(copy!.surfaces).toHaveLength(src.surfaces.length);

        // Every vertex: x is a longitude, y is a latitude, z is the source's
        // own height — the reprojection is horizontal only.
        for (let s = 0; s < src.surfaces.length; s++) {
          const got = copy!.surfaces[s]!.rings;
          const want = src.surfaces[s]!.rings;
          expect(got).toHaveLength(want.length);
          for (let r = 0; r < want.length; r++) {
            expect(got[r]).toHaveLength(want[r]!.length);
            for (let v = 0; v < want[r]!.length; v++) {
              const [x, y, z] = got[r]![v]!;
              expect(inLngRange(x), `x ${String(x)}`).toBe(true);
              expect(inLatRange(y), `y ${String(y)}`).toBe(true);
              expect(z).toBe(want[r]![v]![2]);
            }
          }
        }

        const [x0, y0, z0, x1, y1, z1] = copy!.bbox!;
        expect(inLngRange(x0) && inLngRange(x1)).toBe(true);
        expect(inLatRange(y0) && inLatRange(y1)).toBe(true);
        expect(z0).toBeCloseTo(src.bbox![2], 6);
        expect(z1).toBeCloseTo(src.bbox![5], 6);
      }
    }
  });

  it("spreads its copies over about 1.25 km, enough for several 100 m cells", async () => {
    const objects = decodeTableObjects(
      await readCityParquetTable(await bytesOf(FIXTURE)),
    );
    const first = objects[`${SOURCE_IDS[0]!}_0`]!.bbox!;
    const last = objects[`${SOURCE_IDS[0]!}_${COPIES - 1}`]!.bbox!;
    // Degrees of longitude, converted at the fixture's latitude (~90.7 km/deg).
    const eastM = (last[0] - first[0]) * 90729.39;
    expect(eastM).toBeCloseTo((COPIES - 1) * STEP_M, 0);
  });
});

/**
 * These two tests were written against today's proj4/UTM stream path and are
 * MIGRATED here, not replaced: the numbers the UTM path produced stay recorded
 * beside each bucket-space assertion (they are in the fixtures README too), so
 * the change of index space is visible rather than forgotten.
 */
describe(`${FIXTURE} through the bucket-space stream path`, () => {
  it("opens with no EPSG, a bucket frame at the data centre, and the bucket-space extent", async () => {
    const stream = await openCityParquetStream([await bufferOf(FIXTURE)]);
    // BEFORE (proj4/UTM): epsg 32654 — floor((139.6 + 180) / 6) + 1 = 54,
    // north of the equator. No EPSG code names a local metric frame, so the
    // stream reports none and carries the frame instead.
    expect(stream.header.epsg).toBeNull();
    expect(stream.header.frame).toEqual({
      kind: "local-metric",
      // The centre of the fixture's own geographic extent, as `sourceCentre`
      // computes it over every valid row's bbox.
      lngDeg: (139.59980697706857 + 139.61397087418294) / 2,
      latDeg: (35.499943864086234 + 35.500056135368396) / 2,
    });
    // Provenance, not the index space: the source CRS the rows are still in.
    expect(stream.header.referenceSystem).toBe(
      "https://www.opengis.net/def/crs/EPSG/0/6697",
    );
    expect(stream.header.objectsCount).toBe(COPIES * SOURCE_IDS.length);
    expect(stream.header.lods).toEqual(["0", "2.2"]);
    expect(stream.header.invalidBBoxRows).toBe(0);

    // The INDEPENDENT oracle: the fixture's geographic extent through a frame
    // this test builds itself.
    const frame = makeLocalMetricFrame(
      stream.header.frame!.lngDeg,
      stream.header.frame!.latDeg,
    );
    const [bx0, by0] = frame.toMetric(139.59980697706857, 35.499943864086234);
    const [bx1, by1] = frame.toMetric(139.61397087418294, 35.500056135368396);
    const [x0, y0, z0, x1, y1, z1] = stream.header.extent;
    expect(x0).toBeCloseTo(bx0, 6);
    expect(y0).toBeCloseTo(by0, 6);
    expect(x1).toBeCloseTo(bx1, 6);
    expect(y1).toBeCloseTo(by1, 6);
    // Metres about the centre, so the extent is symmetric about 0.
    expect(x0).toBeCloseTo(-642.540883, 6);
    expect(y0).toBeCloseTo(-6.228236, 6);
    expect(x1).toBeCloseTo(642.540883, 6);
    expect(y1).toBeCloseTo(6.228236, 6);
    // BEFORE (proj4/UTM), from pyproj's EPSG:6668 -> EPSG:32654 over the
    // fixture's 18 bboxes, four corners each:
    //   x 373007.914..374292.783, y 3929370.557..3929400.590
    // 1285 m of easting either way: 5 * 250 m of copy step plus a 35 m
    // building. The 0.21 m difference in the span is UTM's scale factor
    // (0.99980 at 139.6E/35.5N) — a CHANGED number, not a more precise one.
    expect(x1 - x0).toBeCloseTo(1285.082, 3);
    expect(1284.868 / (x1 - x0)).toBeCloseTo(0.99983, 5);
    // Heights are untouched in either space.
    expect(z0).toBe(0);
    expect(z1).toBeCloseTo(12.1, 6);
  });

  it("reads one family whose rings are still lon/lat/h", async () => {
    const stream = await openCityParquetStream([await bufferOf(FIXTURE)]);
    const [x0, y0, , , y1] = stream.header.extent;
    // A box tight around the first copy, in bucket metres: the other five are
    // 250 m east.
    const ranges = stream.index.query([x0 - 1, y0 - 1, x0 + 40, y1 + 1]);
    expect(ranges).toHaveLength(1);

    const batches = [];
    for await (const batch of stream.readRows(
      ranges,
      null,
      new AbortController().signal,
    )) {
      batches.push(batch);
    }
    expect(batches).toHaveLength(1);
    const objects = batches[0]!.objects;
    expect(Object.keys(objects)).toEqual(SOURCE_IDS.map((id) => `${id}_0`));

    // BEFORE, the rings came back in UTM 54N metres (373007..374292 east,
    // 3929370..3929400 north). They now arrive as the file stores them —
    // lon/lat/h doubles — because the worker converts each cell into its own
    // ENU frame.
    for (const object of Object.values(objects)) {
      for (const surface of object.surfaces) {
        for (const ring of surface.rings) {
          for (const [x, y] of ring) {
            expect(inLngRange(x), `x ${String(x)}`).toBe(true);
            expect(inLatRange(y), `y ${String(y)}`).toBe(true);
          }
        }
      }
      // The object's own bbox stays geographic with it: the worker decides
      // ownership from it, in bucket space, before any conversion.
      const [ox0, oy0, , ox1, oy1] = object.bbox!;
      expect(inLngRange(ox0) && inLngRange(ox1)).toBe(true);
      expect(inLatRange(oy0) && inLatRange(oy1)).toBe(true);
    }
  });
});
