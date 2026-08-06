/**
 * The registry is the whole of the CityJSON plugin's behaviour, so this file is
 * the plugin's real unit-test suite. It imports `../src/cityModelRegistry`
 * directly — never `../src/index`, which re-exports the three engine-binding
 * modules and would drag `@navaramap/*` (and its module-scope `os.cpus()`
 * crash) into Node. See Global Constraints -> Testing conventions.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import proj4 from "proj4";
import { Matrix4, Vector3 } from "three";
import type { CityModel } from "@cityjson/navara-core";
import { CityModelMesh } from "../src/cityModelMesh";
import {
  CITY_MESH_ARRAYS_KEY,
  CITY_MODEL_MESH_KEY,
  CityModelRegistry,
  type PickRayProvider,
} from "../src/cityModelRegistry";
import type { PickStrategy } from "../src/pickStrategy";
import type { ThemeStyle } from "../src/themeStyle";
import { FakeThreeView } from "./fakeView";

// Stand-ins for CityModelMeshDesc / CityMeshArraysDesc: the registry only ever
// forwards these to view.registerMesh, so their identity is all that matters —
// and that is exactly why the registry never has to import @navaramap/*.
const FAKE_DESCS = [
  [CITY_MODEL_MESH_KEY, class FakeCityModelDesc {}],
  [CITY_MESH_ARRAYS_KEY, class FakeCityMeshArraysDesc {}],
] as const;

const noRays: PickRayProvider = { getPickRay: () => null };

/**
 * Hard network tripwire.
 *
 * `addCityModel` without an explicit `heightOffset` samples the geoid, and its
 * default sampler is core's `geoidHeightAt`, which fetches
 * terrain.reearth.land. Every case here must therefore inject a sampler (see
 * {@link makeRegistry}); this fails the run loudly if one ever stops doing so,
 * instead of silently turning a unit test into a network test.
 */
const fetchSpy = vi.fn(() => {
  throw new Error("unit tests must not hit the network");
});
beforeAll(() => vi.stubGlobal("fetch", fetchSpy));
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  expect(fetchSpy, "a unit test reached the network").not.toHaveBeenCalled();
  fetchSpy.mockClear();
});

const CRS = "https://www.opengis.net/def/crs/EPSG/0/7415";

const model: CityModel = {
  sourceEncoding: "cityjson",
  metadata: { referenceSystem: CRS },
  bbox: [85000, 446000, 0, 85010, 446010, 6],
  objects: {
    B1: {
      id: "B1",
      objectType: "Building",
      attributes: {},
      surfaces: [
        {
          type: "RoofSurface",
          rings: [
            [
              [85000, 446000, 6],
              [85010, 446000, 6],
              [85010, 446010, 6],
            ],
          ],
          attributes: {},
          lod: "2",
        },
      ],
      bbox: [85000, 446000, 0, 85010, 446010, 6],
      children: [],
      parents: [],
      lod: "2",
    },
  },
  vertexCount: 3,
};

/** The descriptor config the registry nests under CITY_MODEL_MESH_KEY. */
type CityModelConfig = {
  id: string;
  model: CityModel;
  crs?: string | number;
  lod?: string | null;
  hiddenTypes?: ReadonlyArray<string>;
  heightOffset?: number;
  pickStrategy?: PickStrategy;
};

/**
 * Wires the fake view's descriptor factory to build a real CityModelMesh with
 * an injected identity placement, standing in for `CityModelMeshDesc` — which
 * likewise exposes the behaviour object as `.cityMesh`.
 */
function withFakeDescriptor(view: FakeThreeView): void {
  view.descriptorFactory = (_descName, config) => {
    const c = (config as Record<string, CityModelConfig>)[
      CITY_MODEL_MESH_KEY
    ] as CityModelConfig;
    return {
      cityMesh: new CityModelMesh({
        ...c,
        lod: c.lod ?? null,
        makePlacementMatrix: () => new Matrix4(),
      }),
    };
  };
}

/** The CityModelMesh the fake descriptor built for the first added mesh. */
function meshOf(view: FakeThreeView): CityModelMesh {
  return (view.handles[0]!.ref as { cityMesh: CityModelMesh }).cityMesh;
}

/**
 * A ray that certainly hits the fixture's single (horizontal, +Z-facing)
 * triangle: straight down through the geometry's own bounding-sphere centre.
 * The mesh's world matrix is the injected identity, so local === world here.
 */
function rayOntoMesh(view: FakeThreeView) {
  const centre =
    meshOf(view).object3d.geometry.boundingSphere?.center ?? new Vector3();
  return {
    origin: { x: centre.x, y: centre.y, z: centre.z + 100 },
    direction: { x: 0, y: 0, z: -1 },
  };
}

/**
 * Registry under test, plus the fake plugin shell that attaches it — this keeps
 * the "descriptors registered from inside init()" assertion honest without
 * pulling the real Plugin base class (and its WASM) into Node.
 *
 * `sampleGeoidHeight` is stubbed by DEFAULT, not just in the vertical-datum
 * block: `addCityModel` without an explicit `heightOffset` otherwise falls
 * through to core's `geoidHeightAt`, which fetches terrain.reearth.land. A unit
 * test must never touch the network — the cases that care about sampling pass
 * their own fake through `deps`.
 */
function makeRegistry(
  view: FakeThreeView,
  deps: Partial<ConstructorParameters<typeof CityModelRegistry>[0]> = {},
) {
  const registry = new CityModelRegistry({
    descriptors: FAKE_DESCS,
    pickRays: noRays,
    sampleGeoidHeight: async () => 0,
    ...deps,
  });
  view.addPlugin({
    init: async (v) => {
      registry.attach(v);
    },
  });
  return registry;
}

describe("CityModelRegistry", () => {
  it("registers both descriptors during init, before the view is initialized", async () => {
    const view = new FakeThreeView();
    const registerMeshCalls: string[][] = [];
    const registry = new CityModelRegistry({
      descriptors: FAKE_DESCS,
      pickRays: noRays,
    });
    view.addPlugin({
      init: async (v) => {
        registry.attach(v);
        registerMeshCalls.push([...v.registeredMeshes.keys()]);
      },
    });

    // registerMesh before init() throws — the reason attach() is called from
    // the plugin rather than from the caller.
    expect(() => view.registerMesh("tooEarly", class {})).toThrow();

    await view.init();

    expect(view.registeredMeshes.get(CITY_MODEL_MESH_KEY)).toBe(
      FAKE_DESCS[0][1],
    );
    expect(view.registeredMeshes.get(CITY_MESH_ARRAYS_KEY)).toBe(
      FAKE_DESCS[1][1],
    );
    // The load-bearing ordering: the descriptor registries are live by the time
    // a plugin's init() runs, so registerMesh from inside init() succeeds — it
    // throws before view.init() (Task B1 finding 2). The plugin ran exactly
    // once, from inside view.init().
    expect(registerMeshCalls).toEqual([
      [CITY_MODEL_MESH_KEY, CITY_MESH_ARRAYS_KEY],
    ]);
  });

  it("addCityModel before init throws with an actionable message", () => {
    const registry = new CityModelRegistry({
      descriptors: FAKE_DESCS,
      pickRays: noRays,
    });
    expect(() => registry.addCityModel(model, { id: "L1" })).toThrow(
      /before .*init/i,
    );
  });

  it("addCityModel returns a handle with the spec surface", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view);
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    expect(handle.id).toBe("L1");
    expect(handle.triangleCount()).toBe(1);
    expect(handle.getBoundsGeodetic().west).toBeGreaterThan(4.3);
    expect(registry.getHandle("L1")).toBe(handle);
    expect(registry.handles()).toHaveLength(1);
  });

  it("addCityModel forwards id, model, lod and pick strategy to the descriptor", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view, { pickStrategy: "pickable-wrapper" });
    await view.init();

    registry.addCityModel(model, { id: "L1", lod: "2", heightOffset: 0 });
    const config = view.addedConfigs[0] as Record<string, CityModelConfig>;
    expect(config[CITY_MODEL_MESH_KEY]).toMatchObject({
      id: "L1",
      lod: "2",
      pickStrategy: "pickable-wrapper",
    });
    expect(config[CITY_MODEL_MESH_KEY]!.model).toBe(model);
  });

  it("setVisible drives both the behaviour object and the engine handle", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view);
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    handle.setVisible(false);
    expect(view.handles[0]!.visible).toBe(false);
    expect(meshOf(view).object3d.visible).toBe(false);
  });

  it("setLod / setStyle / setHighlight reach the behaviour object unchanged", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view);
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    const mesh = meshOf(view);
    const setLod = vi.spyOn(mesh, "setLod");
    const setStyle = vi.spyOn(mesh, "setStyle");
    const setHighlight = vi.spyOn(mesh, "setHighlight");

    const evaluator = () => [0, 1, 0] as const;
    const selection = {
      kind: "surface",
      layerId: "L1",
      objectId: "B1",
      surfaceIndex: 0,
    } as const;
    handle.setLod("1");
    handle.setStyle(evaluator);
    handle.setHighlight([selection]);

    expect(setLod).toHaveBeenCalledWith("1");
    expect(setStyle).toHaveBeenCalledWith(evaluator);
    // The optional `hovered` argument is normalized to null, which is what
    // CityModelMesh's signature defaults to.
    expect(setHighlight).toHaveBeenCalledWith([selection], null);
  });

  it("forwards hiddenTypes to the descriptor and through the handle to the mesh", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view);
    await view.init();

    const handle = registry.addCityModel(model, {
      id: "L1",
      lod: "2",
      hiddenTypes: ["Bridge"],
    });
    const config = view.addedConfigs[0] as Record<string, CityModelConfig>;
    expect(config[CITY_MODEL_MESH_KEY]!.hiddenTypes).toEqual(["Bridge"]);

    const setHiddenTypes = vi.spyOn(meshOf(view), "setHiddenTypes");
    handle.setHiddenTypes(["Building"]);
    expect(setHiddenTypes).toHaveBeenCalledWith(["Building"]);
  });

  // A theme is pushed AFTER the layer is added (it is deliberately not an
  // `AddCityModelOptions` field — a one-frame default is invisible during
  // load), so the handle is the only route to it.
  it("forwards a scene theme through the handle to the mesh", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view);
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    const style: ThemeStyle = {
      fill: "tint",
      tintRGB: [0.02, 0.02, 0.03],
      edges: { color: 0xffffff, hdr: [0.9, 2, 1.2] },
    };
    handle.setThemeStyle(style);
    expect(meshOf(view).object3d.children).toHaveLength(1);
  });

  it("delete removes the handle from the registry and deletes the mesh handle", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view);
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    handle.delete();
    expect(registry.getHandle("L1")).toBeUndefined();
    expect(registry.handles()).toHaveLength(0);
    expect(view.handles[0]!.deleted).toBe(true);
  });

  it("rejects a duplicate layer id rather than orphaning the first mesh", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view);
    await view.init();

    registry.addCityModel(model, { id: "L1", lod: "2" });
    expect(() => registry.addCityModel(model, { id: "L1", lod: "2" })).toThrow(
      /already/i,
    );
    // ...and after deleting it, the id is free again.
    registry.getHandle("L1")!.delete();
    expect(() =>
      registry.addCityModel(model, { id: "L1", lod: "2" }),
    ).not.toThrow();
  });

  it("resolvePick maps a PickedFeature carrying our indices to a surface selection", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view);
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    expect(
      handle.resolvePick({ properties: { objectIndex: 0, surfaceIndex: 0 } }),
    ).toEqual({
      kind: "surface",
      layerId: "L1",
      objectId: "B1",
      surfaceIndex: 0,
    });
  });

  it("resolvePick of an engine pick event returns null and warns ONCE — a batch id is per mesh, not per triangle", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = makeRegistry(view, { pickStrategy: "pickable-wrapper" });
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    // The spike measured both triangles of a probe mesh reporting the SAME
    // batch id (4666372) with properties: null, so there is nothing to resolve.
    expect(handle.resolvePick({ batchId: 4666372 })).toBeNull();
    expect(handle.resolvePick({ batchId: 4666372 })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/own-raycast/);
    warn.mockRestore();
  });

  it("batchIdMap still publishes one entry per triangle for a future per-triangle engine", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view, { pickStrategy: "pickable-wrapper" });
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    expect(handle.batchIdMap()).toEqual([{ objectIndex: 0, surfaceIndex: 0 }]);

    // ...and it is empty under the shipped own-raycast default, so nothing
    // pays to build a table no engine can index.
    const ownView = new FakeThreeView();
    withFakeDescriptor(ownView);
    const ownRegistry = makeRegistry(ownView);
    await ownView.init();
    expect(
      ownRegistry.addCityModel(model, { id: "L1", lod: "2" }).batchIdMap(),
    ).toEqual([]);
  });

  it("resolvePick with a screen point asks the INJECTED pick-ray provider, never the engine", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const getPickRay = vi.fn(() => null);
    const registry = makeRegistry(view, { pickRays: { getPickRay } });
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    expect(handle.resolvePick({ x: 12, y: 34 })).toBeNull();
    expect(getPickRay).toHaveBeenCalledWith(12, 34);
  });

  it("resolvePick with a screen point raycasts the mesh when the provider yields a ray", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    let ray: ReturnType<typeof rayOntoMesh> | null = null;
    const registry = makeRegistry(view, {
      pickRays: { getPickRay: () => ray },
    });
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    ray = rayOntoMesh(view);
    expect(handle.resolvePick({ x: 1, y: 2 })).toEqual({
      kind: "surface",
      layerId: "L1",
      objectId: "B1",
      surfaceIndex: 0,
    });
  });

  it("the handle exposes the shared-contract resolveRaycast(ray) -> RaycastHit", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view);
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    const hit = handle.resolveRaycast(rayOntoMesh(view));
    expect(hit).toEqual({
      objectIndex: 0,
      surfaceIndex: 0,
      distance: expect.any(Number),
    });
    expect(hit!.distance).toBeCloseTo(100, 3);
    // A ray pointing away from the mesh misses.
    expect(
      handle.resolveRaycast({
        origin: { x: 0, y: 0, z: 1e6 },
        direction: { x: 0, y: 0, z: 1 },
      }),
    ).toBeNull();
  });

  it("addCityModel rejects an unreferenceable CRS (spec 4.3 gate)", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view);
    await view.init();

    expect(() =>
      registry.addCityModel({ ...model, metadata: {} }, { id: "L2" }),
    ).toThrow(/Cannot georeference/);
    // ...and nothing was added to the view, so there is no orphan mesh.
    expect(view.handles).toHaveLength(0);
    expect(registry.handles()).toHaveLength(0);
  });

  it("addCityModel rejects a non-metric CRS before touching the view", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view);
    await view.init();

    // EPSG:2263 (NAD83 / New York Long Island, US survey feet) reprojects fine
    // but would scale heights and the geoid offset wrong. Register its GENUINE
    // definition here — neither proj4's built-in set nor core's KNOWN_PROJ4_DEFS
    // has it, so without this the refusal would come from the "unregistered
    // code" path and this test would not exercise the units gate it names.
    // Definition verbatim from epsg.io/2263.proj4.
    proj4.defs(
      "EPSG:2263",
      "+proj=lcc +lat_0=40.1666666666667 +lon_0=-74 +lat_1=41.0333333333333 +lat_2=40.6666666666667 +x_0=300000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs +type=crs",
    );
    expect(() => registry.addCityModel(model, { id: "L3", crs: 2263 })).toThrow(
      /not metre-based/,
    );
    expect(view.handles).toHaveLength(0);
  });
});

describe("CityModelRegistry vertical datum", () => {
  const geoidSpy = vi.fn(async () => 43.2);

  beforeEach(() => geoidSpy.mockClear());

  it("samples the geoid at the layer ORIGIN and re-places the mesh when it resolves", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view, { sampleGeoidHeight: geoidSpy });
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    // The mesh is live before the sample lands — first paint is never blocked.
    expect(handle.triangleCount()).toBe(1);
    await vi.waitFor(() => expect(geoidSpy).toHaveBeenCalledTimes(1));
    const [lng, lat] = geoidSpy.mock.calls[0] as unknown as [number, number];
    expect(lng).toBeCloseTo(4.35, 1); // fixture origin, EPSG:7415 -> WGS84
    expect(lat).toBeCloseTo(52.0, 1);
    await vi.waitFor(() =>
      expect(handle.getBoundsGeodetic().maxHeight).toBeCloseTo(6 + 43.2, 3),
    );
  });

  it("pushes the re-placed matrixWorld back through the mesh handle, so the descriptor cannot go stale", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view, { sampleGeoidHeight: geoidSpy });
    await view.init();

    registry.addCityModel(model, { id: "L1", lod: "2" });
    const meshHandle = view.handles[0]!;
    await vi.waitFor(() => expect(meshHandle.updates).toHaveLength(1));

    // The descriptor captured its matrixWorld at createMesh time; without this
    // patch a later update({ position }) would recompose from the pre-geoid
    // frame and snap the layer back down.
    const patched = meshHandle.updates[0]!.matrixWorld as Matrix4;
    expect(patched).toBe(meshOf(view).getPlacement().matrixWorld);
    expect(Array.from(patched.elements)).toEqual(
      Array.from(meshOf(view).object3d.matrixWorld.elements),
    );
  });

  it("publishes the offset on the handle, so the host can report ORTHOMETRIC heights", async () => {
    // The app's cursor readout converts an ECEF point to a geodetic
    // (ELLIPSOIDAL) height and must subtract this to get back the source
    // file's own z. Without it a Delft readout reads ~43 m too high — the
    // mirror image of the bug the offset itself exists to fix.
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view, { sampleGeoidHeight: geoidSpy });
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    // Before the sample lands the mesh really is placed at 0 — the readout
    // must track where the layer IS, not where it will be.
    expect(handle.heightOffset()).toBe(0);
    await vi.waitFor(() => expect(handle.heightOffset()).toBeCloseTo(43.2, 6));
  });

  it("publishes an explicit heightOffset straight away", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view, { sampleGeoidHeight: geoidSpy });
    await view.init();

    const handle = registry.addCityModel(model, {
      id: "L1",
      lod: "2",
      heightOffset: 12,
    });
    expect(handle.heightOffset()).toBe(12);
  });

  it("does NOT sample when the caller supplied an explicit heightOffset", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view, { sampleGeoidHeight: geoidSpy });
    await view.init();

    const handle = registry.addCityModel(model, {
      id: "L1",
      lod: "2",
      heightOffset: 12,
    });
    await Promise.resolve();
    expect(geoidSpy).not.toHaveBeenCalled();
    expect(handle.getBoundsGeodetic().maxHeight).toBeCloseTo(6 + 12, 3);
  });

  it("ignores a sample that lands after the layer was deleted", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    let release!: (v: number) => void;
    const slow = vi.fn(() => new Promise<number>((r) => (release = r)));
    const registry = makeRegistry(view, { sampleGeoidHeight: slow });
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    const mesh = meshOf(view);
    const setHeightOffset = vi.spyOn(mesh, "setHeightOffset");
    handle.delete();
    release(43.2);
    await Promise.resolve();
    await Promise.resolve();
    // No throw, and nothing tried to touch the disposed mesh.
    expect(registry.getHandle("L1")).toBeUndefined();
    expect(setHeightOffset).not.toHaveBeenCalled();
  });

  it("leaves the mesh at 0 m when the sample resolves 0 — core never rejects", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const registry = makeRegistry(view, {
      sampleGeoidHeight: vi.fn(async () => 0),
    });
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    await Promise.resolve();
    expect(handle.getBoundsGeodetic().maxHeight).toBeCloseTo(6, 3);
  });

  it("leaves the mesh at 0 m and warns when an injected sampler rejects", async () => {
    const view = new FakeThreeView();
    withFakeDescriptor(view);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = makeRegistry(view, {
      sampleGeoidHeight: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await view.init();

    const handle = registry.addCityModel(model, { id: "L1", lod: "2" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(handle.getBoundsGeodetic().maxHeight).toBeCloseTo(6, 3);
    warn.mockRestore();
  });
});
