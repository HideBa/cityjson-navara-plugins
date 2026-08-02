import { describe, it, expect } from "vitest";
import proj4 from "proj4";
import { ensureProjDef } from "../../src/citymodel/crsProjDefs";
import { geodeticToEcef, makeEnuFrame } from "../../src/geo/enuFrame";
import {
  projectPositionsToEnu,
  sourceToEnuPoint,
} from "../../src/geo/sourceToEnu";

// EPSG:7415 = RD New (x/y) + NAP (z), the two-buildings and Delft fixtures' CRS.
const EPSG = 7415;
// Amersfoort-ish origin, then a point 5 km north-east of it: far enough that
// projection scale + convergence are metres, not rounding noise.
const ORIGIN: readonly [number, number, number] = [155000, 463000, 0];
const FAR: readonly [number, number, number] = [160000, 468000, 12];

describe("sourceToEnuPoint", () => {
  it("matches a direct proj4 -> ECEF -> inverse-ENU computation for a far-from-origin point", () => {
    ensureProjDef(EPSG);
    const [oLng, oLat] = proj4(`EPSG:${EPSG}`, "WGS84", [
      ORIGIN[0],
      ORIGIN[1],
    ]) as [number, number];
    const frame = makeEnuFrame(oLng, oLat, 0);

    const got = sourceToEnuPoint(FAR[0], FAR[1], FAR[2], {
      epsg: EPSG,
      frame,
      heightOffset: 0,
    });

    // Independent oracle: proj4 to geodetic, geodetic to ECEF, then the
    // frame's transpose-rotation inverse, written out longhand here.
    const [lng, lat] = proj4(`EPSG:${EPSG}`, "WGS84", [FAR[0], FAR[1]]) as [
      number,
      number,
    ];
    const p = geodeticToEcef(lng, lat, FAR[2]);
    const m = frame.matrix;
    const dx = p[0] - m[12]!;
    const dy = p[1] - m[13]!;
    const dz = p[2] - m[14]!;
    const want: [number, number, number] = [
      m[0]! * dx + m[1]! * dy + m[2]! * dz,
      m[4]! * dx + m[5]! * dy + m[6]! * dz,
      m[8]! * dx + m[9]! * dy + m[10]! * dz,
    ];

    const scale = Math.hypot(want[0], want[1], want[2]);
    expect(Math.abs(got[0] - want[0]) / scale).toBeLessThan(1e-6);
    expect(Math.abs(got[1] - want[1]) / scale).toBeLessThan(1e-6);
    expect(Math.abs(got[2] - want[2]) / scale).toBeLessThan(1e-6);
  });

  it("differs measurably from the naive 'source deltas are ENU metres' shortcut", () => {
    ensureProjDef(EPSG);
    const [oLng, oLat] = proj4(`EPSG:${EPSG}`, "WGS84", [
      ORIGIN[0],
      ORIGIN[1],
    ]) as [number, number];
    const frame = makeEnuFrame(oLng, oLat, 0);
    const got = sourceToEnuPoint(FAR[0], FAR[1], FAR[2], {
      epsg: EPSG,
      frame,
      heightOffset: 0,
    });
    const naive = [FAR[0] - ORIGIN[0], FAR[1] - ORIGIN[1], FAR[2]] as const;
    // This is the whole point of the module: at 7 km out the shortcut is off
    // by more than a decimetre, which is visible against photoreal terrain.
    expect(Math.hypot(got[0] - naive[0], got[1] - naive[1])).toBeGreaterThan(
      0.1,
    );
  });

  it("adds heightOffset to the geodetic height, raising the point by that many metres", () => {
    ensureProjDef(EPSG);
    const [oLng, oLat] = proj4(`EPSG:${EPSG}`, "WGS84", [
      ORIGIN[0],
      ORIGIN[1],
    ]) as [number, number];
    const frame = makeEnuFrame(oLng, oLat, 0);
    const at0 = sourceToEnuPoint(ORIGIN[0], ORIGIN[1], 0, {
      epsg: EPSG,
      frame,
      heightOffset: 0,
    });
    const at43 = sourceToEnuPoint(ORIGIN[0], ORIGIN[1], 0, {
      epsg: EPSG,
      frame,
      heightOffset: 43,
    });
    expect(at43[2] - at0[2]).toBeCloseTo(43, 6);
    expect(at43[0]).toBeCloseTo(at0[0], 6);
    expect(at43[1]).toBeCloseTo(at0[1], 6);
  });
});

describe("projectPositionsToEnu", () => {
  it("rewrites a positions buffer of origin-relative source deltas in place", () => {
    ensureProjDef(EPSG);
    const [oLng, oLat] = proj4(`EPSG:${EPSG}`, "WGS84", [
      ORIGIN[0],
      ORIGIN[1],
    ]) as [number, number];
    const frame = makeEnuFrame(oLng, oLat, 0);
    const positions = new Float32Array([
      0,
      0,
      0,
      FAR[0] - ORIGIN[0],
      FAR[1] - ORIGIN[1],
      FAR[2],
    ]);
    projectPositionsToEnu(positions, {
      originOffset: ORIGIN,
      epsg: EPSG,
      frame,
      heightOffset: 0,
    });
    // The origin vertex stays at the frame origin.
    expect(positions[0]).toBeCloseTo(0, 3);
    expect(positions[1]).toBeCloseTo(0, 3);
    expect(positions[2]).toBeCloseTo(0, 3);
    const want = sourceToEnuPoint(FAR[0], FAR[1], FAR[2], {
      epsg: EPSG,
      frame,
      heightOffset: 0,
    });
    expect(positions[3]).toBeCloseTo(want[0], 2);
    expect(positions[4]).toBeCloseTo(want[1], 2);
    expect(positions[5]).toBeCloseTo(want[2], 2);
  });

  // Guards the perf fix: the bulk path hoists one proj4 converter out of the
  // loop instead of re-constructing it per vertex (950 ms -> 255 ms per 100k
  // vertices). proj4's three-argument call is exactly `transformer(from, to,
  // coord)` — the same function `converter.forward` calls — so the hoist must
  // be bit-for-bit invisible, not merely close.
  it("is bit-for-bit identical to calling sourceToEnuPoint per vertex", () => {
    ensureProjDef(EPSG);
    const [oLng, oLat] = proj4(`EPSG:${EPSG}`, "WGS84", [
      ORIGIN[0],
      ORIGIN[1],
    ]) as [number, number];
    const frame = makeEnuFrame(oLng, oLat, 3);
    const opts = { epsg: EPSG, frame, heightOffset: 43.5 } as const;

    const deltas: Array<[number, number, number]> = [];
    for (let i = 0; i < 64; i++) {
      deltas.push([(i % 17) * 137.5 - 1000, (i % 11) * 211.25 - 900, i * 0.75]);
    }
    const positions = new Float32Array(deltas.flat());

    // Per-vertex oracle, fed the SAME Float32-rounded deltas the bulk path
    // reads back out of the buffer.
    const want = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      const enu = sourceToEnuPoint(
        positions[i]! + ORIGIN[0],
        positions[i + 1]! + ORIGIN[1],
        positions[i + 2]! + ORIGIN[2],
        opts,
      );
      want[i] = enu[0];
      want[i + 1] = enu[1];
      want[i + 2] = enu[2];
    }

    projectPositionsToEnu(positions, { originOffset: ORIGIN, ...opts });
    expect(positions).toEqual(want);
  });
});
