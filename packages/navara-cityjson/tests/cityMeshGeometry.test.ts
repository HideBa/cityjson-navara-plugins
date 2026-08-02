import type { CityMeshArrays } from "@cityjson/navara-core";
import { describe, expect, it } from "vitest";
import {
  disposeGeometry,
  geometryFromMeshArrays,
} from "../src/cityMeshGeometry";

function arrays(): CityMeshArrays {
  return {
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
    objectIndices: new Uint32Array([0, 0, 0]),
    surfaceIndices: new Uint32Array([3, 3, 3]),
    objectKeys: ["B1"],
    triangleCount: 1,
  };
}

describe("geometryFromMeshArrays", () => {
  it("wires all five attributes with the right item sizes", () => {
    const g = geometryFromMeshArrays(arrays());
    expect(g.getAttribute("position").itemSize).toBe(3);
    expect(g.getAttribute("normal").itemSize).toBe(3);
    expect(g.getAttribute("color").itemSize).toBe(3);
    expect(g.getAttribute("objectIndex").itemSize).toBe(1);
    expect(g.getAttribute("surfaceIndex").itemSize).toBe(1);
    expect(g.getAttribute("position").count).toBe(3);
  });

  it("keeps index attributes readable per vertex and computes bounds", () => {
    const g = geometryFromMeshArrays(arrays());
    expect(g.getAttribute("objectIndex").getX(2)).toBe(0);
    expect(g.getAttribute("surfaceIndex").getX(2)).toBe(3);
    expect(g.boundingSphere).not.toBeNull();
    expect(g.boundingSphere!.radius).toBeGreaterThan(0);
  });

  it("does not copy the color array (the GPU buffer is mutated in place)", () => {
    const a = arrays();
    const g = geometryFromMeshArrays(a);
    expect(g.getAttribute("color").array).toBe(a.colors);
  });

  it("shares position/normal/index buffers with the source arrays too", () => {
    const a = arrays();
    const g = geometryFromMeshArrays(a);
    expect(g.getAttribute("position").array).toBe(a.positions);
    expect(g.getAttribute("normal").array).toBe(a.normals);
    expect(g.getAttribute("objectIndex").array).toBe(a.objectIndices);
    expect(g.getAttribute("surfaceIndex").array).toBe(a.surfaceIndices);
  });

  it("leaves the index attributes un-normalized so shaders read raw ids", () => {
    const g = geometryFromMeshArrays(arrays());
    expect(g.getAttribute("objectIndex").normalized).toBe(false);
    expect(g.getAttribute("surfaceIndex").normalized).toBe(false);
  });
});

describe("disposeGeometry", () => {
  it("releases the geometry's GPU resources exactly once", () => {
    const g = geometryFromMeshArrays(arrays());
    let disposals = 0;
    g.addEventListener("dispose", () => {
      disposals += 1;
    });
    disposeGeometry(g);
    expect(disposals).toBe(1);
  });
});
