import { describe, it, expect } from "vitest";
import {
  buildSlotStyleColors,
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

// Two slots: surfaces 0 and 1 of object 0.
const slotObjects = new Uint32Array([0, 0]);
const slotSurfaces = new Uint32Array([0, 1]);
const baseColors = new Float32Array(6).fill(0.5);

describe("buildSlotStyleColors", () => {
  it("writes the evaluator's color on matching slots and keeps base elsewhere", () => {
    const model = makeModel([
      makeSurface("RoofSurface"),
      makeSurface("WallSurface"),
    ]);
    const evaluate: SurfaceStyleEvaluator = (surface) =>
      surface.surface.type === "RoofSurface" ? [0.25, 0.5, 0.75] : null;

    const result = buildSlotStyleColors(
      model,
      slotObjects,
      slotSurfaces,
      ["b1"],
      evaluate,
      baseColors,
    );

    expect(result).not.toBeNull();
    // 0.25/0.5/0.75 are exactly representable in Float32Array, so toEqual is
    // safe here — do not substitute values like 0.1 that round on storage.
    expect([...result!]).toEqual([0.25, 0.5, 0.75, 0.5, 0.5, 0.5]);
  });

  it("returns null when the evaluator never matches", () => {
    const model = makeModel([
      makeSurface("RoofSurface"),
      makeSurface("WallSurface"),
    ]);
    const result = buildSlotStyleColors(
      model,
      slotObjects,
      slotSurfaces,
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
    buildSlotStyleColors(
      model,
      slotObjects,
      slotSurfaces,
      ["b1"],
      () => [1, 1, 1],
      baseColors,
    );
    expect([...baseColors]).toEqual(new Array(6).fill(0.5));
  });

  it("calls the evaluator once per slot", () => {
    const model = makeModel([
      makeSurface("RoofSurface"),
      makeSurface("RoofSurface"),
    ]);
    let calls = 0;
    buildSlotStyleColors(
      model,
      slotObjects,
      slotSurfaces,
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
    buildSlotStyleColors(
      model,
      new Uint32Array([0]),
      new Uint32Array([0]),
      ["b1"],
      (surface, object) => {
        seen.push({
          objectId: object.objectId,
          surfaceIndex: surface.surfaceIndex,
        });
        return null;
      },
      new Float32Array(3),
    );
    expect(seen).toEqual([{ objectId: "b1", surfaceIndex: 0 }]);
  });

  it("skips slots whose object key or surface index is unknown", () => {
    const model = makeModel([makeSurface("RoofSurface")]);
    const result = buildSlotStyleColors(
      model,
      new Uint32Array([7]),
      new Uint32Array([0]),
      ["b1"],
      () => [1, 1, 1],
      new Float32Array(3),
    );
    expect(result).toBeNull();
  });

  it("hands the evaluator the attributes the object inherits from its parents", () => {
    // 3DBAG: the Building carries the attributes, its BuildingPart the roofs.
    const roof = makeSurface("RoofSurface");
    const building: CityObject = {
      id: "b",
      objectType: "Building",
      attributes: { b3_dak_type: "slanted", shared: "building" },
      surfaces: [],
      bbox: null,
      children: ["b-0"],
      parents: [],
      lod: "2",
    };
    const part: CityObject = {
      ...building,
      id: "b-0",
      objectType: "BuildingPart",
      attributes: { shared: "part" },
      surfaces: [roof],
      children: [],
      parents: ["b"],
    };
    const model: CityModel = {
      sourceEncoding: "cityjson",
      metadata: {},
      bbox: null,
      objects: { b: building, "b-0": part },
      vertexCount: 0,
    };
    const seen: unknown[] = [];
    buildSlotStyleColors(
      model,
      new Uint32Array([0]),
      new Uint32Array([0]),
      ["b-0"],
      (_surface, object) => {
        seen.push(object.attributes);
        return null;
      },
      new Float32Array(3),
    );
    expect(seen).toEqual([{ b3_dak_type: "slanted", shared: "part" }]);
  });
});
