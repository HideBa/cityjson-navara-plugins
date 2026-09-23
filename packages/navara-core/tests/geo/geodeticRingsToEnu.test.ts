/**
 * Bulk lon/lat/h -> local-ENU conversion, the streamed geographic path's one
 * placement step (`docs/plans/2026-09-23-geographic-to-enu.md`, Architecture
 * -> render space). Arithmetic only: no proj4, because a geographic source's
 * coordinates are ALREADY geodetic.
 *
 * The reference is the definition itself, spelled out per vertex:
 * `ecefToEnu(frame, geodeticToEcef(lon, lat, z + heightOffset))`. This file
 * therefore pins the CONTRACT (rings replaced, bbox re-boxed in the same
 * space, the height offset applied, a non-coordinate refused), not the
 * arithmetic, which `enuFrame.test.ts` already owns.
 */
import { describe, expect, it } from "vitest";
import type { CityObject, Vec3 } from "../../src/citymodel/types";
import {
  ecefToEnu,
  geodeticToEcef,
  makeEnuFrame,
} from "../../src/geo/enuFrame";
import { geodeticRingsToEnu } from "../../src/geo/sourceToEnu";

/** A cell of the real 6697 fixture's neighbourhood (Nagoya, PLATEAU). */
const CELL_LNG = 136.9;
const CELL_LAT = 35.5;

function objectWith(
  id: string,
  rings: ReadonlyArray<ReadonlyArray<Vec3>>,
  bbox: CityObject["bbox"],
): CityObject {
  return {
    id,
    objectType: "Building",
    attributes: {},
    bbox,
    lod: "2",
    parents: [],
    children: [],
    surfaces: rings.map((ring) => ({
      type: "RoofSurface",
      lod: "2",
      rings: [ring],
      attributes: {},
    })),
  } as unknown as CityObject;
}

/** A 20 m-ish quad of lon/lat/h, offset from the cell centre. */
function quad(dLng: number, dLat: number, z: number): Vec3[] {
  const e = 0.0001;
  return [
    [CELL_LNG + dLng, CELL_LAT + dLat, z],
    [CELL_LNG + dLng + e, CELL_LAT + dLat, z],
    [CELL_LNG + dLng + e, CELL_LAT + dLat + e, z + 3],
    [CELL_LNG + dLng, CELL_LAT + dLat + e, z + 3],
  ];
}

const bboxOfRings = (rings: ReadonlyArray<ReadonlyArray<Vec3>>) => {
  const all = rings.flat();
  const at = (i: 0 | 1 | 2) => all.map((p) => p[i]);
  return [
    Math.min(...at(0)),
    Math.min(...at(1)),
    Math.min(...at(2)),
    Math.max(...at(0)),
    Math.max(...at(1)),
    Math.max(...at(2)),
  ] as CityObject["bbox"];
};

describe("geodeticRingsToEnu", () => {
  it("places every vertex exactly where the frame's definition puts it", () => {
    const frame = makeEnuFrame(CELL_LNG, CELL_LAT, 0);
    const rings = [quad(0.0005, 0.0005, 12), quad(-0.0009, 0.0002, 4)];
    const objects: Record<string, CityObject> = {
      a: objectWith("a", rings, bboxOfRings(rings)),
    };

    geodeticRingsToEnu(objects, frame, 0);

    const converted = objects.a!.surfaces.map((s) => s.rings[0]!);
    for (const [s, ring] of converted.entries()) {
      for (const [v, point] of ring.entries()) {
        const source = rings[s]![v]!;
        const want = ecefToEnu(
          frame,
          geodeticToEcef(source[0], source[1], source[2]),
        );
        for (const axis of [0, 1, 2] as const) {
          expect(point[axis]).toBeCloseTo(want[axis], 9);
        }
      }
    }
    // Sanity: a vertex ~45 m east of the centre really lands ~45 m east.
    expect(converted[0]![0]![0]).toBeGreaterThan(30);
    expect(converted[0]![0]![0]).toBeLessThan(60);
  });

  it("adds the height offset to every vertex, as a projection at that offset would", () => {
    const offset = 37.25;
    const rings = [quad(0.0003, -0.0004, 9)];
    const bbox = bboxOfRings(rings);
    const frame = makeEnuFrame(CELL_LNG, CELL_LAT, offset);
    const objects: Record<string, CityObject> = {
      a: objectWith("a", rings, bbox),
    };

    geodeticRingsToEnu(objects, frame, offset);

    const ring = objects.a!.surfaces[0]!.rings[0]!;
    for (const [v, point] of ring.entries()) {
      const source = rings[0]![v]!;
      const want = ecefToEnu(
        frame,
        geodeticToEcef(source[0], source[1], source[2] + offset),
      );
      for (const axis of [0, 1, 2] as const) {
        expect(point[axis]).toBeCloseTo(want[axis], 9);
      }
    }
    // The offset is in BOTH the frame origin and the vertex height, so the
    // local z is the source z back again (to curvature, < 1 mm at 40 m).
    expect(ring[0]![2]).toBeCloseTo(9, 3);
  });

  it("re-boxes each object's bbox into the SAME space as its rings", () => {
    // `buildCityMeshArrays` orients an exterior ring against the object's bbox
    // CENTRE, so a bbox left in another space flips roughly half the surfaces.
    const frame = makeEnuFrame(CELL_LNG, CELL_LAT, 0);
    const rings = [quad(0.001, 0.001, 5)];
    const objects: Record<string, CityObject> = {
      a: objectWith("a", rings, bboxOfRings(rings)),
    };

    geodeticRingsToEnu(objects, frame, 0);

    const bbox = objects.a!.bbox!;
    const ring = objects.a!.surfaces[0]!.rings[0]!;
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    expect(bbox[0]).toBeCloseTo(Math.min(...xs), 6);
    expect(bbox[3]).toBeCloseTo(Math.max(...xs), 6);
    expect(bbox[1]).toBeCloseTo(Math.min(...ys), 6);
    expect(bbox[4]).toBeCloseTo(Math.max(...ys), 6);
    // Metres, not degrees: the bbox is no longer a lon/lat box.
    expect(bbox[0]).toBeGreaterThan(50);
  });

  it("nulls the bbox of an object with no rings rather than trusting its space", () => {
    // A family's parent Building often has its geometry only in its parts, so
    // it arrives with a bbox and nothing to re-box from. This function reads
    // ONLY rings, so it never has to be told which space that bbox was in —
    // and it must not guess: the stream worker's boxes are BUCKET metres, which
    // look exactly like a plausible lon/lat pair. The worker keeps those boxes
    // and hands them to `toObjectRecords` itself.
    const frame = makeEnuFrame(CELL_LNG, CELL_LAT, 0);
    const bbox = bboxOfRings([quad(0.0004, 0.0004, 0)]);
    const objects: Record<string, CityObject> = {
      p: objectWith("p", [], bbox),
    };

    geodeticRingsToEnu(objects, frame, 0);

    expect(objects.p!.bbox).toBeNull();
  });

  it("gives an object that arrived without a bbox the box of its rings", () => {
    const frame = makeEnuFrame(CELL_LNG, CELL_LAT, 0);
    const objects: Record<string, CityObject> = {
      a: objectWith("a", [quad(0, 0, 1)], null),
    };
    geodeticRingsToEnu(objects, frame, 0);
    expect(objects.a!.bbox).not.toBeNull();
  });

  it("refuses a non-finite vertex, naming the object", () => {
    // Task 2 took the per-vertex `validateLonLat` out of the READ path, so
    // this conversion is the first gate a bad row meets: without it a NaN
    // becomes NaN geometry, which triangulates into an invisible cell.
    const frame = makeEnuFrame(CELL_LNG, CELL_LAT, 0);
    const bad = quad(0.0002, 0.0002, 3);
    bad[2] = [Number.NaN, CELL_LAT, 3];
    const objects: Record<string, CityObject> = {
      "bldg-7": objectWith("bldg-7", [bad], bboxOfRings([bad])),
    };
    expect(() => geodeticRingsToEnu(objects, frame, 0)).toThrow(/bldg-7/);
    expect(() => geodeticRingsToEnu(objects, frame, 0)).toThrow(
      /longitude\/latitude/,
    );
  });

  it("refuses a non-finite HEIGHT, naming the object", () => {
    // Same failure mode as a NaN longitude and just as invisible: a NaN z
    // makes NaN ECEF, so the vertex lands nowhere and the surface it belongs
    // to draws nothing. `assertGeographic` gated lng/lat only until the
    // geographic-to-ENU milestone's cleanup.
    const frame = makeEnuFrame(CELL_LNG, CELL_LAT, 0);
    for (const z of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const ring = quad(0.0002, 0.0002, 3);
      ring[2] = [ring[2]![0], ring[2]![1], z];
      const objects: Record<string, CityObject> = {
        "bldg-9": objectWith("bldg-9", [ring], bboxOfRings([quad(0, 0, 0)])),
      };
      expect(() => geodeticRingsToEnu(objects, frame, 0)).toThrow(/bldg-9/);
      expect(() => geodeticRingsToEnu(objects, frame, 0)).toThrow(/height/);
    }
  });

  it("refuses an out-of-range longitude or latitude", () => {
    const frame = makeEnuFrame(CELL_LNG, CELL_LAT, 0);
    for (const bogus of [
      [200, CELL_LAT, 0] as Vec3,
      [CELL_LNG, 95, 0] as Vec3,
    ]) {
      const ring = quad(0, 0, 0);
      ring[1] = bogus;
      const objects: Record<string, CityObject> = {
        x: objectWith("x", [ring], bboxOfRings([ring])),
      };
      expect(() => geodeticRingsToEnu(objects, frame, 0)).toThrow(RangeError);
    }
  });
});
