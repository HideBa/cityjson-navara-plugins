/**
 * `cityMesh.ts` is the engine-free half of the streaming mesh path (Tasks
 * C8/C10a build one of these per resident cell), so this suite imports it
 * directly and never touches `@navaramap/*`.
 */
import { describe, expect, it } from "vitest";
import { Matrix4, Vector3, type BufferAttribute } from "three";
import { makeEnuFrame, type CityMeshArrays } from "@cityjson/navara-core";
import {
  addCityMeshArrays,
  CityMeshArraysMesh,
  type AddCityMeshArraysOptions,
} from "../src/cityMesh";
import { CITY_MESH_ARRAYS_KEY } from "../src/cityModelRegistry";
import { FakeThreeView } from "./fakeView";

/** One triangle in ENU metres, flat, facing +Z (up). */
function arrays(): CityMeshArrays {
  return {
    positions: Float32Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(9).fill(0.25),
    objectIndices: Uint32Array.from([0, 0, 0]),
    surfaceIndices: Uint32Array.from([2, 2, 2]),
    objectKeys: ["B1"],
    triangleCount: 1,
  };
}

const frame = makeEnuFrame(4.3571, 52.0116, 0);

function opts(
  extra: Partial<AddCityMeshArraysOptions> = {},
): AddCityMeshArraysOptions {
  return { id: "cell:1/0/0", arrays: arrays(), frame, ...extra };
}

/** A downward ECEF ray through the triangle, 100 m above it. */
function ecefRayOntoCell() {
  const m = new Matrix4().fromArray(frame.matrix);
  const origin = new Vector3(5, 3, 100).applyMatrix4(m);
  const direction = new Vector3(0, 0, -1).transformDirection(m);
  return { origin, direction };
}

/** A fake view with the cell descriptor registered and wired to the real mesh. */
async function viewWithCellDescriptor(): Promise<FakeThreeView> {
  const view = new FakeThreeView();
  await view.init();
  view.registerMesh(CITY_MESH_ARRAYS_KEY, class FakeCityMeshArraysDesc {});
  view.descriptorFactory = (_descName, config) => ({
    cityMesh: new CityMeshArraysMesh(
      (config as Record<string, AddCityMeshArraysOptions>)[
        CITY_MESH_ARRAYS_KEY
      ]!,
    ),
  });
  return view;
}

describe("CityMeshArraysMesh", () => {
  it("places the mesh by its ENU frame and disables auto matrix update", () => {
    const mesh = new CityMeshArraysMesh(opts());
    expect(mesh.object3d.matrixAutoUpdate).toBe(false);
    expect(Array.from(mesh.object3d.matrix.elements)).toEqual(
      Array.from(new Matrix4().fromArray(frame.matrix).elements),
    );
    expect(mesh.matrixWorld.elements[12]).toBe(frame.originEcef[0]);
    expect(mesh.triangleCount()).toBe(1);
    mesh.dispose();
  });

  it("setColors writes through to the live color attribute", () => {
    const mesh = new CityMeshArraysMesh(opts());
    const attr = mesh.object3d.geometry.getAttribute(
      "color",
    ) as BufferAttribute;
    expect(attr.getX(0)).toBe(0.25);
    const version = attr.version;
    mesh.setColors(new Float32Array(9).fill(0.5));
    expect(attr.getX(0)).toBe(0.5);
    // `needsUpdate` is write-only on BufferAttribute; the version bump it
    // performs is what the renderer actually reads.
    expect(attr.version).toBe(version + 1);
    mesh.dispose();
  });

  it("resolveRaycast returns the hit surface plus its ray distance", () => {
    const mesh = new CityMeshArraysMesh(opts());
    const hit = mesh.resolveRaycast(ecefRayOntoCell());
    expect(hit).toEqual({
      objectIndex: 0,
      surfaceIndex: 2,
      distance: expect.any(Number),
    });
    expect(hit!.distance).toBeCloseTo(100, 2);
    mesh.dispose();
  });

  it("resolveRaycast returns null for a hidden mesh and for a miss", () => {
    const mesh = new CityMeshArraysMesh(opts());
    mesh.setVisible(false);
    expect(mesh.resolveRaycast(ecefRayOntoCell())).toBeNull();
    mesh.setVisible(true);
    expect(
      mesh.resolveRaycast({
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: 1 },
      }),
    ).toBeNull();
    mesh.dispose();
  });

  it("batchIdMap is empty under own-raycast and one entry per triangle otherwise", () => {
    const own = new CityMeshArraysMesh(opts());
    expect(own.batchIdMap()).toEqual([]);
    own.dispose();

    const wrapper = new CityMeshArraysMesh(
      opts({ pickStrategy: "pickable-wrapper" }),
    );
    expect(wrapper.batchIdMap()).toEqual([{ objectIndex: 0, surfaceIndex: 2 }]);
    wrapper.dispose();
  });
});

describe("addCityMeshArrays", () => {
  it("returns a handle over the descriptor instance", async () => {
    const view = await viewWithCellDescriptor();
    const handle = addCityMeshArrays(view, opts());

    expect(handle.ref).toBe(view.handles[0]!.ref);
    expect(handle.triangleCount()).toBe(1);
    handle.setColors(new Float32Array(9).fill(0.5));
    handle.setVisible(false);
    expect(view.handles[0]!.visible).toBe(false);
    expect(handle.resolveRaycast(ecefRayOntoCell())).toBeNull(); // hidden
    handle.setVisible(true);
    expect(handle.resolveRaycast(ecefRayOntoCell())).toMatchObject({
      objectIndex: 0,
      surfaceIndex: 2,
    });
    handle.delete();
    expect(view.handles[0]!.deleted).toBe(true);
  });

  it("nests its options under the cell descriptor key", async () => {
    const view = await viewWithCellDescriptor();
    addCityMeshArrays(view, opts({ layerId: "L1", cellKey: "1/0/0" }));

    const config = view.addedConfigs[0]!;
    expect(Object.keys(config)).toContain(CITY_MESH_ARRAYS_KEY);
    expect(config[CITY_MESH_ARRAYS_KEY]).toMatchObject({
      id: "cell:1/0/0",
      layerId: "L1",
      cellKey: "1/0/0",
    });
  });
});
