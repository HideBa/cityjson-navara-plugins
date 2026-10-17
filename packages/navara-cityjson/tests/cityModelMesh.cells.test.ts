/**
 * A static layer drawn one grid cell at a time: the root mesh draws the
 * first cell and each further cell is a child sharing the root's buffers,
 * material and placement, so the frustum culls inside the city and a
 * raycast tests only the cells its ray reaches.
 */
import { describe, it, expect } from "vitest";
import { Matrix4, type Mesh } from "three";
import type { CityModel, CityObject, Surface } from "@cityjson/navara-core";
import { CityModelMesh } from "../src/cityModelMesh";

function roof(x: number): Surface {
  return {
    type: "RoofSurface",
    rings: [
      [
        [x, 446000, 6],
        [x + 10, 446000, 6],
        [x + 10, 446010, 6],
        [x, 446010, 6],
      ],
    ],
    attributes: {},
    lod: "2",
  };
}

function building(id: string, x: number, type = "Building"): CityObject {
  return {
    id,
    objectType: type,
    attributes: {},
    surfaces: [roof(x)],
    bbox: [x, 446000, 6, x + 10, 446010, 6],
    children: [],
    parents: [],
    lod: "2",
  };
}

/** A and C share a cell at the west end; B is 600 m east, in its own. The
 *  layer's centre is x = 85305, so A sits at ENU x ~ -300 and B at ~ +300. */
const model: CityModel = {
  sourceEncoding: "cityjson",
  metadata: { referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/7415" },
  bbox: [85000, 446000, 0, 85610, 446010, 6],
  objects: {
    A: building("A", 85000),
    B: building("B", 85600, "Bridge"),
    C: building("C", 85020),
  },
  vertexCount: 12,
};

const opts = {
  id: "L1",
  model,
  crs: "https://www.opengis.net/def/crs/EPSG/0/7415",
  lod: "2",
  makePlacementMatrix: () => new Matrix4().makeTranslation(1, 2, 3),
};

function cellChildren(m: CityModelMesh): Mesh[] {
  return m.object3d.children.filter((c) => c.name.includes(":cell")) as Mesh[];
}

/** Straight down onto ENU (x, y); the test matrix adds (1, 2, 3). The
 *  squares are turned by the grid convergence, so aim inside them. */
function down(x: number, y: number) {
  return {
    origin: { x: x + 1, y: y + 2, z: 1000 },
    direction: { x: 0, y: 0, z: -1 },
  };
}

describe("CityModelMesh cells", () => {
  it("draws the first cell itself and each further cell as a child on the same buffers", () => {
    const m = new CityModelMesh(opts);
    const root = m.object3d;
    const cells = cellChildren(m);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    for (const name of ["position", "normal", "citySlot"]) {
      expect(cell.geometry.getAttribute(name)).toBe(
        root.geometry.getAttribute(name),
      );
    }
    expect(cell.geometry.getIndex()).toBe(root.geometry.getIndex());
    const indexCount = root.geometry.getIndex()!.count;
    expect(root.geometry.drawRange.count + cell.geometry.drawRange.count).toBe(
      indexCount,
    );
    expect(cell.geometry.drawRange.start).toBe(root.geometry.drawRange.count);
    expect(cell.material).toBe(root.material);
    expect(cell.customDepthMaterial).toBe(root.customDepthMaterial);
    expect(cell.castShadow).toBe(true);
    expect(cell.receiveShadow).toBe(true);
    expect(cell.matrixAutoUpdate).toBe(false);
    expect(cell.matrixWorld.equals(root.matrixWorld)).toBe(true);
    m.dispose();
  });

  it("bounds each cell by its own vertices and the root by the whole layer", () => {
    const m = new CityModelMesh(opts);
    const cell = cellChildren(m)[0]!;
    // B alone: a 10 m square, centred near ENU x = +300.
    expect(cell.geometry.boundingSphere!.radius).toBeLessThan(10);
    expect(cell.geometry.boundingSphere!.center.x).toBeCloseTo(300, -1);
    expect(m.object3d.geometry.boundingSphere!.radius).toBeGreaterThan(300);
    m.dispose();
  });

  it("raycasts every cell and resolves the surface hit in each", () => {
    const m = new CityModelMesh(opts);
    expect(m.resolveRaycastSelection(down(-300, -4))).toMatchObject({
      objectId: "A",
    });
    expect(m.resolveRaycastSelection(down(300, 4))).toMatchObject({
      objectId: "B",
    });
    expect(m.resolveRaycastSelection(down(-280, -4))).toMatchObject({
      objectId: "C",
    });
    expect(m.raycast(down(0, 0))).toBeNull();
    m.dispose();
  });

  it("skips a hidden object in a child cell", () => {
    const m = new CityModelMesh(opts);
    m.setHiddenTypes(["Bridge"]);
    expect(m.raycast(down(300, 4))).toBeNull();
    expect(m.triangleCount()).toBe(4);
    m.dispose();
  });

  it("re-places the child cells with the root", () => {
    const m = new CityModelMesh({ ...opts, makePlacementMatrix: undefined });
    m.setHeightOffset(43);
    const cell = cellChildren(m)[0]!;
    expect(cell.matrixWorld.equals(m.object3d.matrixWorld)).toBe(true);
    m.dispose();
  });

  it("replaces the cells on a rebuild, sharing the new buffers", () => {
    const m = new CityModelMesh(opts);
    const before = cellChildren(m)[0]!;
    m.setLod("1"); // no LoD 1 anywhere: an empty layer, one empty cell
    expect(cellChildren(m)).toHaveLength(0);
    m.setLod("2");
    const after = cellChildren(m);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before);
    expect(after[0]!.geometry.getAttribute("position")).toBe(
      m.object3d.geometry.getAttribute("position"),
    );
    m.dispose();
  });

  it("gives each cell its own image groups, indexing the shared material array", () => {
    const uvs = [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    ] as const;
    const textured = (o: CityObject, textureIndex: number): CityObject => ({
      ...o,
      surfaces: o.surfaces.map((sf) => ({
        ...sf,
        texture: { rgb: { textureIndex, uvs } },
      })),
    });
    const m = new CityModelMesh({
      ...opts,
      textureSource: { load: () => {} },
      appearance: { kind: "texture", name: "rgb" },
      model: {
        ...model,
        objects: {
          A: textured(model.objects.A!, 0),
          B: textured(model.objects.B!, 1),
          C: textured(model.objects.C!, 1),
        },
        appearance: {
          materials: [],
          textures: [
            { image: "a.jpg", type: "JPG" },
            { image: "b.jpg", type: "JPG" },
          ],
          textureThemes: ["rgb"],
          materialThemes: [],
          defaultTextureTheme: "rgb",
          defaultMaterialTheme: null,
        },
      },
    });
    const root = m.object3d;
    const cell = cellChildren(m)[0]!;
    const materials = root.material as unknown[];
    // West cell: A (image 0) and C (image 1); east cell: B (image 1).
    expect(root.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
    expect(cell.geometry.groups.map((g) => g.materialIndex)).toEqual([2]);
    expect(materials).toHaveLength(3);
    expect(cell.material).toBe(root.material);
    expect(m.resolveRaycastSelection(down(300, 4))).toMatchObject({
      objectId: "B",
    });
    m.dispose();
  });

  it("keeps a small layer in the root alone", () => {
    const m = new CityModelMesh({
      ...opts,
      model: {
        ...model,
        objects: { A: model.objects.A!, C: model.objects.C! },
      },
    });
    expect(cellChildren(m)).toHaveLength(0);
    expect(m.object3d.geometry.drawRange.count).toBe(
      m.object3d.geometry.getIndex()!.count,
    );
    m.dispose();
  });
});
