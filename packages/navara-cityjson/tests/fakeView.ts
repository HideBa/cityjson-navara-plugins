/**
 * Structural test doubles for Navara's `ThreeView` / `ViewContext` / `Plugin`
 * seams. Every plugin unit test in this repo drives one of these instead of the
 * real engine.
 *
 * **Never import `@navaramap/*` from this file (or from anything that imports
 * it).** The engine crashes at module scope under Node
 * (`NODE_IMPORT_SAFE = false`: a bundled platform shim evaluates
 * `os.cpus().length` on import), so a fake can never be injected late enough to
 * save a test that pulled the engine in. These classes are therefore
 * *structural* stand-ins: they duplicate the shapes read from
 * `@navaramap/three@0.0.5`'s `dist/index.d.ts`, and share nothing with it at
 * runtime. `three` itself is safe under Node and is used for real (`Scene`,
 * `PerspectiveCamera`, `Ray`, `Vector2`), so meshes/rays/frames behave exactly
 * as they will in the browser.
 *
 * Fidelity rules encoded here (all measured in the Task B1 spike — see
 * `docs/superpowers/research/2026-08-01-navara-spike-findings.md`):
 *
 * - `registerMesh()` works only **after** `await view.init()` — the real view
 *   builds its descriptor registries inside `init()` and throws
 *   `TypeError: Cannot read properties of undefined (reading 'mesh')` before
 *   that. Registering from inside `Plugin.init(view, ctx)` is allowed: the
 *   registries exist by the time plugins run.
 * - `addPlugin()` works only **before** `init()`.
 * - `addMesh()` needs an inited view *and* a registered descriptor name.
 * - Camera events (`movestart` / `move` / `moveend` / `frustumChanged`) live on
 *   `view.camera`; `resize` / `idle` / `pick` / `click` / `mouse*` /
 *   `pre|postUpdate` / `pre|postRender` / `layer` live on `view`.
 * - `flyTo()` emits a full `movestart … moveend` burst (indistinguishable from
 *   a user gesture); `setCamera()` emits no move events at all; `resize()`
 *   emits `resize` + `frustumChanged`. All three settle into `idle`.
 * - A mesh's ENU→ECEF frame is passed as a **top-level** `matrixWorld` in the
 *   `addMesh` config, next to the descriptor key.
 * - `getPickRay` is a free function from `@navaramap/three`, not a view method:
 *   `getPickRay({width, height, pixelRatio}, view.camera.raw, screenPosCssPx)`.
 *   Fake it with {@link makeFakePickRay} and pass it in as a seam.
 *
 * Simplifications (documented, not accidental): `idle` is emitted
 * synchronously rather than after the engine's ~100 ms idle threshold, and a
 * `flyTo` burst contains a single `move` instead of one per rendered frame.
 */
import {
  Group,
  PerspectiveCamera,
  Ray,
  Scene,
  Vector2,
  Vector3,
} from "three";

// `any` (not `unknown`) in the parameter position is deliberate: it is what
// makes an event map assignable to `Record<string, AnyListener>`, exactly as
// the engine's own `BaseEventMap` declares it.
// biome-ignore lint/suspicious/noExplicitAny: matches the engine's BaseEventMap
type AnyListener = (...args: any[]) => unknown;

/**
 * Stand-in for `EventHandler<T>`: `on` / `off` / `once` / `clear` / `size` /
 * `emit` with the same Set-backed semantics.
 */
export class FakeEventHandler<T extends Record<string, AnyListener>> {
  readonly events: { [K in keyof T]?: Set<T[K]> } = {};
  readonly onceEvents: { [K in keyof T]?: Set<T[K]> } = {};

  on<K extends keyof T>(k: K, f: T[K]): void {
    (this.events[k] ??= new Set<T[K]>()).add(f);
  }

  once<K extends keyof T>(k: K, f: T[K]): void {
    (this.onceEvents[k] ??= new Set<T[K]>()).add(f);
  }

  off<K extends keyof T>(k: K, f: T[K]): void {
    this.events[k]?.delete(f);
    this.onceEvents[k]?.delete(f);
  }

  clear<K extends keyof T>(k: K): void {
    this.events[k]?.clear();
    this.onceEvents[k]?.clear();
  }

  size<K extends keyof T>(k: K): number | undefined {
    const on = this.events[k]?.size;
    const once = this.onceEvents[k]?.size;
    if (on === undefined && once === undefined) return undefined;
    return (on ?? 0) + (once ?? 0);
  }

  emit<K extends keyof T>(k: K, ...args: Parameters<T[K]>): void {
    for (const f of [...(this.events[k] ?? [])]) f(...args);
    const once = this.onceEvents[k];
    if (once) {
      this.onceEvents[k] = undefined;
      for (const f of [...once]) f(...args);
    }
  }
}

/** `XYZ` — the engine's ECEF/vector record. */
export type FakeXYZ = { x: number; y: number; z: number };

/** `LatLngHeight` (degrees, degrees, metres above the ellipsoid). */
export type FakeLatLngHeight = { lat: number; lng: number; height: number };

/** `CameraOrientation` (degrees). */
export type FakeCameraOrientation = {
  heading: number;
  pitch: number;
  roll: number;
};

/** `CameraPosition` — the argument of `setCamera` / `flyTo`. */
export type FakeCameraPosition = Partial<FakeLatLngHeight> &
  Partial<FakeCameraOrientation> & { distance?: number };

/** `MapMouseEvent` — a `MouseEvent` plus the ECEF point under the cursor. */
export type FakeMapMouseEvent = {
  map: FakeXYZ;
  clientX: number;
  clientY: number;
  button?: number;
};

/** `PickedFeature` / `FeatureInfo`, as delivered by the engine's `pick` event. */
export type FakePickedFeature = {
  batchId: number;
  properties: Record<string, unknown> | undefined;
  layerId: string | undefined;
};

/** `CameraEvent` — the events that live on `view.camera`. */
export type FakeCameraEvents = {
  movestart: () => void;
  move: () => void;
  moveend: () => void;
  frustumChanged: () => void;
};

/** `ViewEvents` — the events that live on `view` itself. */
export type FakeViewEvents = {
  resize: (w: number, h: number) => void;
  pick: (info: FakePickedFeature | null) => void;
  click: (e: FakeMapMouseEvent) => void;
  mousedown: (e: FakeMapMouseEvent) => void;
  mouseup: (e: FakeMapMouseEvent) => void;
  mousemove: (e: FakeMapMouseEvent) => void;
  mouseenter: (e: FakeMapMouseEvent) => void;
  mouseleave: (e: FakeMapMouseEvent) => void;
  preUpdate: (t: number) => void;
  postUpdate: (t: number) => void;
  preRender: (t: number) => void;
  postRender: (t: number) => void;
  layer: (k: string, layerId: string, ...args: unknown[]) => void;
  idle: () => void;
};

/** `ViewContextEvents`. */
export type FakeViewContextEvents = {
  shadowApplied: (material: unknown) => void;
  shadowRemoved: (material: unknown) => void;
  effectSlotsChanged: () => void;
};

/** `PassKey` plus the non-pass scenes the real `Scenes` record carries. */
export type FakeScenes = {
  light: Group;
  mrt: Scene;
  globe: Scene;
  draped: Scene;
  opaque: Scene;
  transparent: Scene;
  skyEnvMap: Scene;
};

/**
 * Stand-in for `ViewContext`.
 *
 * Mirrors the members plugin code actually touches: the per-pass scenes a
 * `MeshDesc` adds its object to, the picking registry, and the batch-id
 * allocator. The real `ViewContext` has **no** `addToScene` / `removeFromScene`
 * / `setupMaterialForMRT` methods — `addToScene(passKey)` is a `MeshDesc`
 * method, and `setupMaterialForMRT` is a free export of `@navaramap/three`
 * (which the spike proved we do not need at all: a plain built-in material
 * with `vertexColors: true` renders correctly through MRT — Navara patches
 * three's own `ShaderLib` entries on import).
 */
export class FakeViewContext extends FakeEventHandler<FakeViewContextEvents> {
  readonly scenes: FakeScenes = {
    light: new Group(),
    mrt: new Scene(),
    globe: new Scene(),
    draped: new Scene(),
    opaque: new Scene(),
    transparent: new Scene(),
    skyEnvMap: new Scene(),
  };
  /** Everything handed to {@link registerPickableMesh}, still registered. */
  readonly pickableMeshes = new Map<string, unknown>();
  /** Every material passed to `applyShadowMaterial`, in order. */
  readonly shadowMaterials: unknown[] = [];
  private nextBatchId = 1;

  /** Real range is 1..0xffffff; `undefined` before the core exists. */
  genGlobalBatchId(): number | undefined {
    return this.nextBatchId++;
  }

  registerPickableMesh(key: string, mesh: unknown): void {
    this.pickableMeshes.set(key, mesh);
  }

  unregisterPickableMesh(key: string): void {
    this.pickableMeshes.delete(key);
  }

  applyShadowMaterial(material: unknown): void {
    this.shadowMaterials.push(material);
    this.emit("shadowApplied", material);
  }

  removeShadowMaterial(material: unknown): void {
    const i = this.shadowMaterials.indexOf(material);
    if (i >= 0) this.shadowMaterials.splice(i, 1);
    this.emit("shadowRemoved", material);
  }
}

/**
 * Stand-in for `ThreeViewCamera`. `raw` is a real `PerspectiveCamera` so
 * pick-ray and raycast code can use it unmodified.
 */
export class FakeThreeViewCamera extends FakeEventHandler<FakeCameraEvents> {
  readonly raw = new PerspectiveCamera(60, 16 / 9, 1, 1e7);
  positionGeographic: FakeLatLngHeight = { lat: 52.01, lng: 4.35, height: 500 };
  orientation: FakeCameraOrientation = { heading: 0, pitch: -45, roll: 0 };
  zoom: number | undefined = 16;
  fovy: number | undefined = 60;

  /** Mirrors the real getter, which returns `raw.position` in ECEF. */
  get positionECEF(): FakeXYZ {
    const { x, y, z } = this.raw.position;
    return { x, y, z };
  }

  /** Test helper: merge a partial `CameraPosition` into the fake state. */
  apply(camPos: FakeCameraPosition): void {
    const { lat, lng, height, heading, pitch, roll } = camPos;
    if (lat !== undefined) this.positionGeographic.lat = lat;
    if (lng !== undefined) this.positionGeographic.lng = lng;
    if (height !== undefined) this.positionGeographic.height = height;
    if (heading !== undefined) this.orientation.heading = heading;
    if (pitch !== undefined) this.orientation.pitch = pitch;
    if (roll !== undefined) this.orientation.roll = roll;
  }
}

/** `MeshConfig` keys that are not the descriptor's own nested key. */
const MESH_CONFIG_RESERVED_KEYS = new Set([
  "id",
  "type",
  "visible",
  "position",
  "scale",
  "rotation",
  "matrix",
  "matrixWorld",
  "effectIds",
]);

/** The `addMesh` argument: one descriptor key plus the shared `MeshConfig`. */
export type FakeMeshConfig = Record<string, unknown> & {
  id?: string;
  visible?: boolean;
  /** ENU→ECEF frame, top-level (NOT inside the descriptor's own key). */
  matrixWorld?: unknown;
};

/**
 * Stand-in for `MeshHandle` / `BaseHandle`: `id`, `ref`, `visible`, `update`,
 * `delete`, plus recording fields (`updates`, `deleted`, `config`) for tests.
 */
export class FakeMeshHandle<T = unknown> {
  /** Every patch passed to {@link update}, in order. */
  readonly updates: FakeMeshConfig[] = [];
  deleted = false;
  private _visible: boolean;

  constructor(
    readonly id: string,
    /** The descriptor key this mesh was created from (e.g. `"cityModel"`). */
    readonly descName: string,
    /** The live config: the original object with every patch merged on top. */
    readonly config: FakeMeshConfig,
    readonly ref: T,
    private readonly onDelete: (id: string) => void,
  ) {
    this._visible = config.visible ?? true;
  }

  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    this._visible = v;
    this.config.visible = v;
  }

  update(patch: FakeMeshConfig): void {
    this.updates.push(patch);
    Object.assign(this.config, patch);
    if (patch.visible !== undefined) this._visible = patch.visible;
  }

  delete(): void {
    if (this.deleted) return;
    this.deleted = true;
    this.onDelete(this.id);
  }
}

/** Stand-in for the abstract `Plugin<TView, TCtx>`. */
export interface FakePlugin {
  init(view: FakeThreeView, ctx: FakeViewContext): Promise<void>;
}

/**
 * Stand-in for `ThreeView`. See the file header for the fidelity rules it
 * enforces; the ordering throws are the point of the double, not an accident.
 */
export class FakeThreeView extends FakeEventHandler<FakeViewEvents> {
  readonly ctx = new FakeViewContext();
  readonly camera = new FakeThreeViewCamera();
  /** Name → descriptor constructor, as passed to {@link registerMesh}. */
  readonly registeredMeshes = new Map<string, unknown>();
  /** Plugins added before `init()`, in insertion order. */
  readonly plugins: FakePlugin[] = [];
  /**
   * Every config passed to {@link addMesh}, in order (never pruned). These are
   * the caller's own objects — the same references `handle.config` merges
   * patches into, so assert on them before calling `handle.update()`, or assert
   * on `handle.updates` instead.
   */
  readonly addedConfigs: FakeMeshConfig[] = [];
  /** Every handle {@link addMesh} ever returned (never pruned). */
  readonly handles: FakeMeshHandle[] = [];
  /** Live meshes only: `delete()` removes its entry. */
  readonly meshes = new Map<string, FakeMeshHandle>();
  readonly setCameraCalls: FakeCameraPosition[] = [];
  readonly flyToCalls: Array<{
    camPos: FakeCameraPosition;
    duration?: number;
    maxHeight?: number;
  }> = [];

  initialized = false;
  disposed = false;
  screenSize = new Vector2(1280, 720);
  pixelRatio = 1;

  /**
   * Seam for building `handle.ref`. Left `null`, `ref` is a plain
   * `{ descName, config }` record; set it to construct a real descriptor
   * double (the engine's `MeshDescConstructor` is `(view, ctx, config)`).
   */
  descriptorFactory: ((descName: string, config: FakeMeshConfig) => unknown) | null =
    null;

  private registriesReady = false;
  private nextMeshId = 1;

  registerMesh(name: string, meshClass: unknown): void {
    if (!this.registriesReady) {
      // Mirrors the real failure: the registries are built inside `init()`.
      throw new TypeError(
        "Cannot read properties of undefined (reading 'mesh') " +
          "— FakeThreeView: registerMesh() was called before init()",
      );
    }
    this.registeredMeshes.set(name, meshClass);
  }

  addPlugin(plugin: FakePlugin): this {
    if (this.initialized) {
      throw new Error(
        "FakeThreeView: addPlugin() must be called before init()",
      );
    }
    this.plugins.push(plugin);
    return this;
  }

  async init(): Promise<void> {
    // Registries exist before plugins run, so a plugin may call registerMesh
    // from inside its own `init(view, ctx)`.
    this.registriesReady = true;
    for (const plugin of this.plugins) await plugin.init(this, this.ctx);
    this.initialized = true;
  }

  dispose(): void {
    this.disposed = true;
  }

  addMesh<T = unknown>(config: FakeMeshConfig): FakeMeshHandle<T> {
    if (!this.registriesReady) {
      throw new Error("FakeThreeView: addMesh() was called before init()");
    }
    const descName = Object.keys(config).find(
      (k) => !MESH_CONFIG_RESERVED_KEYS.has(k),
    );
    if (descName === undefined) {
      throw new Error(
        `FakeThreeView: addMesh() config has no descriptor key: ${JSON.stringify(
          Object.keys(config),
        )}`,
      );
    }
    if (!this.registeredMeshes.has(descName)) {
      throw new Error(
        `FakeThreeView: no mesh descriptor registered for "${descName}"`,
      );
    }

    this.addedConfigs.push(config);
    const id = config.id ?? `fake-mesh-${this.nextMeshId++}`;
    const ref = (
      this.descriptorFactory
        ? this.descriptorFactory(descName, config)
        : { descName, config }
    ) as T;
    const handle = new FakeMeshHandle<T>(id, descName, config, ref, (deleted) =>
      this.meshes.delete(deleted),
    );
    this.handles.push(handle);
    this.meshes.set(id, handle);
    return handle;
  }

  /** Instant camera move. Emits **no** move events — only the ambient `idle`. */
  setCamera(camPos: FakeCameraPosition): void {
    this.setCameraCalls.push(camPos);
    this.camera.apply(camPos);
    this.emit("idle");
  }

  /**
   * Animated camera move. Emits a full `movestart … moveend` burst — at the
   * event level it is indistinguishable from a user gesture, so anything that
   * commits on `moveend` must bracket/suppress `flyTo`.
   */
  flyTo(
    camPos: FakeCameraPosition,
    duration?: number,
    maxHeight?: number,
  ): void {
    this.flyToCalls.push({ camPos, duration, maxHeight });
    this.camera.emit("movestart");
    this.camera.emit("move");
    this.camera.apply(camPos);
    this.camera.emit("moveend");
    this.emit("idle");
  }

  /** Emits `resize` (view) then `frustumChanged` (camera), never `move*`. */
  resize(width?: number, height?: number, pixelRatio?: number): void {
    const w = width ?? this.screenSize.x;
    const h = height ?? this.screenSize.y;
    this.screenSize = new Vector2(w, h);
    if (pixelRatio !== undefined) this.pixelRatio = pixelRatio;
    this.camera.raw.aspect = h === 0 ? 1 : w / h;
    this.emit("resize", w, h);
    this.camera.emit("frustumChanged");
    this.emit("idle");
  }

  /**
   * Test helper: replay a user gesture's event burst — one `movestart`,
   * `moves` × `move`, one `moveend`, then `idle`. Inertia lives inside the same
   * burst, so a drag with coasting is still exactly one burst.
   */
  emitUserMove(moves = 1, camPos?: FakeCameraPosition): void {
    this.camera.emit("movestart");
    for (let i = 0; i < moves; i++) this.camera.emit("move");
    if (camPos) this.camera.apply(camPos);
    this.camera.emit("moveend");
    this.emit("idle");
  }
}

/** The `windowLike` first argument of `getPickRay` (CSS pixels). */
export type FakeWindowLike = {
  width: number;
  height: number;
  pixelRatio: number;
};

/** Build the `getPickRay` `windowLike` argument from a view, as prod code does. */
export function windowLikeOf(view: FakeThreeView): FakeWindowLike {
  return {
    width: view.screenSize.x,
    height: view.screenSize.y,
    pixelRatio: view.pixelRatio,
  };
}

export type FakePickRayCall = {
  windowLike: FakeWindowLike;
  camera: PerspectiveCamera;
  screenPos: Vector2;
};

/** Fake of `getPickRay(windowLike, camera, screenPos) -> Ray` (ECEF). */
export interface FakePickRayFn {
  (
    windowLike: FakeWindowLike,
    camera: PerspectiveCamera,
    screenPos: Vector2,
  ): Ray;
  /** Every call's three arguments, in order. */
  readonly calls: FakePickRayCall[];
  /** The ray returned (cloned) by every call; assign to change it mid-test. */
  ray: Ray;
}

/**
 * Build a `getPickRay` seam that always returns `ray` (a clone per call, as the
 * real function returns a fresh `Ray`) and records its arguments.
 */
export function makeFakePickRay(
  ray: Ray = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, -1)),
): FakePickRayFn {
  const calls: FakePickRayCall[] = [];
  const fn = ((
    windowLike: FakeWindowLike,
    camera: PerspectiveCamera,
    screenPos: Vector2,
  ): Ray => {
    calls.push({ windowLike, camera, screenPos });
    return fn.ray.clone();
  }) as FakePickRayFn;
  Object.defineProperty(fn, "calls", { value: calls });
  fn.ray = ray;
  return fn;
}
