/**
 * The bucket frame: one closed-form local metric transform about a dataset
 * centre. It is an INDEX space (the family index, the tile grid, the camera
 * footprint and cell centres), NOT geometry — the last test in this file is
 * here to make that impossible to forget.
 */
import { describe, expect, it } from "vitest";
import {
  ecefToEnu,
  geodeticToEcef,
  makeEnuFrame,
} from "../../src/geo/enuFrame";
import {
  localMetricFrameFromDescriptor,
  makeLocalMetricFrame,
} from "../../src/geo/localMetricFrame";

/** Yokohama-ish: inside EPSG:6697's area of use, and the plan's worked centre. */
const LNG0 = 139.6;
const LAT0 = 35.5;

/**
 * Independent oracle, computed in Python from the pinned formula
 * (a = 6378137, f = 1/298.257223563, phi0 = 35.5 deg):
 *
 *   N = a / sqrt(1 - e2 sin^2 phi0)              = 6385348.379355028
 *   M = a (1 - e2) / (1 - e2 sin^2 phi0)^1.5     = 6356952.944056925
 *   pi/180 * N * cos phi0                        = 90729.39141280644
 *   pi/180 * M                                   = 110949.75926814025
 */
const METRES_PER_DEGREE_LNG = 90729.39141280644;
const METRES_PER_DEGREE_LAT = 110949.75926814025;

describe("makeLocalMetricFrame", () => {
  it("scales degrees by the WGS84 prime-vertical and meridional radii at the centre latitude", () => {
    const frame = makeLocalMetricFrame(LNG0, LAT0);
    expect(frame.metresPerDegreeLng).toBeCloseTo(METRES_PER_DEGREE_LNG, 6);
    expect(frame.metresPerDegreeLat).toBeCloseTo(METRES_PER_DEGREE_LAT, 6);

    // One degree east and one degree north of the origin, by the formula.
    const [x, y] = frame.toMetric(LNG0 + 1, LAT0 + 1);
    expect(x).toBeCloseTo(METRES_PER_DEGREE_LNG, 6);
    expect(y).toBeCloseTo(METRES_PER_DEGREE_LAT, 6);
  });

  it("puts the centre at the origin", () => {
    const frame = makeLocalMetricFrame(LNG0, LAT0);
    expect(frame.toMetric(LNG0, LAT0)).toEqual([0, 0]);
    expect(frame.toLngLat(0, 0)).toEqual([LNG0, LAT0]);
  });

  it("round-trips lng/lat -> metres -> lng/lat to 1e-9 degrees", () => {
    const frame = makeLocalMetricFrame(LNG0, LAT0);
    for (const [lng, lat] of [
      [LNG0, LAT0],
      [139.7, 35.6],
      [139.20125, 35.91234],
      [140.4, 34.8],
      [139.6, 35.500001],
    ] as const) {
      const [x, y] = frame.toMetric(lng, lat);
      const [backLng, backLat] = frame.toLngLat(x, y);
      expect(Math.abs(backLng - lng)).toBeLessThan(1e-9);
      expect(Math.abs(backLat - lat)).toBeLessThan(1e-9);
    }
  });

  it("is linear, so a metric delta does not depend on where it is measured", () => {
    const frame = makeLocalMetricFrame(LNG0, LAT0);
    const [x1] = frame.toMetric(LNG0 + 0.5, LAT0);
    const [x2] = frame.toMetric(LNG0 + 1.5, LAT0);
    expect(x2 - x1).toBeCloseTo(METRES_PER_DEGREE_LNG, 6);
  });
});

describe("the frame descriptor", () => {
  it("survives structuredClone and rebuilds an identical transform", () => {
    const frame = makeLocalMetricFrame(LNG0, LAT0);
    // What postMessage does to it: a plain object, no functions, no prototype
    // tricks. structuredClone throws on anything that would not cross.
    const clone = structuredClone(frame.descriptor);
    expect(clone).toEqual(frame.descriptor);

    const rebuilt = localMetricFrameFromDescriptor(clone);
    expect(rebuilt.metresPerDegreeLng).toBe(frame.metresPerDegreeLng);
    expect(rebuilt.metresPerDegreeLat).toBe(frame.metresPerDegreeLat);
    for (const [lng, lat] of [
      [139.7, 35.6],
      [139.20125, 35.91234],
    ] as const) {
      // Bit-for-bit: the two sides of a postMessage must bucket identically.
      expect(rebuilt.toMetric(lng, lat)).toEqual(frame.toMetric(lng, lat));
    }
    for (const [x, y] of [
      [1234.5, -6789.25],
      [0, 0],
    ] as const) {
      expect(rebuilt.toLngLat(x, y)).toEqual(frame.toLngLat(x, y));
    }
  });

  it("is tagged, so a consumer can tell it apart from another frame kind", () => {
    expect(makeLocalMetricFrame(LNG0, LAT0).descriptor.kind).toBe(
      "local-metric",
    );
  });

  it("refuses a descriptor that is not a usable local metric frame", () => {
    expect(() =>
      localMetricFrameFromDescriptor({
        kind: "local-metric",
        lngDeg: Number.NaN,
        latDeg: LAT0,
      }),
    ).toThrow();
    expect(() =>
      localMetricFrameFromDescriptor({
        kind: "local-metric",
        lngDeg: LNG0,
        latDeg: 90,
      }),
    ).toThrow();
  });
});

describe("the bucket frame is NOT ENU", () => {
  /** True ENU about the same origin, for the comparison below. */
  const enuOf = (lng: number, lat: number): [number, number, number] =>
    ecefToEnu(makeEnuFrame(LNG0, LAT0, 0), geodeticToEcef(lng, lat, 0));

  it("differs from true ENU by 12.6 m at 15 km east and 28.2 m diagonally", () => {
    const frame = makeLocalMetricFrame(LNG0, LAT0);

    // 15 km due east in bucket space. True ENU puts the same geodetic point
    // 12.567 m NORTH of the frame's x axis and 17.618 m below its tangent
    // plane: the bucket frame's "y = 0" is a parallel, not a geodesic.
    const [eastLng, eastLat] = frame.toLngLat(15000, 0);
    const east = enuOf(eastLng, eastLat);
    expect(east[0]).toBeCloseTo(14999.979, 2);
    expect(east[1]).toBeCloseTo(12.567, 2);
    expect(east[2]).toBeCloseTo(-17.618, 2);
    expect(Math.hypot(east[0] - 15000, east[1] - 0)).toBeCloseTo(12.567, 2);

    // 15 km east and 15 km north: 28.2 m of horizontal disagreement. Tens of
    // metres, at a distance a city dataset spans every day — which is why
    // geometry is baked in a per-cell ENU frame and never in this one.
    const [dLng, dLat] = frame.toLngLat(15000, 15000);
    const diag = enuOf(dLng, dLat);
    expect(diag[0]).toBeCloseTo(14974.803, 2);
    expect(diag[1]).toBeCloseTo(15012.701, 2);
    expect(Math.hypot(diag[0] - 15000, diag[1] - 15000)).toBeCloseTo(28.217, 2);
  });

  it("shrinks quadratically, to 20 mm at one stream cell's scale (400 m)", () => {
    // The disagreement goes as the square of the distance, which is the whole
    // reason the split works: three orders of magnitude smaller at a cell's
    // scale than at a city's. A cell's own ENU frame sits at the cell CENTRE,
    // so a real cell vertex is nearer than this and errs by less.
    const frame = makeLocalMetricFrame(LNG0, LAT0);
    const [lng, lat] = frame.toLngLat(400, 400);
    const enu = enuOf(lng, lat);
    expect(Math.hypot(enu[0] - 400, enu[1] - 400)).toBeCloseTo(0.0200, 3);
  });
});
