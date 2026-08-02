import { describe, it, expect } from "vitest";
import {
  buildStyleColorsFromArrays,
  type SurfaceStyleEvaluator,
} from "../../src/styling/buildStyleColors";
import type { CityModel, CityObject, Surface } from "../../src/citymodel/types";

function makeSurface(type: Surface["type"]): Surface {
  return {
    type,
    rings: [
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
    ],
    attributes: {},
    lod: "2",
  };
}

function makeModel(surfaces: Surface[]): CityModel {
  const object: CityObject = {
    id: "b1",
    objectType: "Building",
    attributes: {},
    surfaces,
    bbox: null,
    children: [],
    parents: [],
    lod: "2",
  };
  return {
    sourceEncoding: "cityjson",
    metadata: {},
    bbox: null,
    objects: { b1: object },
    vertexCount: 0,
  };
}

// Three vertices belonging to surface 0, three to surface 1, all of object 0.
const objectIndices = new Uint32Array([0, 0, 0, 0, 0, 0]);
const surfaceIndices = new Uint32Array([0, 0, 0, 1, 1, 1]);
const baseColors = new Float32Array(18).fill(0.5);

describe("buildStyleColorsFromArrays", () => {
  it("writes the evaluator's color on matching vertices and keeps base elsewhere", () => {
    const model = makeModel([
      makeSurface("RoofSurface"),
      makeSurface("WallSurface"),
    ]);
    const evaluate: SurfaceStyleEvaluator = (surface) =>
      surface.surface.type === "RoofSurface" ? [0.25, 0.5, 0.75] : null;

    const result = buildStyleColorsFromArrays(
      model,
      objectIndices,
      surfaceIndices,
      ["b1"],
      evaluate,
      baseColors,
    );

    expect(result).not.toBeNull();
    // 0.25/0.5/0.75 are exactly representable in Float32Array, so toEqual is
    // safe here — do not substitute values like 0.1 that round on storage.
    expect([...result!.slice(0, 9)]).toEqual([
      0.25, 0.5, 0.75, 0.25, 0.5, 0.75, 0.25, 0.5, 0.75,
    ]);
    expect([...result!.slice(9)]).toEqual([
      0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
    ]);
  });

  it("returns null when the evaluator never matches", () => {
    const model = makeModel([
      makeSurface("RoofSurface"),
      makeSurface("WallSurface"),
    ]);
    const result = buildStyleColorsFromArrays(
      model,
      objectIndices,
      surfaceIndices,
      ["b1"],
      () => null,
      baseColors,
    );
    expect(result).toBeNull();
  });

  it("does not mutate the caller's baseColors", () => {
    const model = makeModel([
      makeSurface("RoofSurface"),
      makeSurface("WallSurface"),
    ]);
    buildStyleColorsFromArrays(
      model,
      objectIndices,
      surfaceIndices,
      ["b1"],
      () => [1, 1, 1],
      baseColors,
    );
    expect([...baseColors]).toEqual(new Array(18).fill(0.5));
  });

  it("calls the evaluator once per (object, surface) pair, not per vertex", () => {
    const model = makeModel([
      makeSurface("RoofSurface"),
      makeSurface("RoofSurface"),
    ]);
    let calls = 0;
    buildStyleColorsFromArrays(
      model,
      objectIndices,
      surfaceIndices,
      ["b1"],
      () => {
        calls++;
        return [0, 0, 0];
      },
      baseColors,
    );
    expect(calls).toBe(2);
  });

  it("passes the resolved object id and surface index to the evaluator", () => {
    const model = makeModel([makeSurface("RoofSurface")]);
    const seen: Array<{ objectId: string; surfaceIndex: number }> = [];
    buildStyleColorsFromArrays(
      model,
      new Uint32Array([0, 0, 0]),
      new Uint32Array([0, 0, 0]),
      ["b1"],
      (surface, object) => {
        seen.push({
          objectId: object.objectId,
          surfaceIndex: surface.surfaceIndex,
        });
        return null;
      },
      new Float32Array(9),
    );
    expect(seen).toEqual([{ objectId: "b1", surfaceIndex: 0 }]);
  });

  it("skips vertices whose object key or surface index is unknown", () => {
    const model = makeModel([makeSurface("RoofSurface")]);
    const result = buildStyleColorsFromArrays(
      model,
      new Uint32Array([7, 7, 7]),
      new Uint32Array([0, 0, 0]),
      ["b1"],
      () => [1, 1, 1],
      new Float32Array(9),
    );
    expect(result).toBeNull();
  });
});
