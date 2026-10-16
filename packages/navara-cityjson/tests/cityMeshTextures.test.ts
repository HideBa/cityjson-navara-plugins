/**
 * `CityMeshArraysMesh` under a texture theme: one material per group through
 * the shared layer cache, the textured flag on exactly the surfaces whose
 * image is ready, and map swaps on `textureChanged`.
 */
import { describe, it, expect, vi } from "vitest";
import {
  Texture,
  type MeshBasicMaterial,
  type MeshLambertMaterial,
} from "three";
import { makeEnuFrame, type CityMeshArrays } from "@cityjson/navara-core";
import { CityMeshArraysMesh } from "../src/cityMesh";
import { TextureCache, type TextureSource } from "../src/texturedMaterials";
import { SLOT_TEXTURED } from "../src/slotFlags";

function arrays(): CityMeshArrays {
  const v = 6; // two triangles: one untextured, one textured
  return {
    positions: new Float32Array(v * 3).fill(1),
    normals: new Float32Array(v * 3).fill(0),
    indices: new Uint16Array(v).map((_, i) => i),
    objectKeys: ["B1"],
    objectTypes: ["Building"],
    triangleCount: 2,
    slots: Uint32Array.from([0, 0, 0, 1, 1, 1]),
    slotObjects: Uint32Array.from([0, 0]),
    slotSurfaces: Uint32Array.from([0, 1]),
    slotTextures: Int32Array.from([-1, 4]),
    slotColors: new Float32Array(6).fill(0.25),
    uvs: new Float32Array(v * 2),
    textureGroups: [
      { start: 0, count: 3, textureIndex: -1 },
      { start: 3, count: 3, textureIndex: 4 },
    ],
  };
}

function cacheWith(source: TextureSource): TextureCache {
  return new TextureCache({
    textures: () => ({ image: "a.jpg", type: "JPG" }),
    baseUrl: "https://host/x.fcb",
    source,
  });
}

const FRAME = makeEnuFrame(4.3, 52.0, 0);

describe("CityMeshArraysMesh with textures", () => {
  it("builds one material per group and flags a surface once its image is ready", () => {
    const pending: Array<(t: Texture) => void> = [];
    const cache = cacheWith({ load: (_u, onLoad) => pending.push(onLoad) });
    const mesh = new CityMeshArraysMesh({
      id: "c1",
      arrays: arrays(),
      frame: FRAME,
      textures: cache,
    });
    const materials = mesh.object3d.material as MeshBasicMaterial[];
    expect(Array.isArray(materials)).toBe(true);
    expect(materials).toHaveLength(2);
    expect(mesh.object3d.geometry.groups).toHaveLength(2);
    expect(mesh.object3d.geometry.getAttribute("uv")).toBeDefined();
    // Not ready: no surface is flagged, and colours are as given.
    expect(mesh.styleTexel(1)[3]).toBe(0);

    // Ready: the textured surface alone is flagged; its colour is kept, so a
    // recolor still lands under the image.
    pending[0]!(new Texture());
    mesh.textureChanged(4);
    expect(materials[1]!.map).not.toBeNull();
    expect(mesh.styleTexel(0)[3]).toBe(0);
    expect(mesh.styleTexel(1)[3]).toBe(SLOT_TEXTURED);
    mesh.setColors(new Float32Array(6).fill(1));
    expect(mesh.styleTexel(1)).toEqual([255, 255, 255, SLOT_TEXTURED]);
    mesh.dispose();
  });

  it("stays a single plain material without groups or cache", () => {
    const plain = new CityMeshArraysMesh({
      id: "c2",
      arrays: { ...arrays(), uvs: null, textureGroups: null },
      frame: FRAME,
      textures: cacheWith({ load: () => {} }),
    });
    expect(Array.isArray(plain.object3d.material)).toBe(false);
    expect(plain.styleTexel(1)[3]).toBe(0);
    plain.dispose();
  });
});

describe("CityMeshArraysMesh with textures: shadow hooks", () => {
  it("registers each group material, releasing the plain one it replaced, and all on dispose", () => {
    const cache = cacheWith({ load: () => {} });
    const hooks = { register: vi.fn(), unregister: vi.fn() };
    const mesh = new CityMeshArraysMesh({
      id: "c1",
      arrays: arrays(),
      frame: FRAME,
      textures: cache,
      shadowMaterials: hooks,
    });
    const materials = mesh.object3d.material as MeshLambertMaterial[];
    expect(materials).toHaveLength(2);
    // The plain material built first, then one per group.
    expect(hooks.register).toHaveBeenCalledTimes(3);
    expect(hooks.register.mock.calls.slice(1).map((c) => c[0])).toEqual(
      materials,
    );
    // The plain one was released when the groups replaced it.
    expect(hooks.unregister).toHaveBeenCalledTimes(1);
    expect(hooks.unregister.mock.calls[0]![0]).toBe(
      hooks.register.mock.calls[0]![0],
    );
    mesh.dispose();
    expect(hooks.unregister).toHaveBeenCalledTimes(3);
    expect(hooks.unregister.mock.calls.slice(1).map((c) => c[0])).toEqual(
      materials,
    );
  });
});
