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
import type { BBox3, CityObject, Vec3 } from "../../src/citymodel/types";
import {
  ecefToEnu,
  geodeticToEcef,
  makeEnuFrame,
} from "../../src/geo/enuFrame";
import { buildCityMeshArrays } from "../../src/geometry/buildCityMeshArrays";
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

/**
 * The milestone review's Important 1. With no `fileExtents` entry to seed from,
 * `geodeticRingsToEnu` falls back to a box TIGHT around the rings it has — so a
 * LoD-filtered roof-only object has its box centre in the roof's own plane, and
 * the sub-nanometre residue the conversion leaves there is what
 * `orientExteriorRing` was reading as an inside/outside reference. Measured
 * before the magnitude floor: normal z = -1 for the roof-only bake against +1
 * for the same roof with its ground surface present. The floor is what makes the
 * fallback safe for ONE face; the seed below is what makes it safe for more.
 */
describe("a roof-only bake's normals", () => {
  const roofRing = (h: number): Vec3[] => {
    const d = 0.0003; // ~27 m east, ~33 m north — counter-clockwise from above
    return [
      [CELL_LNG + 0.002, CELL_LAT + 0.002, h],
      [CELL_LNG + 0.002 + d, CELL_LAT + 0.002, h],
      [CELL_LNG + 0.002 + d, CELL_LAT + 0.002 + d, h],
      [CELL_LNG + 0.002, CELL_LAT + 0.002 + d, h],
    ];
  };

  const meshOf = (objects: Record<string, CityObject>) =>
    buildCityMeshArrays(
      {
        sourceEncoding: "cityparquet",
        metadata: {},
        bbox: null,
        objects,
        vertexCount: 0,
      },
      "cell",
      [0, 0, 0],
    );

  it("points an upward-wound flat roof UP with no other surface present", () => {
    const frame = makeEnuFrame(CELL_LNG, CELL_LAT, 0);
    const objects: Record<string, CityObject> = {
      b: objectWith("b", [roofRing(18)], null),
    };
    geodeticRingsToEnu(objects, frame, 0);
    // The tight box really is degenerate in z: a constant geodetic height
    // over ~30 m at ~250 m from the frame origin leaves a z span of 2.1 mm
    // against a 43 m diagonal, and the box centre sits inside the roof's
    // plane, so what is left to read is rounding.
    const box = objects.b!.bbox!;
    expect(box[5] - box[2]).toBeLessThan(5e-3);
    expect(meshOf(objects).normals[2]).toBeGreaterThan(0.99);
  });

  it("agrees with the same roof baked alongside its ground surface", () => {
    const frame = makeEnuFrame(CELL_LNG, CELL_LAT, 0);
    const objects: Record<string, CityObject> = {
      b: objectWith("b", [roofRing(18), roofRing(0)], null),
    };
    geodeticRingsToEnu(objects, frame, 0);
    expect(meshOf(objects).normals[2]).toBeGreaterThan(0.99);
  });
});

/**
 * The fix-round review's N1. The magnitude floor the previous round added to
 * `orientExteriorRing` only covers an object that is literally ONE face: two
 * polygons in the same near-plane hand EACH OTHER a reference far above the
 * floor, and a box drawn tight around just those two inverts the upper one —
 * where the object's own FILE ROW box, which the pre-milestone path handed the
 * heuristic, gets both right. Measured with the real `buildCityMeshArrays`,
 * `normals[2]` of the lower and the upper polygon of a two-part LoD 0
 * footprint:
 *
 * | height step | tight ring box | file row box |
 * |---|---|---|
 * | 0.02 m | lo -1, hi -1 | lo -1, hi -1 |
 * | 0.05 m | lo -1, hi +1 | lo -1, hi -1 |
 * | 0.50 m | lo -1, hi +1 | lo -1, hi -1 |
 * | 2.00 m | lo -1, hi +1 | lo -1, hi -1 |
 *
 * The trigger is ordinary data: `lodAllowed` in the CityParquet reader drops
 * higher-LoD geometry at READ time, so at LoD 0 the object reaching the bake
 * holds only its footprint polygons — and a terrain-following footprint, or one
 * ground plane per wing, steps by centimetres.
 */
describe("a multi-face planar bake's normals", () => {
  // The WGS84 radii at 35.5 deg N: the prime-vertical radius N = a / W and the
  // meridional M = a(1-e^2) / W^3 with W^2 = 1 - e^2 sin^2 phi, so one degree
  // spans N cos(phi) pi/180 = 90730 m east and M pi/180 = 110952 m north.
  // Spelled in metres because the step sizes below ARE the measurement.
  const M_PER_DEG_E = 90730;
  const M_PER_DEG_N = 110952;
  const east = (m: number) => CELL_LNG + m / M_PER_DEG_E;
  const north = (m: number) => CELL_LAT + m / M_PER_DEG_N;

  /** A quad wound CLOCKWISE seen from above, so Newell's normal points DOWN —
   *  what CityJSON specifies for a GroundSurface, outward from the solid. */
  const downQuad = (
    e0: number,
    e1: number,
    n0: number,
    n1: number,
    z: number,
  ): Vec3[] => [
    [east(e0), north(n0), z],
    [east(e0), north(n1), z],
    [east(e1), north(n1), z],
    [east(e1), north(n0), z],
  ];

  const upQuad = (
    e0: number,
    e1: number,
    n0: number,
    n1: number,
    z: number,
  ): Vec3[] => [...downQuad(e0, e1, n0, n1, z)].reverse();

  /** `normals[2]` of the first vertex of each of the two surfaces: a quad
   *  triangulates to two triangles, six vertices, so the second starts at 6. */
  function bakeNormalZ(
    rings: ReadonlyArray<ReadonlyArray<Vec3>>,
    fileExtent: BBox3 | null,
    heightOffset = 0,
  ): { lo: number; hi: number } {
    const frame = makeEnuFrame(CELL_LNG, CELL_LAT, heightOffset);
    const objects: Record<string, CityObject> = {
      f: objectWith("f", rings, null),
    };
    geodeticRingsToEnu(
      objects,
      frame,
      heightOffset,
      fileExtent ? new Map([["f", fileExtent]]) : undefined,
    );
    const arrays = buildCityMeshArrays(
      {
        sourceEncoding: "cityparquet",
        metadata: {},
        bbox: null,
        objects,
        vertexCount: 0,
      },
      "cell",
      [0, 0, 0],
    );
    return { lo: arrays.normals[2]!, hi: arrays.normals[20]! };
  }

  /** Two 20 m x 20 m ground polygons side by side over a 20 m depth, the
   *  eastern one `step` metres higher. */
  const footprint = (step: number): Vec3[][] => [
    downQuad(0, 20, 0, 20, 0),
    downQuad(20, 40, 0, 20, step),
  ];

  /** The file's own row box for that building: the same 40 m x 20 m plan, but
   *  10 m tall, because the file box covers the LoD 2 shell the read dropped. */
  const rowBox = (top = 10): BBox3 => [
    east(0),
    north(0),
    0,
    east(40),
    north(20),
    top,
  ];

  it.each([0.02, 0.05, 0.5, 2])(
    "points both polygons of a %s m-stepped footprint DOWN, given the file's row box",
    (step) => {
      const n = bakeNormalZ(footprint(step), rowBox());
      expect(n.lo).toBeLessThan(-0.99);
      expect(n.hi).toBeLessThan(-0.99);
    },
  );

  it("points two stepped roof planes UP, given the file's row box", () => {
    // 3 m apart over the same 40 m footprint. The tight box puts its centre
    // between them and inverts the LOWER plane; the row box is below both.
    const n = bakeNormalZ(
      [upQuad(0, 20, 0, 20, 10), upQuad(20, 40, 0, 20, 13)],
      rowBox(13),
    );
    expect(n.lo).toBeGreaterThan(0.99);
    expect(n.hi).toBeGreaterThan(0.99);
  });

  it("reads the row box's heights through the SAME datum offset as the rings", () => {
    // The geoid undulation at Nagoya. The rings get `z + heightOffset`; a row
    // box seeded WITHOUT it would sit 37 m below the geometry, put every ground
    // polygon above the box centre, and flip all of them up — a worse fault
    // than the one this test is here for, and invisible at offset 0.
    const n = bakeNormalZ(footprint(0.5), rowBox(), 37.25);
    expect(n.lo).toBeLessThan(-0.99);
    expect(n.hi).toBeLessThan(-0.99);
  });

  it("still inverts the upper polygon with NO row box, above the floor's reach", () => {
    // The honest residue: a CityParquet child row whose bbox columns are null
    // has no file extent, and `orientExteriorRing`'s 2.5e-4 magnitude floor
    // only reaches a step of 2.5e-4 x 44.7 m x 2 = 2.2 cm over this diagonal.
    // Pinned so a future widening of the fix flips a test, not a sentence.
    expect(bakeNormalZ(footprint(0.5), null).hi).toBeGreaterThan(0.99);
    expect(bakeNormalZ(footprint(0.02), null).hi).toBeLessThan(-0.99);
  });
});
