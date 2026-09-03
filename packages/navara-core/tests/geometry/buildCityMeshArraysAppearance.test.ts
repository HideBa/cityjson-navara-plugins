/**
 * buildCityMeshArrays under an appearance theme: UVs paired with vertices
 * through every ring reversal, texture-sorted groups, material colours, and
 * byte-identical output when no theme is set.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildCityMeshArrays } from "../../src/geometry/buildCityMeshArrays";
import { parseCityJSONSeq } from "../../src/citymodel/cityjsonseq/parseCityJSONSeq";
import { srgbToLinear } from "../../src/styling/srgb";
import { SURFACE_COLORS_LINEAR } from "../../src/styling/surfaceColors";
import type {
  CityAppearance,
  CityModel,
  CityObject,
  Surface,
  UV,
  Vec3,
} from "../../src/citymodel/types";

const rotterdamText = fs.readFileSync(
  path.resolve(
    import.meta.dirname!,
    "../../fixtures/rotterdam-two-textured.city.jsonl",
  ),
  "utf-8",
);

function object(
  id: string,
  surfaces: Surface[],
  bbox: CityObject["bbox"] = null,
): CityObject {
  return {
    id,
    objectType: "Building",
    attributes: {},
    surfaces,
    bbox,
    children: [],
    parents: [],
    lod: "2",
  };
}

function model(
  objects: Record<string, CityObject>,
  appearance?: CityAppearance,
): CityModel {
  return {
    sourceEncoding: "cityjson",
    metadata: {},
    bbox: [0, 0, 0, 10, 10, 5],
    objects,
    vertexCount: 0,
    ...(appearance ? { appearance } : {}),
  };
}

const appearance: CityAppearance = {
  materials: [
    { name: "red", diffuseColor: [1, 0, 0] },
    { name: "grey", diffuseColor: [0.5, 0.5, 0.5] },
  ],
  textures: [
    { image: "a.jpg", type: "JPG" },
    { image: "b.jpg", type: "JPG" },
  ],
  textureThemes: ["rgb"],
  materialThemes: ["paint"],
  defaultTextureTheme: "rgb",
  defaultMaterialTheme: "paint",
};

/** A unit square in the XY plane at z, with UVs that name each corner. */
const square: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
];
const squareUv: UV[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** For each emitted vertex, the UV must be the one its corner was given. */
function expectUvsPaired(
  positions: Float32Array,
  uvs: Float32Array,
  corners: ReadonlyArray<Vec3>,
  cornerUvs: ReadonlyArray<UV>,
  from = 0,
  to = positions.length / 3,
): void {
  for (let v = from; v < to; v++) {
    const p: Vec3 = [
      positions[v * 3]!,
      positions[v * 3 + 1]!,
      positions[v * 3 + 2]!,
    ];
    const k = corners.findIndex(
      (c) =>
        Math.abs(c[0] - p[0]) < 1e-6 &&
        Math.abs(c[1] - p[1]) < 1e-6 &&
        Math.abs(c[2] - p[2]) < 1e-6,
    );
    expect(k, `vertex ${v} is a corner`).toBeGreaterThanOrEqual(0);
    expect([uvs[v * 2], uvs[v * 2 + 1]]).toEqual(cornerUvs[k]);
  }
}

describe("buildCityMeshArrays without a theme", () => {
  it("emits no uvs/groups and is unchanged for a textured model", () => {
    const m = parseCityJSONSeq(rotterdamText);
    const arrays = buildCityMeshArrays(m, "L");
    expect(arrays.uvs).toBeNull();
    expect(arrays.textureGroups).toBeNull();
    // Untextured build keeps file order: object 0's surfaces come first.
    expect(arrays.objectIndices[0]).toBe(0);
    expect(arrays.objectIndices[arrays.objectIndices.length - 1]).toBe(1);
  });
});

describe("buildCityMeshArrays with a texture theme", () => {
  it("pairs UVs with vertices when the exterior ring is reversed", () => {
    // bbox centre is far ABOVE the face, so its +z Newell normal points at
    // the centre and `orientExteriorRing` reverses the ring.
    const surface: Surface = {
      type: "RoofSurface",
      rings: [square],
      attributes: {},
      lod: "2",
      texture: { rgb: { textureIndex: 0, uvs: [squareUv] } },
    };
    const m = model(
      { a: object("a", [surface], [0, 0, 0, 1, 1, 10]) },
      appearance,
    );
    const arrays = buildCityMeshArrays(m, "L", [0, 0, 0], null, null, {
      kind: "texture",
      name: "rgb",
    });
    expect(arrays.triangleCount).toBe(2);
    expect(arrays.uvs).not.toBeNull();
    expectUvsPaired(arrays.positions, arrays.uvs!, square, squareUv);
    expect(arrays.textureGroups).toEqual([
      { start: 0, count: 6, textureIndex: 0 },
    ]);
    // Reversal really happened: winding is the mirror of the unreversed case.
    const unreversed = buildCityMeshArrays(
      model({ a: object("a", [surface], [0, 0, -10, 1, 1, 0]) }, appearance),
      "L",
      [0, 0, 0],
      null,
      null,
      { kind: "texture", name: "rgb" },
    );
    expect(unreversed.normals[2]).toBeCloseTo(-arrays.normals[2]!, 6);
    expectUvsPaired(unreversed.positions, unreversed.uvs!, square, squareUv);
  });

  it("pairs UVs through a hole whose winding had to be fixed", () => {
    // Outer 4x4 square CCW, hole 1x1 also CCW (same winding → rewound).
    const outer: Vec3[] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 4, 0],
      [0, 4, 0],
    ];
    const hole: Vec3[] = [
      [1, 1, 0],
      [2, 1, 0],
      [2, 2, 0],
      [1, 2, 0],
    ];
    const outerUv: UV[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const holeUv: UV[] = [
      [0.25, 0.25],
      [0.5, 0.25],
      [0.5, 0.5],
      [0.25, 0.5],
    ];
    const surface: Surface = {
      type: "RoofSurface",
      rings: [outer, hole],
      attributes: {},
      lod: "2",
      texture: { rgb: { textureIndex: 1, uvs: [outerUv, holeUv] } },
    };
    for (const bbox of [
      [0, 0, -10, 4, 4, 0],
      [0, 0, 0, 4, 4, 10],
    ] as const) {
      const arrays = buildCityMeshArrays(
        model({ a: object("a", [surface], bbox) }, appearance),
        "L",
        [0, 0, 0],
        null,
        null,
        { kind: "texture", name: "rgb" },
      );
      expectUvsPaired(
        arrays.positions,
        arrays.uvs!,
        [...outer, ...hole],
        [...outerUv, ...holeUv],
      );
      // Triangulated area = outer − hole: proves the hole's 3D vertices are
      // in the order the triangulator was given.
      let area = 0;
      for (let t = 0; t < arrays.triangleCount; t++) {
        const b = t * 9;
        const p = arrays.positions;
        const ax = p[b + 3]! - p[b]!;
        const ay = p[b + 4]! - p[b + 1]!;
        const bx = p[b + 6]! - p[b]!;
        const by = p[b + 7]! - p[b + 1]!;
        area += Math.abs(ax * by - ay * bx) / 2;
      }
      expect(area).toBeCloseTo(15, 6);
    }
  });

  it("sorts surfaces into contiguous per-texture groups, untextured first", () => {
    const tex = (i: number): Surface["texture"] => ({
      rgb: { textureIndex: i, uvs: [squareUv] },
    });
    const s = (type: Surface["type"], texture?: Surface["texture"]): Surface => ({
      type,
      rings: [square],
      attributes: {},
      lod: "2",
      ...(texture ? { texture } : {}),
    });
    const m = model(
      {
        a: object("a", [s("RoofSurface", tex(1)), s("WallSurface")]),
        b: object("b", [s("RoofSurface", tex(0)), s("WallSurface", tex(1))]),
      },
      appearance,
    );
    const arrays = buildCityMeshArrays(m, "L", [0, 0, 0], null, null, {
      kind: "texture",
      name: "rgb",
    });
    expect(arrays.textureGroups).toEqual([
      { start: 0, count: 6, textureIndex: -1 },
      { start: 6, count: 6, textureIndex: 0 },
      { start: 12, count: 12, textureIndex: 1 },
    ]);
    // Identity travels with the vertex: (obj, surface) per range.
    const ids = (v: number): string =>
      `${arrays.objectIndices[v]}:${arrays.surfaceIndices[v]}`;
    expect(ids(0)).toBe("0:1"); // a's wall, untextured
    expect(ids(6)).toBe("1:0"); // b's roof, texture 0
    expect(ids(12)).toBe("0:0"); // a's roof, texture 1 (file order kept)
    expect(ids(18)).toBe("1:1"); // b's wall, texture 1
    expect(arrays.objectKeys).toEqual(["a", "b"]);
    // Untextured vertices carry (0,0); colours stay semantic everywhere.
    expect(arrays.uvs![0]).toBe(0);
    expect(arrays.colors[0]).toBeCloseTo(SURFACE_COLORS_LINEAR.WallSurface.r);
  });

  it("treats a surface without that theme, or with bad UV lengths, as untextured", () => {
    const bad: Surface = {
      type: "RoofSurface",
      rings: [square],
      attributes: {},
      lod: "2",
      texture: { rgb: { textureIndex: 0, uvs: [squareUv.slice(0, 3)] } },
    };
    const other: Surface = {
      type: "RoofSurface",
      rings: [square],
      attributes: {},
      lod: "2",
      texture: { night: { textureIndex: 0, uvs: [squareUv] } },
    };
    const arrays = buildCityMeshArrays(
      model({ a: object("a", [bad, other]) }, appearance),
      "L",
      [0, 0, 0],
      null,
      null,
      { kind: "texture", name: "rgb" },
    );
    expect(arrays.textureGroups).toEqual([
      { start: 0, count: 12, textureIndex: -1 },
    ]);
  });

  it("covers the whole Rotterdam fixture with groups and finite UVs", () => {
    const m = parseCityJSONSeq(rotterdamText);
    const arrays = buildCityMeshArrays(m, "L", [0, 0, 0], null, null, {
      kind: "texture",
      name: "rgbTexture",
    });
    const groups = arrays.textureGroups!;
    expect(groups.length).toBeGreaterThan(2);
    let covered = 0;
    for (const g of groups) {
      expect(g.start).toBe(covered);
      covered += g.count;
    }
    expect(covered).toBe(arrays.triangleCount * 3);
    expect(groups[0]!.textureIndex).toBe(-1);
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i]!.textureIndex).toBeGreaterThan(groups[i - 1]!.textureIndex);
    }
    for (const u of arrays.uvs!) expect(Number.isFinite(u)).toBe(true);
    // Same triangles as the untextured build, just reordered.
    expect(arrays.triangleCount).toBe(buildCityMeshArrays(m, "L").triangleCount);
  });
});

describe("buildCityMeshArrays with a material theme", () => {
  it("paints material diffuse colours (sRGB → linear) where a surface has one", () => {
    const painted: Surface = {
      type: "WallSurface",
      rings: [square],
      attributes: {},
      lod: "2",
      material: { paint: 1 },
    };
    const plain: Surface = {
      type: "WallSurface",
      rings: [square],
      attributes: {},
      lod: "2",
    };
    const arrays = buildCityMeshArrays(
      model({ a: object("a", [painted, plain]) }, appearance),
      "L",
      [0, 0, 0],
      null,
      null,
      { kind: "material", name: "paint" },
    );
    const grey = srgbToLinear([0.5, 0.5, 0.5]);
    expect(arrays.colors[0]).toBeCloseTo(grey[0], 6);
    expect(arrays.colors[1]).toBeCloseTo(grey[1], 6);
    expect(arrays.colors[6 * 3]).toBeCloseTo(SURFACE_COLORS_LINEAR.WallSurface.r, 6);
    expect(arrays.uvs).toBeNull();
    expect(arrays.textureGroups).toBeNull();
  });
});
