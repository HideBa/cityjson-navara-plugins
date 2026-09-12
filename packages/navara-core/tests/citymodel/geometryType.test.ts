/**
 * Spec §6 (processing toolbox): "every surface is tagged with its LoD and its
 * geometry type", which is what lets the LoD select answer "has a SOLID at
 * LoD X" from the in-memory model, before any source is re-read, on every
 * layer kind.
 *
 * The tag is the geometry's OWN `type`, copied once in `buildSurface`. It is
 * not derived from the semantic surface type (a RoofSurface can come from a
 * MultiSurface or from a Solid) and it is not derived from the boundary
 * nesting (a CompositeSurface and a MultiSurface nest identically).
 */
import { describe, expect, it } from "vitest";
import type { CityJSONRoot } from "../../src/citymodel/cityjson/types";
import { parseCityJSON } from "../../src/citymodel/cityjson/parseCityJSON";

/** One unit square, as a boundary index list into `vertices`. */
const SQUARE = [0, 1, 2, 3];

function model(
  geometries: ReadonlyArray<Record<string, unknown>>,
): CityJSONRoot {
  return {
    type: "CityJSON",
    version: "2.0",
    transform: { scale: [1, 1, 1], translate: [0, 0, 0] },
    CityObjects: {
      b: { type: "Building", geometry: geometries },
    },
    vertices: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
  } as unknown as CityJSONRoot;
}

const typesOf = (root: CityJSONRoot) =>
  parseCityJSON(root).objects["b"]?.surfaces.map((s) => s.geometryType);

describe("Surface.geometryType", () => {
  it("tags a MultiSurface's surfaces", () => {
    expect(
      typesOf(
        model([{ type: "MultiSurface", lod: "2", boundaries: [[SQUARE]] }]),
      ),
    ).toEqual(["MultiSurface"]);
  });

  it("tags a CompositeSurface, which nests identically to a MultiSurface", () => {
    expect(
      typesOf(
        model([{ type: "CompositeSurface", lod: "2", boundaries: [[SQUARE]] }]),
      ),
    ).toEqual(["CompositeSurface"]);
  });

  it("tags every face of a Solid, through its shells", () => {
    expect(
      typesOf(
        model([
          { type: "Solid", lod: "2.2", boundaries: [[[SQUARE], [SQUARE]]] },
        ]),
      ),
    ).toEqual(["Solid", "Solid"]);
  });

  it("tags a MultiSolid and a CompositeSolid", () => {
    expect(
      typesOf(
        model([
          { type: "MultiSolid", lod: "2", boundaries: [[[[SQUARE]]]] },
          { type: "CompositeSolid", lod: "2", boundaries: [[[[SQUARE]]]] },
        ]),
      ),
    ).toEqual(["MultiSolid", "CompositeSolid"]);
  });

  it("keeps the LoD tag beside it, so the two answer together", () => {
    const surfaces = parseCityJSON(
      model([
        { type: "Solid", lod: "2.2", boundaries: [[[SQUARE]]] },
        { type: "MultiSurface", lod: "0", boundaries: [[SQUARE]] },
      ]),
    ).objects["b"]?.surfaces;
    expect(surfaces?.map((s) => [s.lod, s.geometryType])).toEqual([
      ["2.2", "Solid"],
      ["0", "MultiSurface"],
    ]);
  });
});
