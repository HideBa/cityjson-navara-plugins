/**
 * Implicit geometry: a `GeometryInstance` places a shared template at an
 * object, and the placed surfaces are part of the object's own surfaces, so
 * drawing, picking, styling and statistics read them like any other.
 */
import { describe, expect, it } from "vitest";
import { parseCityJSON } from "../../src/citymodel/cityjson/parseCityJSON";
import { parseCityJSONSeq } from "../../src/citymodel/cityjsonseq/parseCityJSONSeq";
import {
  placeImplicitSurfaces,
  withImplicitSurfaces,
} from "../../src/citymodel/implicitSurfaces";
import { buildCityMeshArrays } from "../../src/geometry/buildCityMeshArrays";
import type { CityJSONRoot } from "../../src/citymodel/cityjson/types";
import type {
  CityModel,
  ImplicitTemplate,
  Surface,
} from "../../src/citymodel/types";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DOUBLE = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];

const templates = {
  templates: [
    {
      type: "MultiSurface",
      lod: "1",
      boundaries: [[[0, 1, 2, 3]], [[4, 5, 6, 7]]],
      material: { "": { values: [0, 0] } },
    },
    { type: "MultiSurface", lod: "2.1", boundaries: [[[0, 1, 2, 3]]] },
  ],
  "vertices-templates": [
    [-1, -1, 0],
    [1, -1, 0],
    [1, 1, 0],
    [-1, 1, 0],
    [-1, -1, 4],
    [1, -1, 4],
    [1, 1, 4],
    [-1, 1, 4],
  ],
};

/** `fixtures/geometry-templates.city.json` of the app, inlined. */
const doc = {
  type: "CityJSON",
  version: "2.0",
  transform: { scale: [0.001, 0.001, 0.001], translate: [0, 0, 0] },
  metadata: {
    referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/7415",
  },
  CityObjects: {
    "tree-1": {
      type: "SolitaryVegetationObject",
      attributes: { species: "Quercus" },
      geometry: [
        {
          type: "GeometryInstance",
          template: 0,
          boundaries: [0],
          transformationMatrix: IDENTITY,
        },
      ],
    },
    "tree-2": {
      type: "SolitaryVegetationObject",
      attributes: { species: "Tilia" },
      geometry: [
        {
          type: "GeometryInstance",
          template: 1,
          boundaries: [1],
          transformationMatrix: DOUBLE,
        },
      ],
    },
  },
  vertices: [
    [1000, 2000, 0],
    [5000, 6000, 0],
  ],
  appearance: {
    materials: [{ name: "bark", diffuseColor: [0.4, 0.25, 0.1] }],
  },
  "geometry-templates": templates,
} as unknown as CityJSONRoot;

const square = (x: number, y: number, z: number, h: number) => [
  [x - h, y - h, z],
  [x + h, y - h, z],
  [x + h, y + h, z],
  [x - h, y + h, z],
];

function rings(surfaces: ReadonlyArray<Surface>) {
  return surfaces.map((s) => s.rings.map((r) => r.map((v) => [...v])));
}

function expectTrees(model: CityModel) {
  const tree1 = model.objects["tree-1"]!;
  const tree2 = model.objects["tree-2"]!;
  // Template vertices are real coordinates, never put through `transform`;
  // the reference point is a vertex of the document, and is.
  expect(rings(tree1.surfaces)).toEqual([
    [square(1, 2, 0, 1)],
    [square(1, 2, 4, 1)],
  ]);
  expect(rings(tree2.surfaces)).toEqual([[square(5, 6, 0, 2)]]);
  expect(tree1.surfaces.map((s) => s.lod)).toEqual(["1", "1"]);
  expect(tree2.surfaces[0]!.lod).toBe("2.1");
  expect(tree1.lod).toBe("1");
  expect(tree2.lod).toBe("2.1");
  expect(tree1.bbox).toEqual([0, 1, 0, 2, 3, 4]);
  expect(model.bbox).toEqual([0, 1, 0, 7, 8, 4]);
  // The template's appearance travels with each placement.
  expect(tree1.surfaces[0]!.material).toEqual({ "": 0 });
  expect(tree1.implicitGeometry).toEqual({
    templateId: 0,
    referencePoint: [1, 2, 0],
    transformationMatrix: IDENTITY,
  });
  expect(tree2.implicitGeometry?.transformationMatrix).toEqual(DOUBLE);
  expect([...(model.implicitTemplates?.keys() ?? [])]).toEqual([0, 1]);
  // Templates themselves stay in local coordinates.
  expect(rings(model.implicitTemplates!.get(1)!.surfaces)).toEqual([
    [square(0, 0, 0, 1)],
  ]);
}

describe("implicit geometry", () => {
  it("places a CityJSON document's templates at every instance", () => {
    expectTrees(parseCityJSON(doc));
  });

  it("places a CityJSONSeq header's templates in every feature", () => {
    const { CityObjects, vertices, ...header } = doc as unknown as Record<
      string,
      unknown
    >;
    const objects = CityObjects as Record<string, unknown>;
    const lines = [
      JSON.stringify({ ...header, CityObjects: {}, vertices: [] }),
      // One feature per tree, each with its own vertex list.
      JSON.stringify({
        type: "CityJSONFeature",
        id: "tree-1",
        CityObjects: { "tree-1": objects["tree-1"] },
        vertices: [(vertices as number[][])[0]],
      }),
      JSON.stringify({
        type: "CityJSONFeature",
        id: "tree-2",
        CityObjects: {
          "tree-2": {
            ...(objects["tree-2"] as object),
            geometry: [
              {
                type: "GeometryInstance",
                template: 1,
                boundaries: [0],
                transformationMatrix: DOUBLE,
              },
            ],
          },
        },
        vertices: [(vertices as number[][])[1]],
      }),
    ];
    expectTrees(parseCityJSONSeq(lines.join("\n")));
  });

  it("draws the placed surfaces", () => {
    const arrays = buildCityMeshArrays(parseCityJSON(doc), "L");
    expect(arrays.triangleCount).toBe(6);
  });

  it("places a template by its matrix, then its reference point", () => {
    const template: ImplicitTemplate = {
      id: 3,
      name: null,
      lod: "2",
      surfaces: [
        {
          type: "WallSurface",
          rings: [
            [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
          ],
          attributes: { a: 1 },
          lod: "2",
        },
      ],
    };
    // A quarter turn about z, with its own translation (0, 0, 10).
    const turn = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 10, 0, 0, 0, 1];
    const [placed] = placeImplicitSurfaces(template, {
      templateId: 3,
      referencePoint: [100, 200, 0],
      transformationMatrix: turn,
    });
    expect(rings([placed!])).toEqual([
      [
        [
          [100, 201, 10],
          [99, 200, 10],
          [100, 200, 11],
        ],
      ],
    ]);
    expect(placed!.type).toBe("WallSurface");
    expect(placed!.attributes).toEqual({ a: 1 });
  });

  it("adds placed surfaces to a model that carries its templates apart", () => {
    const parsed = parseCityJSON(doc);
    // A CityParquet-shaped model: references and templates, no placed faces.
    const bare: CityModel = {
      ...parsed,
      bbox: null,
      objects: Object.fromEntries(
        Object.entries(parsed.objects).map(([id, o]) => [
          id,
          { ...o, surfaces: [], bbox: null, lod: null },
        ]),
      ),
    };
    expectTrees(withImplicitSurfaces(bare));
  });
});
