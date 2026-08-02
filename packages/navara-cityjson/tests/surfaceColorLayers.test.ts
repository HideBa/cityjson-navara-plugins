import { describe, expect, it } from "vitest";
import { srgbHexToLinear, type CityObject } from "@cityjson/navara-core";
import {
  computeStyleColors,
  HIGHLIGHT_COLOR_HEX,
  HOVER_COLOR_HEX,
  paintLayers,
} from "../src/surfaceColorLayers";

/** 4 vertices: v0,v1 -> object 0 surface 0; v2,v3 -> object 1 surface 1. */
const objectIndices = new Uint32Array([0, 0, 1, 1]);
const surfaceIndices = new Uint32Array([0, 0, 1, 1]);
const objectKeys = ["B1", "B2"];
// 0.25 / 0.5 are exactly representable in a Float32Array, so the toEqual
// assertions below are safe (0.1 and 0.2 are not — they round on storage).
const base = new Float32Array([
  0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
]);

function obj(id: string, type: "RoofSurface" | "WallSurface"): CityObject {
  return {
    id,
    objectType: "Building",
    attributes: {},
    surfaces: [
      { type, rings: [], attributes: {}, lod: "2" },
      { type, rings: [], attributes: {}, lod: "2" },
    ],
    bbox: null,
    children: [],
    parents: [],
    lod: "2",
  };
}

const lookup = (id: string) =>
  id === "B1" ? obj("B1", "RoofSurface") : obj("B2", "WallSurface");

describe("computeStyleColors", () => {
  it("writes the evaluator color only where it returns non-null", () => {
    const out = computeStyleColors(
      // The evaluator returns a linear-sRGB triple (see Shared Interface
      // Contract) — the buffer takes it verbatim, with no hex round trip.
      (surface) =>
        surface.surface.type === "RoofSurface" ? [1, 0, 0.5] : null,
      objectIndices,
      surfaceIndices,
      objectKeys,
      lookup,
      base,
    );
    expect(out).not.toBeNull();
    expect(Array.from(out!.slice(0, 3))).toEqual([1, 0, 0.5]);
    expect(Array.from(out!.slice(6, 9))).toEqual([0.5, 0.5, 0.5]);
  });

  it("returns null when the evaluator never matches", () => {
    const out = computeStyleColors(
      () => null,
      objectIndices,
      surfaceIndices,
      objectKeys,
      lookup,
      base,
    );
    expect(out).toBeNull();
  });

  it("calls the evaluator once per unique (object, surface) pair", () => {
    const seen: string[] = [];
    computeStyleColors(
      (surface, object) => {
        seen.push(`${object.objectId}:${surface.surfaceIndex}`);
        return [1, 1, 1];
      },
      objectIndices,
      surfaceIndices,
      objectKeys,
      lookup,
      base,
    );
    // 4 vertices, but only 2 distinct (object, surface) pairs.
    expect(seen).toEqual(["B1:0", "B2:1"]);
  });
});

describe("paintLayers", () => {
  it("restores the source layer then paints selection over hover", () => {
    const target = new Float32Array(base.length);
    paintLayers(
      target,
      base,
      objectIndices,
      surfaceIndices,
      objectKeys,
      [{ kind: "object", layerId: "L", objectId: "B1" }],
      { kind: "object", layerId: "L", objectId: "B1" },
    );
    const [hr, hg, hb] = srgbHexToLinear(HIGHLIGHT_COLOR_HEX);
    expect(target[0]).toBeCloseTo(hr, 6);
    expect(target[1]).toBeCloseTo(hg, 6);
    expect(target[2]).toBeCloseTo(hb, 6);
    expect(Array.from(target.slice(6, 9))).toEqual([0.5, 0.5, 0.5]);
  });

  it("honours surface-level selection granularity", () => {
    const target = new Float32Array(base.length);
    paintLayers(
      target,
      base,
      objectIndices,
      surfaceIndices,
      objectKeys,
      [{ kind: "surface", layerId: "L", objectId: "B2", surfaceIndex: 9 }],
      null,
    );
    expect(Array.from(target.slice(6, 9))).toEqual([0.5, 0.5, 0.5]);
  });

  it("paints hover when nothing is selected", () => {
    const target = new Float32Array(base.length);
    paintLayers(target, base, objectIndices, surfaceIndices, objectKeys, [], {
      kind: "surface",
      layerId: "L",
      objectId: "B2",
      surfaceIndex: 1,
    });
    const [r, g, b] = srgbHexToLinear(HOVER_COLOR_HEX);
    expect(target[6]).toBeCloseTo(r, 6);
    expect(target[7]).toBeCloseTo(g, 6);
    expect(target[8]).toBeCloseTo(b, 6);
    expect(Array.from(target.slice(0, 3))).toEqual([0.25, 0.25, 0.25]);
  });
});
