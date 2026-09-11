/**
 * `setModel` — the write-back seam the app's computed attributes arrive
 * through. The app merges them into a NEW immutable model and hands it here;
 * the mesh must re-evaluate its style evaluator against the new attributes
 * WITHOUT rebuilding geometry (the arrays index objects by id, so only the
 * lookup changes).
 */
import { describe, expect, it } from "vitest";
import { Matrix4 } from "three";
import type { CityModel } from "@cityjson/navara-core";
import { CityModelMesh } from "../src/cityModelMesh";

function quad(z: number, lod: string) {
  return {
    type: "RoofSurface" as const,
    rings: [
      [
        [85000, 446000, z],
        [85010, 446000, z],
        [85010, 446010, z],
        [85000, 446010, z],
      ],
    ] as const,
    attributes: {},
    lod,
  };
}

const model: CityModel = {
  sourceEncoding: "cityjson",
  metadata: { referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/7415" },
  bbox: [85000, 446000, 0, 85010, 446010, 6],
  objects: {
    B1: {
      id: "B1",
      objectType: "Building",
      attributes: { fn: "house" },
      surfaces: [quad(6, "2")],
      bbox: [85000, 446000, 0, 85010, 446010, 6],
      children: [],
      parents: [],
      lod: "2",
    },
  },
  vertexCount: 4,
} as unknown as CityModel;

const opts = {
  id: "L1",
  model,
  crs: "https://www.opengis.net/def/crs/EPSG/0/7415",
  makePlacementMatrix: () => new Matrix4().makeTranslation(1, 2, 3),
};

describe("CityModelMesh.setModel", () => {
  it("swaps the model rules evaluate against and repaints", () => {
    const mesh = new CityModelMesh({ ...opts, lod: "2" });
    let seen: unknown = "never evaluated";
    mesh.setStyle((_surface, object) => {
      seen = object.object.attributes["computed_x"];
      return null;
    });
    // The evaluator ran (setStyle repaints synchronously) against the model
    // the mesh was built with, where the key does not exist.
    expect(seen).toBeUndefined();

    const next: CityModel = {
      ...model,
      objects: {
        ...model.objects,
        B1: {
          ...model.objects["B1"]!,
          attributes: { ...model.objects["B1"]!.attributes, computed_x: 7 },
        },
      },
    };
    mesh.setModel(next);
    expect(seen).toBe(7);
  });

  it("is a no-op for the model it already holds", () => {
    const mesh = new CityModelMesh({ ...opts, lod: "2" });
    let calls = 0;
    mesh.setStyle(() => {
      calls++;
      return null;
    });
    const after = calls;
    mesh.setModel(model);
    expect(calls).toBe(after);
  });

  it("leaves the geometry alone", () => {
    const mesh = new CityModelMesh({ ...opts, lod: "2" });
    const geometry = mesh.object3d.geometry;
    const triangles = mesh.triangleCount();
    mesh.setModel({ ...model });
    expect(mesh.object3d.geometry).toBe(geometry);
    expect(mesh.triangleCount()).toBe(triangles);
  });
});
