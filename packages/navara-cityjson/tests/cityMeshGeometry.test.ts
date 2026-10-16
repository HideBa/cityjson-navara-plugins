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
    objectKeys: ["B1"],
    objectTypes: ["Building"],
    triangleCount: 1,
    slots: new Uint32Array([0, 0, 0]),
    slotObjects: new Uint32Array([0]),
    slotSurfaces: new Uint32Array([3]),
    slotTextures: new Int32Array([-1]),
    slotColors: new Float32Array([1, 0, 0]),
  };
}

describe("geometryFromMeshArrays", () => {
  it("wires position, normal and slot with the right item sizes", () => {
    const g = geometryFromMeshArrays(arrays());
    expect(g.getAttribute("position").itemSize).toBe(3);
    expect(g.getAttribute("normal").itemSize).toBe(3);
    expect(g.getAttribute("citySlot").itemSize).toBe(1);
    expect(g.getAttribute("position").count).toBe(3);
  });

  it("carries no per-vertex colour or index attributes", () => {
    const g = geometryFromMeshArrays(arrays());
    expect(g.getAttribute("color")).toBeUndefined();
    expect(g.getAttribute("objectIndex")).toBeUndefined();
    expect(g.getAttribute("surfaceIndex")).toBeUndefined();
  });

  it("computes bounds", () => {
    const g = geometryFromMeshArrays(arrays());
    expect(g.boundingSphere).not.toBeNull();
    expect(g.boundingSphere!.radius).toBeGreaterThan(0);
  });

  it("shares position, normal and slot buffers with the source arrays", () => {
    const a = arrays();
    const g = geometryFromMeshArrays(a);
    expect(g.getAttribute("position").array).toBe(a.positions);
    expect(g.getAttribute("normal").array).toBe(a.normals);
    expect(g.getAttribute("citySlot").array).toBe(a.slots);
  });

  it("leaves the slot attribute un-normalized so the shader reads raw slots", () => {
    const g = geometryFromMeshArrays(arrays());
    expect(g.getAttribute("citySlot").normalized).toBe(false);
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
