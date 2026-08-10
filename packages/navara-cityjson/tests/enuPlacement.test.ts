import { describe, it, expect } from "vitest";
import proj4 from "proj4";
import {
  makeEnuFrame,
  projectPositionsToEnu,
  type Vec3,
} from "@cityjson/navara-core";
import {
  buildPlacement,
  CrsUnresolvedError,
  geodeticBoundsFromBBox,
  makePlacementFrame,
  NonMetricCrsError,
  originLleFromOffset,
  placementMatrixFromFrame,
  placementMatrixFromLle,
  resolveEpsg,
  resolveMetricEpsg,
} from "../src/enuPlacement";

// Fixture CRS: EPSG:7415 (RD New + NAP), the two-buildings fixture's CRS.
const RD = "https://www.opengis.net/def/crs/EPSG/0/7415";

// RD New puts its origin (155000, 463000) at Amersfoort; (85000, 446000) is
// 70 km west and 17 km south of it. Ground truth from PROJ (cs2cs EPSG:28992
// → EPSG:4326) is 4.367888E / 51.997962N. The values first pinned here
// (4.36895 / 51.99816) came out of a towgs84 def with half-negated rotation
// signs — ~76 m ENE of truth, far below what the km-scale hand computation in
// this comment's earlier version could catch.
const ORIGIN_LNG = 4.367888;
const ORIGIN_LAT = 51.997962;

describe("resolveEpsg", () => {
  it("parses an OGC CRS URI", () => {
    expect(resolveEpsg(RD)).toBe(7415);
  });

  it("accepts a bare numeric code", () => {
    expect(resolveEpsg(28992)).toBe(28992);
  });

  it("throws for a missing CRS (the spec 4.3 gate)", () => {
    expect(() => resolveEpsg(undefined)).toThrow(CrsUnresolvedError);
  });

  it("throws for a CRS proj4 cannot resolve", () => {
    expect(() =>
      resolveEpsg("https://www.opengis.net/def/crs/EPSG/0/99999"),
    ).toThrow(CrsUnresolvedError);
  });

  it("names the offending CRS in the message so the layer error is actionable", () => {
    expect(() => resolveEpsg("not-a-crs")).toThrow(/not-a-crs/);
    expect(() => resolveEpsg(undefined)).toThrow(/missing/);
  });
});

describe("originLleFromOffset", () => {
  it("reprojects an RD New origin into the Delft area", () => {
    const lle = originLleFromOffset([85000, 446000, 12], 7415);
    expect(lle.lng).toBeCloseTo(ORIGIN_LNG, 4);
    expect(lle.lat).toBeCloseTo(ORIGIN_LAT, 4);
    expect(lle.height).toBe(12);
  });

  it("throws rather than returning NaN for an unregisterable CRS", () => {
    expect(() => originLleFromOffset([85000, 446000, 0], 99999)).toThrow(
      CrsUnresolvedError,
    );
  });
});

describe("geodeticBoundsFromBBox", () => {
  it("returns a west<east / south<north box covering all four corners", () => {
    const b = geodeticBoundsFromBBox(
      [84900, 445900, 0, 85100, 446100, 20],
      7415,
    );
    expect(b.west).toBeLessThan(b.east);
    expect(b.south).toBeLessThan(b.north);
    expect(b.minHeight).toBe(0);
    expect(b.maxHeight).toBe(20);
    const centreLng = (b.west + b.east) / 2;
    expect(centreLng).toBeCloseTo(ORIGIN_LNG, 3);
    expect((b.south + b.north) / 2).toBeCloseTo(ORIGIN_LAT, 3);
  });

  it("contains every corner even though RD grid north is not true north", () => {
    const bbox = [84900, 445900, 0, 85100, 446100, 20] as const;
    const b = geodeticBoundsFromBBox([...bbox], 7415);
    for (const [x, y] of [
      [bbox[0], bbox[1]],
      [bbox[3], bbox[1]],
      [bbox[3], bbox[4]],
      [bbox[0], bbox[4]],
    ]) {
      const { lng, lat } = originLleFromOffset([x!, y!, 0], 7415);
      expect(lng).toBeGreaterThanOrEqual(b.west);
      expect(lng).toBeLessThanOrEqual(b.east);
      expect(lat).toBeGreaterThanOrEqual(b.south);
      expect(lat).toBeLessThanOrEqual(b.north);
    }
  });
});

describe("placementMatrixFromLle", () => {
  it("carries core's ENU frame, so placement matches the streaming plugin's cell frames", () => {
    const lle = { lng: 4.3571, lat: 52.0116, height: 0 };
    const m = placementMatrixFromLle(lle);
    const frame = makeEnuFrame(lle.lng, lle.lat, lle.height);
    // Matrix4.elements is column-major, exactly like EnuFrame.matrix.
    expect(m.elements[12]).toBeCloseTo(frame.originEcef[0], 6);
    expect(m.elements[13]).toBeCloseTo(frame.originEcef[1], 6);
    expect(m.elements[14]).toBeCloseTo(frame.originEcef[2], 6);
    expect(m.elements[15]).toBe(1);
  });

  it("is the same matrix as placementMatrixFromFrame on the same frame", () => {
    const lle = { lng: 4.3571, lat: 52.0116, height: 7 };
    const a = placementMatrixFromLle(lle);
    const b = placementMatrixFromFrame(
      makeEnuFrame(lle.lng, lle.lat, lle.height),
    );
    expect(Array.from(a.elements)).toEqual(Array.from(b.elements));
  });

  it("has an orthonormal, right-handed east/north/up rotation block", () => {
    const e = placementMatrixFromLle({
      lng: 4.3571,
      lat: 52.0116,
      height: 0,
    }).elements;
    const east = [e[0]!, e[1]!, e[2]!];
    const north = [e[4]!, e[5]!, e[6]!];
    const up = [e[8]!, e[9]!, e[10]!];
    const dot = (a: number[], b: number[]) =>
      a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    for (const v of [east, north, up]) expect(dot(v, v)).toBeCloseTo(1, 12);
    expect(dot(east, north)).toBeCloseTo(0, 12);
    expect(dot(north, up)).toBeCloseTo(0, 12);
    expect(dot(east, up)).toBeCloseTo(0, 12);
    // east x north = up (right-handed), so the frame is not mirrored.
    const cross = [
      east[1]! * north[2]! - east[2]! * north[1]!,
      east[2]! * north[0]! - east[0]! * north[2]!,
      east[0]! * north[1]! - east[1]! * north[0]!,
    ];
    expect(dot(cross, up)).toBeCloseTo(1, 12);
  });
});

/**
 * The frame+offset invariant (carried forward from the Task A13b review).
 *
 * A layer frame is built at `origin height + heightOffset` and the SAME
 * `heightOffset` is handed to `projectPositionsToEnu`. Consumers that pass one
 * without the other get a mesh floating `heightOffset` metres above or below
 * the terrain — the exact bug this pairing exists to prevent. These tests pin
 * the contract in the placement code path, not just in core's unit tests.
 */
describe("frame + heightOffset pairing", () => {
  const EPSG = 7415;
  // Origin z = 0, so "source z = 0" and "the frame's own height" coincide and
  // the expected ENU z is unambiguously 0.
  const ORIGIN: Vec3 = [85000, 446000, 0];
  const N = 43.2; // a realistic NAP -> WGS84 ellipsoid undulation for Delft

  const projected = (frameHeightOffset: number, vertexHeightOffset: number) => {
    const lle = originLleFromOffset(ORIGIN, EPSG);
    const frame = makePlacementFrame(lle, frameHeightOffset);
    const positions = new Float32Array([0, 0, 0, 25, 40, 10]);
    projectPositionsToEnu(positions, {
      originOffset: ORIGIN,
      epsg: EPSG,
      frame,
      heightOffset: vertexHeightOffset,
    });
    return positions;
  };

  it("puts a z=0 source vertex at ENU z~0 when frame and vertices share the offset", () => {
    const p = projected(N, N);
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(0, 6);
    expect(p[2]).toBeCloseTo(0, 6);
    // ...and a vertex 10 m up in source z is still 10 m up in ENU.
    expect(p[5]).toBeCloseTo(10, 2);
  });

  it("keeps local ENU coordinates small — the whole point of the pairing", () => {
    const p = projected(N, N);
    for (const v of p) expect(Math.abs(v)).toBeLessThan(100);
  });

  it("floats the mesh by heightOffset when only the vertices are offset (the bug)", () => {
    const p = projected(0, N);
    expect(p[2]).toBeCloseTo(N, 3);
  });

  it("sinks the mesh by heightOffset when only the frame is offset (the bug)", () => {
    const p = projected(N, 0);
    expect(p[2]).toBeCloseTo(-N, 3);
  });

  it("keeps the placement matrix on the offset frame, not the raw origin", () => {
    const lle = originLleFromOffset(ORIGIN, EPSG);
    const frame = makePlacementFrame(lle, N);
    expect(frame.heightM).toBeCloseTo(lle.height + N, 12);
    const m = placementMatrixFromFrame(frame);
    const raw = placementMatrixFromLle(lle);
    // The offset frame's ECEF origin is N metres further from Earth's centre.
    const len = (e: ArrayLike<number>) => Math.hypot(e[12]!, e[13]!, e[14]!);
    expect(len(m.elements) - len(raw.elements)).toBeCloseTo(N, 3);
  });
});

/**
 * `buildPlacement` is the bundle form of the pairing above: one call produces
 * the frame, the ECEF matrix derived from THAT frame, and the offset that must
 * be handed to `projectPositionsToEnu`. Task B6 (static layers) and Task C5/C8
 * (streaming cells) both go through it, so neither can wire one height into the
 * frame and another into the vertices.
 */
describe("buildPlacement", () => {
  const lle = { lng: 4.3571, lat: 52.0116, height: 5 };

  it("returns a frame, its own matrix, and the offset that built them", () => {
    const p = buildPlacement(lle, 43);
    expect(p.heightOffset).toBe(43);
    expect(p.frame.heightM).toBeCloseTo(48, 12);
    expect(p.matrixWorld.elements[12]).toBeCloseTo(p.frame.originEcef[0], 9);
    expect(p.matrixWorld.elements[13]).toBeCloseTo(p.frame.originEcef[1], 9);
    expect(p.matrixWorld.elements[14]).toBeCloseTo(p.frame.originEcef[2], 9);
  });

  it("is exactly makePlacementFrame + placementMatrixFromFrame", () => {
    const p = buildPlacement(lle, 43);
    const frame = makePlacementFrame(lle, 43);
    expect(Array.from(p.frame.matrix)).toEqual(Array.from(frame.matrix));
    expect(Array.from(p.matrixWorld.elements)).toEqual(
      Array.from(placementMatrixFromFrame(frame).elements),
    );
  });

  it("projects a vertex at the origin's own height to ENU z ~ 0", () => {
    const origin: Vec3 = [85000, 446000, 0];
    const p = buildPlacement(originLleFromOffset(origin, 7415), 43);
    const positions = new Float32Array([0, 0, 0]);
    projectPositionsToEnu(positions, {
      originOffset: origin,
      epsg: 7415,
      frame: p.frame,
      heightOffset: p.heightOffset,
    });
    expect(positions[2]).toBeCloseTo(0, 6);
  });
});

/**
 * The metric-units gate (carried forward from the Task B4 review). The app
 * refuses a non-metre CRS at FlatCityBuf admission (`checkAdmission` in
 * `src/domain/citymodel/flatcitybuf/fcbSource.ts`); `resolveEpsg` alone only
 * asks whether proj4 has SOME definition, which a US-survey-feet CRS also
 * satisfies. Heights and every downstream distance are metres, so the static
 * load path applies the same conservative refusal.
 */
describe("resolveMetricEpsg", () => {
  // Registered here rather than relying on a real code, so the assertion is
  // about `units`, not about which codes this proj4 bundle happens to know.
  const FEET = 990001;
  const METRE = 990002;
  proj4.defs(
    `EPSG:${FEET}`,
    "+proj=lcc +lat_0=40.1666666666667 +lon_0=-74 +lat_1=41.0333333333333 +lat_2=40.6666666666667 +x_0=300000 +y_0=0 +ellps=GRS80 +units=us-ft +no_defs +type=crs",
  );
  proj4.defs(
    `EPSG:${METRE}`,
    "+proj=lcc +lat_0=40.1666666666667 +lon_0=-74 +lat_1=41.0333333333333 +lat_2=40.6666666666667 +x_0=300000 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs",
  );

  it("admits the fixture CRS (RD New is metre-based)", () => {
    expect(resolveMetricEpsg("https://www.opengis.net/def/crs/EPSG/0/7415")).toBe(
      7415,
    );
    expect(resolveMetricEpsg(28992)).toBe(28992);
  });

  it("refuses a geographic CRS whose units are degrees", () => {
    expect(() => resolveMetricEpsg(4326)).toThrow(NonMetricCrsError);
  });

  it("refuses a projected CRS in US survey feet, and names its units", () => {
    expect(() => resolveMetricEpsg(FEET)).toThrow(NonMetricCrsError);
    expect(() => resolveMetricEpsg(FEET)).toThrow(/us-ft/);
  });

  it("admits the same definition once its units really are metres — the check is on units, not on the code", () => {
    expect(resolveMetricEpsg(METRE)).toBe(METRE);
  });

  it("still reports an unresolvable CRS as CrsUnresolvedError, not as non-metric", () => {
    expect(() => resolveMetricEpsg(undefined)).toThrow(CrsUnresolvedError);
    expect(() => resolveMetricEpsg(99999)).toThrow(CrsUnresolvedError);
  });
});
