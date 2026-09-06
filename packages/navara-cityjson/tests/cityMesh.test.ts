/**
 * `cityMesh.ts` is the engine-free half of the streaming mesh path (Tasks
 * C8/C10a build one of these per resident cell), so this suite imports it
 * directly and never touches `@navaramap/*`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DoubleSide,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshLambertMaterial,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
  type MeshBasicMaterial,
} from "three";
import { makeEnuFrame, type CityMeshArrays } from "@cityjson/navara-core";
import {
  addCityMeshArrays,
  CityMeshArraysMesh,
  type AddCityMeshArraysOptions,
} from "../src/cityMesh";
import { DEFAULT_THEME_STYLE } from "../src/themeStyle";
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

  // Real CityJSON carries inconsistent face winding, and this app's own
  // `orientExteriorRing` heuristic (flip a face whose normal points at the
  // object's bbox centre) actively MIS-orients concave geometry — an L-shaped
  // building's inner walls legitimately face their own centroid. Measured on
  // the Delft sample at a fixed camera, front-face culling removed ~1.1% of
  // the viewport in building pixels that double-sided rendering shows.
  it("renders double-sided, so a mis-wound face is not culled away", () => {
    const mesh = new CityMeshArraysMesh(opts());
    expect((mesh.object3d.material as { side: number }).side).toBe(DoubleSide);
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

  it("publishes setThemeStyle, so a themed layer reaches its streamed cells", async () => {
    const view = await viewWithCellDescriptor();
    const handle = addCityMeshArrays(view, opts());
    handle.setThemeStyle({ fill: "vertex", edges: { color: 0x1a1a1a } });
    const mesh = (view.handles[0]!.ref as { cityMesh: CityMeshArraysMesh })
      .cityMesh;
    expect(mesh.object3d.children).toHaveLength(1);
  });
});

/**
 * Scene themes. The behaviour lives in `themeStyle.ts` and is shared with
 * `CityModelMesh`, so it is asserted once, here, on the simpler class; the
 * model-backed suite covers only what a geometry rebuild can break.
 */
describe("CityMeshArraysMesh.setThemeStyle", () => {
  const edgeChild = (m: CityMeshArraysMesh) =>
    m.object3d.children[0] as LineSegments<BufferGeometry, LineBasicMaterial>;

  it("tints UNCLAMPED, because material.color is a raw linear multiplier", () => {
    const m = new CityMeshArraysMesh(opts());
    m.setThemeStyle({ fill: "tint", tintRGB: [0.4, 2.2, 2.6], edges: null });
    const color = (m.object3d.material as MeshBasicMaterial).color;
    expect(color.r).toBeCloseTo(0.4, 5);
    // > 1 is the whole point: `setHex`/`set` would sRGB-convert and clamp this
    // to 1, and the cyber neon tint would stop being HDR.
    expect(color.g).toBeCloseTo(2.2, 5);
    expect(color.b).toBeCloseTo(2.6, 5);
    m.dispose();
  });

  it("restores a white multiplier when the fill goes back to vertex colours", () => {
    const m = new CityMeshArraysMesh(opts());
    m.setThemeStyle({ fill: "tint", tintRGB: [0.02, 0.02, 0.03], edges: null });
    m.setThemeStyle(DEFAULT_THEME_STYLE);
    const color = (m.object3d.material as MeshBasicMaterial).color;
    expect([color.r, color.g, color.b]).toEqual([1, 1, 1]);
    m.dispose();
  });

  it("adds the structural edges as a child of the mesh itself", () => {
    const m = new CityMeshArraysMesh(opts());
    m.setThemeStyle({ fill: "vertex", edges: { color: 0x1a1a1a } });

    const line = edgeChild(m);
    expect(line).toBeInstanceOf(LineSegments);
    // One triangle: three boundary edges, two endpoints each.
    expect(line.geometry.getAttribute("position").count).toBe(6);
    // A child, so it inherits the cell's ENU->ECEF placement rather than
    // needing a second copy of it.
    expect(line.parent).toBe(m.object3d);
    expect(line.matrixWorld.elements).toEqual(m.object3d.matrixWorld.elements);
    m.dispose();
  });

  it("reads a plain edge colour as sRGB and an hdr triple as linear", () => {
    const m = new CityMeshArraysMesh(opts());
    m.setThemeStyle({ fill: "vertex", edges: { color: 0x1a1a1a } });
    // 0x1a is 0.102 in sRGB, ~0.0103 once converted to the working space.
    expect(edgeChild(m).material.color.r).toBeCloseTo(0.0103, 4);

    m.setThemeStyle({
      fill: "vertex",
      edges: { color: 0x00ffff, hdr: [0.4, 2.2, 2.6] },
    });
    // Same child, recoloured — and the hdr triple wins, unconverted.
    expect(m.object3d.children).toHaveLength(1);
    expect(edgeChild(m).material.color.g).toBeCloseTo(2.2, 5);
    m.dispose();
  });

  it("removes AND disposes the edge child when the theme drops edges", () => {
    const m = new CityMeshArraysMesh(opts());
    m.setThemeStyle({ fill: "vertex", edges: { color: 0x1a1a1a } });
    const line = edgeChild(m);
    const geometry = vi.spyOn(line.geometry, "dispose");
    const material = vi.spyOn(line.material, "dispose");

    m.setThemeStyle(DEFAULT_THEME_STYLE);
    expect(m.object3d.children).toHaveLength(0);
    expect(geometry).toHaveBeenCalled();
    expect(material).toHaveBeenCalled();
    m.dispose();
  });

  it("is a no-op for an equal style, so a re-push does not rebuild the edges", () => {
    const m = new CityMeshArraysMesh(opts());
    m.setThemeStyle({ fill: "vertex", edges: { color: 0x1a1a1a } });
    const before = edgeChild(m).geometry;
    // A structurally equal style from a fresh policy object: the app re-pushes
    // layer state on every sync, and rebuilding the edge geometry each time
    // would re-extract every edge of every layer per sync.
    m.setThemeStyle({ fill: "vertex", edges: { color: 0x1a1a1a } });
    expect(edgeChild(m).geometry).toBe(before);
    m.dispose();
  });

  it("disposes a live edge child with the mesh", () => {
    const m = new CityMeshArraysMesh(opts());
    m.setThemeStyle({ fill: "vertex", edges: { color: 0x1a1a1a } });
    const line = edgeChild(m);
    const geometry = vi.spyOn(line.geometry, "dispose");
    const material = vi.spyOn(line.material, "dispose");
    m.dispose();
    expect(geometry).toHaveBeenCalled();
    expect(material).toHaveBeenCalled();
  });
});

/** The streaming twin of `CityModelMesh lighting`: both classes must agree. */
describe("CityMeshArraysMesh lighting", () => {
  it("draws with a lit Lambert material", () => {
    const m = new CityMeshArraysMesh(opts());
    expect(m.object3d.material).toBeInstanceOf(MeshLambertMaterial);
    m.dispose();
  });

  it("registers its material with the shadow hooks and unregisters it on dispose", () => {
    const hooks = { register: vi.fn(), unregister: vi.fn() };
    const m = new CityMeshArraysMesh(opts({ shadowMaterials: hooks }));
    const material = m.object3d.material;
    expect(hooks.register).toHaveBeenCalledTimes(1);
    expect(hooks.register).toHaveBeenCalledWith(material);
    m.dispose();
    expect(hooks.unregister).toHaveBeenCalledTimes(1);
    expect(hooks.unregister).toHaveBeenCalledWith(material);
  });
});
