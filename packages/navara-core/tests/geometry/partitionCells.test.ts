/**
 * Cutting a static build into grid cells: the same triangles, reordered so
 * every cell is one vertex range and one index range, with identity (slots,
 * objects, surfaces) untouched.
 */
import { describe, expect, it } from "vitest";
import { buildCityMeshArrays } from "../../src/geometry/buildCityMeshArrays";
import { partitionCells } from "../../src/geometry/partitionCells";
import { soupPositions } from "./vertexView";
import type {
  CityModel,
  CityObject,
  Surface,
  Vec3,
} from "../../src/citymodel/types";

function square(x: number, y: number, z = 0): Vec3[] {
  return [
    [x, y, z],
    [x + 10, y, z],
    [x + 10, y + 10, z],
    [x, y + 10, z],
  ];
}

function surface(ring: Vec3[], texture?: Surface["texture"]): Surface {
  return {
    type: "RoofSurface",
    rings: [ring],
    attributes: {},
    lod: "2",
    ...(texture ? { texture } : {}),
  };
}

function object(id: string, surfaces: Surface[]): CityObject {
  return {
    id,
    objectType: "Building",
    attributes: {},
    surfaces,
    bbox: null,
    children: [],
    parents: [],
    lod: "2",
  };
}

function model(objects: CityObject[], textures = 0): CityModel {
  return {
    sourceEncoding: "cityjson",
    metadata: {},
    bbox: [0, 0, 0, 1000, 1000, 10],
    objects: Object.fromEntries(objects.map((o) => [o.id, o])),
    vertexCount: 0,
    ...(textures
      ? {
          appearance: {
            textures: Array.from({ length: textures }, (_, i) => ({
              image: `t${i}.png`,
            })),
          },
        }
      : {}),
  } as CityModel;
}

/** Each triangle as its three corners and its slot, order-free. */
function triangles(a: ReturnType<typeof buildCityMeshArrays>): string[] {
  const soup = soupPositions(a);
  const out: string[] = [];
  for (let t = 0; t < a.triangleCount; t++) {
    const corners = [...soup.subarray(t * 9, t * 9 + 9)].join(",");
    out.push(`${a.slots[a.indices[t * 3]!]}|${corners}`);
  }
  return out.sort();
}

describe("partitionCells", () => {
  // a and c share the cell at the origin; b is 600 m east.
  const m = model([
    object("a", [surface(square(0, 0)), surface(square(0, 0, 5))]),
    object("b", [surface(square(600, 0))]),
    object("c", [surface(square(20, 20))]),
  ]);
  const built = buildCityMeshArrays(m, "L");

  it("keeps every triangle and its slot, and every identity table", () => {
    const { arrays } = partitionCells(built, 250);
    expect(triangles(arrays)).toEqual(triangles(built));
    expect(arrays.objectKeys).toEqual(built.objectKeys);
    expect([...arrays.slotObjects]).toEqual([...built.slotObjects]);
    expect([...arrays.slotSurfaces]).toEqual([...built.slotSurfaces]);
    expect([...arrays.slotColors]).toEqual([...built.slotColors]);
  });

  it("makes each cell one vertex range and one index range into it", () => {
    const { arrays, cells } = partitionCells(built, 250);
    expect(cells.length).toBe(2);
    let vertex = 0;
    let index = 0;
    for (const cell of cells) {
      expect(cell.vertexStart).toBe(vertex);
      expect(cell.indexStart).toBe(index);
      for (
        let i = cell.indexStart;
        i < cell.indexStart + cell.indexCount;
        i++
      ) {
        expect(arrays.indices[i]).toBeGreaterThanOrEqual(cell.vertexStart);
        expect(arrays.indices[i]).toBeLessThan(
          cell.vertexStart + cell.vertexCount,
        );
      }
      vertex += cell.vertexCount;
      index += cell.indexCount;
    }
    expect(vertex).toBe(arrays.positions.length / 3);
    expect(index).toBe(arrays.indices.length);
  });

  it("puts all of an object's surfaces in the cell of its centre", () => {
    const { arrays, cells } = partitionCells(built, 250);
    const objectsIn = cells.map((cell) => {
      const objects = new Set<string>();
      for (
        let v = cell.vertexStart;
        v < cell.vertexStart + cell.vertexCount;
        v++
      ) {
        objects.add(arrays.objectKeys[arrays.slotObjects[arrays.slots[v]!]!]!);
      }
      return [...objects].sort().join();
    });
    expect(objectsIn.sort()).toEqual(["a,c", "b"]);
  });

  it("keeps one cell for a layer smaller than a cell, in build order", () => {
    const small = buildCityMeshArrays(
      model([object("a", [surface(square(0, 0))])]),
      "L",
    );
    const { arrays, cells } = partitionCells(small, 250);
    expect(cells).toEqual([
      {
        vertexStart: 0,
        vertexCount: 4,
        indexStart: 0,
        indexCount: 6,
        groupStart: 0,
        groupCount: 0,
      },
    ]);
    expect([...arrays.positions]).toEqual([...small.positions]);
    expect([...arrays.indices]).toEqual([...small.indices]);
  });

  it("anchors the grid at the layer's own corner, so a small layer around its origin stays one cell", () => {
    // ENU positions are centred on the layer, so a grid anchored at 0 would
    // cut every small layer into four.
    const around = buildCityMeshArrays(
      model([
        object("a", [surface(square(-30, -30))]),
        object("b", [surface(square(20, 20))]),
      ]),
      "L",
    );
    expect(partitionCells(around, 250).cells).toHaveLength(1);
  });

  it("groups each cell's textured surfaces by image, as runs of the layer's groups", () => {
    const uv = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as [number, number][];
    const tex = (i: number) => ({ rgb: { textureIndex: i, uvs: [uv] } });
    const textured = buildCityMeshArrays(
      model(
        [
          object("a", [
            surface(square(0, 0), tex(1)),
            surface(square(0, 0, 5)),
          ]),
          object("b", [
            surface(square(600, 0), tex(0)),
            surface(square(600, 0, 5), tex(1)),
          ]),
        ],
        2,
      ),
      "L",
      [0, 0, 0],
      null,
      null,
      { kind: "texture", name: "rgb" },
    );
    const { arrays, cells } = partitionCells(textured, 250);
    const groups = arrays.textureGroups!;
    for (const cell of cells) {
      const own = groups.slice(
        cell.groupStart,
        cell.groupStart + cell.groupCount,
      );
      // Contiguous, covering exactly the cell's indices, one run per image.
      let at = cell.indexStart;
      for (const g of own) {
        expect(g.start).toBe(at);
        at += g.count;
      }
      expect(at).toBe(cell.indexStart + cell.indexCount);
      const images = own.map((g) => g.textureIndex);
      expect(new Set(images).size).toBe(images.length);
      expect([...images].sort()).toEqual(images);
    }
    // UVs travel with their vertices.
    expect(arrays.uvs!.length).toBe((arrays.positions.length / 3) * 2);
    expect(triangles(arrays)).toEqual(triangles(textured));
  });
});
