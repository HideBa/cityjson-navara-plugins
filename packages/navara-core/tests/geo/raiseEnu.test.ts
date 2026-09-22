import { describe, it, expect } from "vitest";
import proj4 from "proj4";
import { ensureProjDef } from "../../src/citymodel/crsProjDefs";
import { makeEnuFrame } from "../../src/geo/enuFrame";
import { projectPositionsToEnu } from "../../src/geo/sourceToEnu";
import { raisePositionsInEnu } from "../../src/geo/raiseEnu";

// EPSG:32654 (UTM 54N), where the PLATEAU Tokyo cities land; Tokyo's geoid
// undulation is about +37 m.
const EPSG = 32654;
const ORIGIN: readonly [number, number, number] = [370000, 3950000, 40];
const N = 37;

/** Source deltas from ORIGIN: the origin itself, a roof corner, and points
 *  15 km out in each direction and at height — where a frame-only shift
 *  would be off by centimetres. */
const DELTAS = [
  [0, 0, 0],
  [12.5, -7.25, 18],
  [15000, 0, 5],
  [-15000, 0, 5],
  [0, 15000, 60],
  [0, -15000, -20],
  [10600, 10600, 300],
];

function projected(heightOffset: number): Float32Array {
  ensureProjDef(EPSG);
  const [lng, lat] = proj4(`EPSG:${EPSG}`, "WGS84", [
    ORIGIN[0],
    ORIGIN[1],
  ]) as [number, number];
  const positions = new Float32Array(DELTAS.flat());
  return projectPositionsToEnu(positions, {
    originOffset: ORIGIN,
    epsg: EPSG,
    frame: makeEnuFrame(lng, lat, ORIGIN[2] + heightOffset),
    heightOffset,
  });
}

/** One Float32 step at `x`. The raise starts from positions already stored
 *  as Float32 and stores Float32 again: two roundings, where a fresh
 *  projection has one. */
function f32Step(x: number): number {
  return x === 0 ? 1e-6 : 2 ** (Math.floor(Math.log2(Math.abs(x))) - 23);
}

function frameAt(heightOffset: number) {
  const [lng, lat] = proj4(`EPSG:${EPSG}`, "WGS84", [
    ORIGIN[0],
    ORIGIN[1],
  ]) as [number, number];
  return makeEnuFrame(lng, lat, ORIGIN[2] + heightOffset);
}

describe("raisePositionsInEnu", () => {
  it("matches a fresh projection at the new offset to storage precision", () => {
    const raised = raisePositionsInEnu(projected(0), frameAt(0), N);
    const oracle = projected(N);
    for (let i = 0; i < oracle.length; i++) {
      expect(Math.abs(raised[i]! - oracle[i]!)).toBeLessThanOrEqual(
        2 * f32Step(oracle[i]!),
      );
    }
  });

  it("is not a no-op far from the origin", () => {
    // Guards the premise: leaving local positions unchanged (moving only the
    // frame) is centimetres off 15 km out.
    const before = projected(0);
    const oracle = projected(N);
    expect(Math.abs(before[6]! - oracle[6]!)).toBeGreaterThan(0.05);
  });

  it("round-trips back down", () => {
    const start = projected(N);
    const back = raisePositionsInEnu(
      raisePositionsInEnu(projected(N), frameAt(N), -N),
      frameAt(0),
      N,
    );
    for (let i = 0; i < start.length; i++) {
      expect(Math.abs(back[i]! - start[i]!)).toBeLessThanOrEqual(
        3 * f32Step(start[i]!),
      );
    }
  });

  it("leaves positions untouched for a zero change", () => {
    const start = projected(0);
    const same = raisePositionsInEnu(projected(0), frameAt(0), 0);
    expect([...same]).toEqual([...start]);
  });
});
