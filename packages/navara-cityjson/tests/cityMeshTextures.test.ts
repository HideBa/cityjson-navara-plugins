/**
 * `CityMeshArraysMesh` under a texture theme: one material per group through
 * the shared layer cache, the raw/masked colour split the streaming layer
 * relies on, and map swaps on `textureChanged`.
 */
import { describe, it, expect } from "vitest";
import { Texture, type MeshBasicMaterial } from "three";
import { makeEnuFrame, type CityMeshArrays } from "@cityjson/navara-core";
import { CityMeshArraysMesh } from "../src/cityMesh";
import { TextureCache, type TextureSource } from "../src/texturedMaterials";

function arrays(): CityMeshArrays {
  const v = 6; // two triangles: one untextured, one textured
  return {
    positions: new Float32Array(v * 3).fill(1),
    normals: new Float32Array(v * 3).fill(0),
    colors: new Float32Array(v * 3).fill(0.25),
    objectIndices: new Uint32Array(v).fill(0),
    surfaceIndices: new Uint32Array(v).fill(0),
    objectKeys: ["B1"],
    triangleCount: 2,
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
  it("builds one material per group and writes raw colours as asked", () => {
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
    // Not ready: the mask is a pass-through and colours stay as given.
    const c = new Float32Array(18).fill(0.5);
    expect(mesh.maskTextured(c)).toBe(c);
    mesh.setColors(c);
    const attr = mesh.object3d.geometry.getAttribute("color");
    expect(attr.getX(3)).toBe(0.5);

    // Ready: the mask whites out the textured group only; setColors stays raw.
    pending[0]!(new Texture());
    mesh.textureChanged(4);
    expect(materials[1]!.map).not.toBeNull();
    const masked = mesh.maskTextured(c);
    expect(masked[0]).toBe(0.5);
    expect(masked[9]).toBe(1);
    mesh.setColors(c);
    expect(attr.getX(3)).toBe(0.5);
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
    const c = new Float32Array(18);
    expect(plain.maskTextured(c)).toBe(c);
    plain.dispose();
  });
});
