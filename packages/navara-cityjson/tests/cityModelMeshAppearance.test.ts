/**
 * CityModelMesh under an appearance theme: one material per texture group,
 * progressive white-out as images land, colour fallback on failure,
 * highlight over textures, theme switches, and the plain look for `null`.
 */
import { describe, it, expect, vi } from "vitest";
import { Matrix4, Texture, type MeshBasicMaterial } from "three";
import type { CityModel, Surface } from "@cityjson/navara-core";
import { CityModelMesh } from "../src/cityModelMesh";
import type { TextureSource } from "../src/texturedMaterials";

function fakeSource() {
  const pending: Array<{
    url: string;
    onLoad: (t: Texture) => void;
    onError: (e: unknown) => void;
  }> = [];
  const source: TextureSource = {
    load: (url, onLoad, onError) => {
      pending.push({ url, onLoad, onError });
    },
  };
  return { source, pending };
}

const ring = [
  [85000, 446000, 6],
  [85010, 446000, 6],
  [85010, 446010, 6],
  [85000, 446010, 6],
] as const;
const uvs = [
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ],
] as const;

function surface(
  type: Surface["type"],
  extra: Partial<Surface> = {},
): Surface {
  return { type, rings: [ring], attributes: {}, lod: "2", ...extra };
}

const model: CityModel = {
  sourceEncoding: "cityjsonseq",
  metadata: { referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/7415" },
  bbox: [85000, 446000, 0, 85010, 446010, 6],
  objects: {
    B1: {
      id: "B1",
      objectType: "Building",
      attributes: {},
      surfaces: [
        surface("RoofSurface", {
          texture: { rgb: { textureIndex: 0, uvs } },
          material: { paint: 0 },
        }),
        surface("WallSurface", {
          texture: { rgb: { textureIndex: 1, uvs } },
        }),
        surface("GroundSurface"),
      ],
      bbox: [85000, 446000, 0, 85010, 446010, 6],
      children: [],
      parents: [],
      lod: "2",
    },
  },
  vertexCount: 4,
  appearance: {
    materials: [{ name: "red", diffuseColor: [1, 0, 0] }],
    textures: [
      { image: "appearances/a.jpg", type: "JPG" },
      { image: "appearances/b.jpg", type: "JPG" },
    ],
    textureThemes: ["rgb"],
    materialThemes: ["paint"],
    defaultTextureTheme: "rgb",
    defaultMaterialTheme: null,
  },
};

const base = {
  id: "L1",
  model,
  crs: "https://www.opengis.net/def/crs/EPSG/0/7415",
  makePlacementMatrix: () => new Matrix4().makeTranslation(1, 2, 3),
  textureBaseUrl: "https://host/data/rotterdam.jsonl",
};

/** Texture changes are coalesced onto a microtask; let it run. */
const settle = () => new Promise<void>((r) => queueMicrotask(r));

function materialsOf(m: CityModelMesh): MeshBasicMaterial[] {
  const mat = m.object3d.material;
  return (Array.isArray(mat) ? mat : [mat]) as MeshBasicMaterial[];
}

function colorAt(m: CityModelMesh, vertex: number): number[] {
  const attr = m.object3d.geometry.getAttribute("color");
  return [attr.getX(vertex), attr.getY(vertex), attr.getZ(vertex)];
}

describe("CityModelMesh with a texture theme", () => {
  it("builds one material per group, a uv attribute, and requests each image once", () => {
    const { source, pending } = fakeSource();
    const m = new CityModelMesh({
      ...base,
      appearance: { kind: "texture", name: "rgb" },
      textureSource: source,
    });
    const geometry = m.object3d.geometry;
    expect(geometry.getAttribute("uv")).toBeDefined();
    expect(geometry.groups).toHaveLength(3); // untextured, a, b
    expect(materialsOf(m)).toHaveLength(3);
    expect(pending.map((p) => p.url)).toEqual([
      "https://host/data/appearances/a.jpg",
      "https://host/data/appearances/b.jpg",
    ]);
    m.dispose();
  });

  it("keeps semantic colours until an image lands, then whites that group out", async () => {
    const { source, pending } = fakeSource();
    const m = new CityModelMesh({
      ...base,
      appearance: { kind: "texture", name: "rgb" },
      textureSource: source,
    });
    const groups = m.object3d.geometry.groups;
    const roofGroup = groups.find((g) => g.materialIndex === 1)!;
    const before = colorAt(m, roofGroup.start);
    expect(before).not.toEqual([1, 1, 1]);
    const texture = new Texture();
    pending[0]!.onLoad(texture);
    await settle();
    expect(materialsOf(m)[1]!.map).toBe(texture);
    expect(colorAt(m, roofGroup.start)).toEqual([1, 1, 1]);
    // The wall's image is still loading: its colour is untouched.
    const wallGroup = groups.find((g) => g.materialIndex === 2)!;
    expect(colorAt(m, wallGroup.start)).not.toEqual([1, 1, 1]);
    expect(materialsOf(m)[2]!.map).toBeNull();
    m.dispose();
  });

  it("falls back to colours for an image that fails", async () => {
    const { source, pending } = fakeSource();
    const m = new CityModelMesh({
      ...base,
      appearance: { kind: "texture", name: "rgb" },
      textureSource: source,
    });
    pending[1]!.onError(new Error("404"));
    await settle();
    const wallGroup = m.object3d.geometry.groups.find(
      (g) => g.materialIndex === 2,
    )!;
    expect(colorAt(m, wallGroup.start)).not.toEqual([1, 1, 1]);
    expect(materialsOf(m)[2]!.map).toBeNull();
    m.dispose();
  });

  it("paints highlights over the white mask so a selected textured face still tints", async () => {
    const { source, pending } = fakeSource();
    const m = new CityModelMesh({
      ...base,
      appearance: { kind: "texture", name: "rgb" },
      textureSource: source,
    });
    pending[0]!.onLoad(new Texture());
    await settle();
    const roofGroup = m.object3d.geometry.groups.find(
      (g) => g.materialIndex === 1,
    )!;
    m.setHighlight([
      { kind: "surface", layerId: "L1", objectId: "B1", surfaceIndex: 0 },
    ]);
    expect(colorAt(m, roofGroup.start)).not.toEqual([1, 1, 1]);
    m.setHighlight([]);
    expect(colorAt(m, roofGroup.start)).toEqual([1, 1, 1]);
    m.dispose();
  });

  it("keeps loaded images across a LoD rebuild and drops them on a theme change", async () => {
    const { source, pending } = fakeSource();
    const m = new CityModelMesh({
      ...base,
      appearance: { kind: "texture", name: "rgb" },
      textureSource: source,
    });
    const texture = new Texture();
    pending[0]!.onLoad(texture);
    await settle();
    m.setLod("2");
    m.setLod(null);
    expect(pending).toHaveLength(2); // no re-request
    expect(materialsOf(m)[1]!.map).toBe(texture);

    const dispose = vi.spyOn(texture, "dispose");
    m.setAppearance(null);
    expect(dispose).toHaveBeenCalled();
    expect(Array.isArray(m.object3d.material)).toBe(false);
    expect(m.object3d.geometry.getAttribute("uv")).toBeUndefined();
    expect(m.object3d.geometry.groups).toHaveLength(0);
    m.setAppearance({ kind: "texture", name: "rgb" });
    expect(pending).toHaveLength(4); // requested afresh
    m.dispose();
  });

  it("setAppearance with the same theme is a no-op", () => {
    const { source, pending } = fakeSource();
    const m = new CityModelMesh({
      ...base,
      appearance: { kind: "texture", name: "rgb" },
      textureSource: source,
    });
    const geometry = m.object3d.geometry;
    m.setAppearance({ kind: "texture", name: "rgb" });
    expect(m.object3d.geometry).toBe(geometry);
    expect(pending).toHaveLength(2);
    m.dispose();
  });

  it("applies the scene-theme tint to every group material", () => {
    const { source } = fakeSource();
    const m = new CityModelMesh({
      ...base,
      appearance: { kind: "texture", name: "rgb" },
      textureSource: source,
    });
    m.setThemeStyle({ fill: "tint", tintRGB: [2, 0.5, 0.5], edges: null });
    for (const material of materialsOf(m)) {
      expect(material.color.r).toBe(2);
    }
    m.setLod(null); // rebuild keeps the tint on the new materials
    m.setLod("2");
    for (const material of materialsOf(m)) {
      expect(material.color.r).toBe(2);
    }
    m.dispose();
  });

  it("still resolves a raycast pick through the grouped geometry", () => {
    const { source } = fakeSource();
    const m = new CityModelMesh({
      ...base,
      appearance: { kind: "texture", name: "rgb" },
      textureSource: source,
      makePlacementMatrix: () => new Matrix4(),
    });
    // The mesh is at the identity here; aim down at the roof from above.
    const hit = m.raycast({
      origin: { x: 5 - 5, y: 0, z: 100 },
      direction: { x: 0, y: 0, z: -1 },
    });
    // Positions are ENU deltas around the bbox centre (~0,0); the roof at
    // z≈+3 (bbox mid 3) is under the ray.
    expect(hit).not.toBeNull();
    expect(m.resolveVertexIndices(hit!.objectIndex, hit!.surfaceIndex)).toEqual({
      kind: "surface",
      layerId: "L1",
      objectId: "B1",
      surfaceIndex: hit!.surfaceIndex,
    });
    m.dispose();
  });

  it("renders untextured (with one warning) when the layer has no base URL", () => {
    const { source, pending } = fakeSource();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = new CityModelMesh({
      ...base,
      textureBaseUrl: null,
      appearance: { kind: "texture", name: "rgb" },
      textureSource: source,
    });
    expect(pending).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    for (const material of materialsOf(m)) expect(material.map).toBeNull();
    warn.mockRestore();
    m.dispose();
  });
});

describe("CityModelMesh with a synchronous texture source", () => {
  it("attaches an image that is ready before the materials exist", async () => {
    const source: TextureSource = {
      load: (_url, onLoad) => onLoad(new Texture()),
    };
    const m = new CityModelMesh({
      ...base,
      appearance: { kind: "texture", name: "rgb" },
      textureSource: source,
    });
    await settle();
    expect(materialsOf(m)[1]!.map).not.toBeNull();
    const roofGroup = m.object3d.geometry.groups.find(
      (g) => g.materialIndex === 1,
    )!;
    expect(colorAt(m, roofGroup.start)).toEqual([1, 1, 1]);
    m.dispose();
  });
});

describe("CityModelMesh with a material theme", () => {
  it("uses the material's diffuse colour as the base colour", () => {
    const m = new CityModelMesh({
      ...base,
      appearance: { kind: "material", name: "paint" },
    });
    expect(Array.isArray(m.object3d.material)).toBe(false);
    expect(colorAt(m, 0)).toEqual([1, 0, 0]);
    m.setAppearance(null);
    expect(colorAt(m, 0)).not.toEqual([1, 0, 0]);
    m.dispose();
  });
});
