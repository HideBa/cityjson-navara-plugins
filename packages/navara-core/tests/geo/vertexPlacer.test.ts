import { describe, it, expect } from "vitest";
import proj4 from "proj4";
import { ensureProjDef } from "../../src/citymodel/crsProjDefs";
import { makeEnuFrame } from "../../src/geo/enuFrame";
import { sourceToEnuPoint } from "../../src/geo/sourceToEnu";
import {
  createProjectedVertices,
  createVertexPlacer,
} from "../../src/geo/vertexPlacer";
import type { Vec3 } from "../../src/citymodel/types";

// EPSG:7415 = RD New (x/y) + NAP (z), as in sourceToEnu.test.ts.
const EPSG = 7415;
const ORIGIN: readonly [number, number, number] = [155000, 463000, 0];

function frameAtOrigin(heightOffset: number) {
  ensureProjDef(EPSG);
  const [lng, lat] = proj4(`EPSG:${EPSG}`, "WGS84", [ORIGIN[0], ORIGIN[1]]) as [
    number,
    number,
  ];
  return makeEnuFrame(lng, lat, heightOffset);
}

describe("createVertexPlacer", () => {
  it("places a vertex exactly as sourceToEnuPoint does, stored as Float32", () => {
    const opts = { epsg: EPSG, frame: frameAtOrigin(3), heightOffset: 43.5 };
    const placer = createVertexPlacer(opts);
    const vertices: Vec3[] = [
      [160000, 468000, 12],
      [154321.125, 462001.5, -3.25],
      [ORIGIN[0], ORIGIN[1], 0],
    ];
    const out = new Float32Array(vertices.length * 3);
    vertices.forEach((v, i) => placer.place(v, out, i * 3));

    const want = new Float32Array(
      vertices.flatMap((v) => sourceToEnuPoint(v[0], v[1], v[2], opts)),
    );
    expect(out).toEqual(want);
  });

  it("projects each vertex object once, however often it is placed", () => {
    const placer = createVertexPlacer({
      epsg: EPSG,
      frame: frameAtOrigin(0),
      heightOffset: 0,
    });
    const shared: Vec3 = [156000, 464000, 5];
    const out = new Float32Array(9);
    placer.place(shared, out, 0);
    placer.place(shared, out, 3);
    // A different object with the same coordinates is a different vertex to
    // the cache, and lands in the same place.
    placer.place([156000, 464000, 5], out, 6);

    expect(placer.projectedCount()).toBe(2);
    expect([...out.subarray(3, 6)]).toEqual([...out.subarray(0, 3)]);
    expect([...out.subarray(6, 9)]).toEqual([...out.subarray(0, 3)]);
  });

  it("keeps earlier vertices when its storage grows", () => {
    const placer = createVertexPlacer({
      epsg: EPSG,
      frame: frameAtOrigin(0),
      heightOffset: 0,
    });
    const vertices: Vec3[] = [];
    for (let i = 0; i < 5000; i++) {
      vertices.push([150000 + i * 2.5, 460000 + (i % 97) * 3, i % 13]);
    }
    const first = new Float32Array(vertices.length * 3);
    vertices.forEach((v, i) => placer.place(v, first, i * 3));
    const again = new Float32Array(vertices.length * 3);
    vertices.forEach((v, i) => placer.place(v, again, i * 3));
    expect(again).toEqual(first);
    expect(placer.projectedCount()).toBe(vertices.length);
  });

  it("forgets its oldest projections when full, and still places exactly", () => {
    // A bounded cache: a source that shares no vertex objects must not grow
    // a map entry per corner for the layer's life.
    const projected = createProjectedVertices(EPSG, 4);
    const opts = { epsg: EPSG, frame: frameAtOrigin(0), heightOffset: 0 };
    const placer = createVertexPlacer(opts, projected);
    const vertices: Vec3[] = [];
    for (let i = 0; i < 6; i++) vertices.push([155000 + i, 463000 - i, i]);
    const out = new Float32Array(vertices.length * 3);
    vertices.forEach((v, i) => placer.place(v, out, i * 3));
    expect(projected.size()).toBeLessThanOrEqual(4);
    // The first vertex was forgotten, so placing it again projects it again.
    const again = new Float32Array(3);
    placer.place(vertices[0]!, again, 0);
    expect(placer.projectedCount()).toBe(7);
    const want = new Float32Array(
      vertices.flatMap((v) => sourceToEnuPoint(v[0], v[1], v[2], opts)),
    );
    expect(out).toEqual(want);
    expect([...again]).toEqual([...want.subarray(0, 3)]);
  });

  it("reuses another placement's projections when they share a cache", () => {
    // A new height offset is a new frame and a new placer, but the same
    // source vertices: proj4 is not run again, and each placer still lands
    // every vertex exactly where sourceToEnuPoint does at its own offset.
    const projected = createProjectedVertices(EPSG);
    const vertices: Vec3[] = [
      [160000, 468000, 12],
      [154321.125, 462001.5, -3.25],
    ];
    for (const heightOffset of [0, 43.5]) {
      const opts = {
        epsg: EPSG,
        frame: frameAtOrigin(heightOffset),
        heightOffset,
      };
      const placer = createVertexPlacer(opts, projected);
      const out = new Float32Array(6);
      vertices.forEach((v, i) => placer.place(v, out, i * 3));
      const want = new Float32Array(
        vertices.flatMap((v) => sourceToEnuPoint(v[0], v[1], v[2], opts)),
      );
      expect(out).toEqual(want);
      expect(placer.projectedCount()).toBe(2);
    }
  });
});
