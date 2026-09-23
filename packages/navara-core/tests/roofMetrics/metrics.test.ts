import { describe, it, expect } from "vitest";
import {
  computeArea,
  computeInclination,
  computeAzimuth,
  computeElevation,
  computeRoofMetrics,
} from "../../src/roofMetrics/metrics";
import type { Vec3 } from "../../src/citymodel/types";
import type { Surface } from "../../src/citymodel/types";

// ---------------------------------------------------------------------------
// Known geometry fixtures (CityJSON coords: X=easting, Y=northing, Z=height)
// ---------------------------------------------------------------------------

/** Flat 1×1 square at ground level. Area = 1.0, inclination = 0°. */
const FLAT_SQUARE: ReadonlyArray<Vec3> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
];

/** Right triangle with base=3, height=4. Area = 6.0. */
const RIGHT_TRIANGLE: ReadonlyArray<Vec3> = [
  [0, 0, 0],
  [3, 0, 0],
  [0, 4, 0],
];

/**
 * South-facing vertical wall (normal points in -Y direction).
 * Inclination = 90°, azimuth = 180° (south).
 */
const SOUTH_WALL: ReadonlyArray<Vec3> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 0, 1],
  [0, 0, 1],
];

/**
 * East-facing vertical wall (normal points in +X direction).
 * Inclination = 90°, azimuth = 90° (east).
 */
const EAST_WALL: ReadonlyArray<Vec3> = [
  [0, 0, 0],
  [0, 1, 0],
  [0, 1, 1],
  [0, 0, 1],
];

/**
 * 45° south-facing slope.
 * Normal has equal Z and -Y components → inclination = 45°, azimuth = 180°.
 */
const SOUTH_45_SLOPE: ReadonlyArray<Vec3> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 1],
  [0, 1, 1],
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeArea", () => {
  it("returns 1.0 for a unit square", () => {
    expect(computeArea(FLAT_SQUARE)).toBeCloseTo(1.0, 5);
  });

  it("returns 6.0 for a 3×4 right triangle", () => {
    expect(computeArea(RIGHT_TRIANGLE)).toBeCloseTo(6.0, 5);
  });

  it("returns 0 for degenerate ring with < 3 vertices", () => {
    expect(
      computeArea([
        [0, 0, 0],
        [1, 0, 0],
      ]),
    ).toBe(0);
  });

  it("returns 0 for empty ring", () => {
    expect(computeArea([])).toBe(0);
  });
});

describe("computeInclination", () => {
  it("returns 0° for a flat horizontal surface", () => {
    expect(computeInclination(FLAT_SQUARE)).toBeCloseTo(0, 1);
  });

  it("returns 90° for a vertical wall", () => {
    expect(computeInclination(SOUTH_WALL)).toBeCloseTo(90, 1);
  });

  it("returns 45° for a 45-degree slope", () => {
    expect(computeInclination(SOUTH_45_SLOPE)).toBeCloseTo(45, 1);
  });

  it("returns 0 for degenerate ring", () => {
    expect(
      computeInclination([
        [0, 0, 0],
        [1, 0, 0],
      ]),
    ).toBe(0);
  });
});

describe("computeAzimuth", () => {
  it("returns 180° for a south-facing surface", () => {
    expect(computeAzimuth(SOUTH_WALL)).toBeCloseTo(180, 1);
  });

  it("returns 90° for an east-facing surface", () => {
    expect(computeAzimuth(EAST_WALL)).toBeCloseTo(90, 1);
  });

  it("returns null for a flat surface (no horizontal component)", () => {
    // A vertical normal has no horizontal direction, so the surface has no
    // aspect. Null, not 0: 0 is due north, and something HAS to distinguish
    // "faces north" from "faces nowhere".
    expect(computeAzimuth(FLAT_SQUARE)).toBeNull();
  });

  it("returns 180° for a south-facing 45° slope", () => {
    expect(computeAzimuth(SOUTH_45_SLOPE)).toBeCloseTo(180, 1);
  });

  /**
   * The flatness convention, at the threshold. A surface tilted by less than
   * FLAT_INCLINATION_DEG has no aspect, because at that scale the tilt is as
   * likely to be the frame's as the roof's: a level ENU frame is tangent at ONE
   * point, so a surface of constant geodetic height leans away from it by d/R
   * — 0.0036 deg at 400 m, and measured at 0.0012 deg for a streamed cell.
   * Reading a bearing off that made the SAME roof face 225 deg in one cell and
   * 245 deg in another (the review's Important 3 measured a 183 deg flip).
   */
  describe("the flatness convention", () => {
    /** A 40 m square whose north edge is `deg` degrees higher than its south
     *  edge, so it faces SOUTH — azimuth 180 — by however much it leans. */
    const leaning = (deg: number): ReadonlyArray<Vec3> => {
      const rise = 40 * Math.tan((deg * Math.PI) / 180);
      return [
        [0, 0, 0],
        [40, 0, 0],
        [40, 40, rise],
        [0, 40, rise],
      ];
    };

    it("has no azimuth below a tenth of a degree", () => {
      // 0.0036 deg is the worst tangent-plane tilt a 400 m cell can impose;
      // 0.05 deg is 14x that and still not an aspect.
      for (const deg of [0.0001, 0.0036, 0.05, 0.0999]) {
        expect(computeInclination(leaning(deg))).toBeCloseTo(deg, 4);
        expect(computeAzimuth(leaning(deg))).toBeNull();
      }
    });

    it("reads a real bearing from a tenth of a degree up", () => {
      // Two orders of magnitude below anything a user calls pitched, so the
      // convention cannot swallow a roof: a 1-in-100 drainage fall is 0.57 deg.
      for (const deg of [0.1, 0.57, 5, 30]) {
        expect(computeAzimuth(leaning(deg))).toBeCloseTo(180, 1);
      }
    });

    it("gives the same answer in two frames a cell apart", () => {
      // The defect in miniature: one constant-height surface, seen from two
      // tangent planes 360 m apart, leans towards each of their origins in
      // turn — opposite bearings from identical geometry.
      const tiltDeg = ((360 / 6371000) * 180) / Math.PI; // d/R, in degrees
      expect(tiltDeg).toBeCloseTo(0.0032, 4);
      expect(computeAzimuth(leaning(tiltDeg))).toBeNull(); // leans south
      expect(computeAzimuth(leaning(-tiltDeg))).toBeNull(); // leans north
    });
  });
});

describe("computeElevation", () => {
  it("returns minimum Z for a ring", () => {
    const ring: ReadonlyArray<Vec3> = [
      [0, 0, 5],
      [1, 0, 10],
      [1, 1, 7],
      [0, 1, 5],
    ];
    expect(computeElevation(ring)).toBe(5);
  });

  it("returns 0 for empty ring", () => {
    expect(computeElevation([])).toBe(0);
  });

  it("returns 0 for ground-level ring", () => {
    expect(computeElevation(FLAT_SQUARE)).toBe(0);
  });
});

describe("computeRoofMetrics", () => {
  it("returns all metrics for a RoofSurface", () => {
    const surface: Surface = {
      type: "RoofSurface",
      rings: [FLAT_SQUARE],
      attributes: {},
      lod: null,
    };
    const metrics = computeRoofMetrics(surface);

    expect(metrics.areaSqM).toBeCloseTo(1.0, 5);
    expect(metrics.inclinationDeg).toBeCloseTo(0, 1);
    expect(metrics.azimuthDeg).toBeNull();
    expect(metrics.elevationM).toBe(0);
  });

  it("computes elevation for elevated surfaces", () => {
    const elevated: ReadonlyArray<Vec3> = [
      [0, 0, 10],
      [1, 0, 10],
      [1, 1, 10],
      [0, 1, 10],
    ];
    const surface: Surface = {
      type: "RoofSurface",
      rings: [elevated],
      attributes: {},
      lod: null,
    };
    const metrics = computeRoofMetrics(surface);
    expect(metrics.elevationM).toBe(10);
  });

  it("handles surface with no exterior ring", () => {
    const surface: Surface = {
      type: "RoofSurface",
      rings: [],
      attributes: {},
      lod: null,
    };
    const metrics = computeRoofMetrics(surface);

    expect(metrics.areaSqM).toBe(0);
    expect(metrics.inclinationDeg).toBe(0);
    // Nothing to face, for the same reason a flat surface has no aspect.
    expect(metrics.azimuthDeg).toBeNull();
    expect(metrics.elevationM).toBe(0);
  });
});
