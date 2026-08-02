import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Ray, Scene, Vector2, Vector3 } from "three";
import {
  FakeMeshHandle,
  FakeThreeView,
  FakeViewContext,
  makeFakePickRay,
  windowLikeOf,
} from "./fakeView";

describe("fakeView.ts module", () => {
  it("never imports @navaramap/* (the engine crashes at module scope in Node)", () => {
    const source = readFileSync(
      new URL("./fakeView.ts", import.meta.url),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["three"]);
  });
});

describe("FakeThreeView lifecycle", () => {
  it("runs plugin init during init() and lets a plugin register a descriptor there", async () => {
    const view = new FakeThreeView();
    const seen: string[] = [];
    class CityModelMeshDesc {}

    view.addPlugin({
      init: async (v, ctx) => {
        seen.push(v === view && ctx === view.ctx ? "init" : "bad-args");
        v.registerMesh("cityModel", CityModelMeshDesc);
      },
    });
    await view.init();

    expect(seen).toEqual(["init"]);
    expect(view.initialized).toBe(true);
    expect(view.registeredMeshes.get("cityModel")).toBe(CityModelMeshDesc);
  });

  it("rejects registerMesh BEFORE init (the registries do not exist yet)", () => {
    const view = new FakeThreeView();
    expect(() => view.registerMesh("cityModel", class {})).toThrow(TypeError);
    expect(() => view.registerMesh("cityModel", class {})).toThrow(
      /Cannot read properties of undefined \(reading 'mesh'\)/,
    );
  });

  it("accepts registerMesh AFTER init and rejects addPlugin after init", async () => {
    const view = new FakeThreeView();
    await view.init();

    view.registerMesh("cityModel", class {});
    expect(view.registeredMeshes.has("cityModel")).toBe(true);
    expect(() => view.addPlugin({ init: async () => {} })).toThrow(
      /before init/,
    );
  });

  it("dispose() marks the view disposed", async () => {
    const view = new FakeThreeView();
    await view.init();
    view.dispose();
    expect(view.disposed).toBe(true);
  });
});

describe("FakeThreeView.addMesh", () => {
  const newInitedView = async () => {
    const view = new FakeThreeView();
    await view.init();
    view.registerMesh("cityModel", class {});
    return view;
  };

  it("records the config, including the top-level matrixWorld frame", async () => {
    const view = await newInitedView();
    const matrixWorld = new Vector3(1, 2, 3); // stand-in object identity
    const handle = view.addMesh({
      cityModel: { layerId: "L1" },
      matrixWorld,
    });

    expect(view.addedConfigs).toHaveLength(1);
    expect(view.addedConfigs[0]).toMatchObject({
      cityModel: { layerId: "L1" },
      matrixWorld,
    });
    expect(handle.descName).toBe("cityModel");
    expect(view.meshes.get(handle.id)).toBe(handle);
  });

  it("builds handle.ref through descriptorFactory when one is installed", async () => {
    const view = await newInitedView();
    const built = { kind: "desc" };
    view.descriptorFactory = vi.fn(() => built);

    const handle = view.addMesh({ cityModel: { layerId: "L1" } });

    expect(handle.ref).toBe(built);
    expect(view.descriptorFactory).toHaveBeenCalledWith(
      "cityModel",
      expect.objectContaining({ cityModel: { layerId: "L1" } }),
    );
  });

  it("update() records patches and delete() drops the live mesh", async () => {
    const view = await newInitedView();
    const handle = view.addMesh({ cityModel: { layerId: "L1" } });

    handle.update({ visible: false });
    expect(handle.updates).toEqual([{ visible: false }]);
    expect(handle.visible).toBe(false);

    handle.delete();
    expect(handle.deleted).toBe(true);
    expect(view.meshes.size).toBe(0);
    expect(view.handles).toEqual([handle]);
    expect(handle).toBeInstanceOf(FakeMeshHandle);
  });

  it("rejects addMesh before init and for an unregistered descriptor name", async () => {
    const uninited = new FakeThreeView();
    expect(() => uninited.addMesh({ cityModel: {} })).toThrow(/before init/);

    const view = new FakeThreeView();
    await view.init();
    expect(() => view.addMesh({ cityModel: {} })).toThrow(
      /no mesh descriptor registered for "cityModel"/,
    );
  });
});

describe("FakeThreeView events", () => {
  it("dispatches view events to on() listeners and honours once()/off()", () => {
    const view = new FakeThreeView();
    const got: unknown[] = [];
    const onClick = (e: { clientX: number; clientY: number }) => got.push(e);

    view.on("click", onClick);
    view.emit("click", { clientX: 3, clientY: 4, map: { x: 0, y: 0, z: 0 } });
    view.off("click", onClick);
    view.emit("click", { clientX: 9, clientY: 9, map: { x: 0, y: 0, z: 0 } });

    expect(got).toEqual([
      { clientX: 3, clientY: 4, map: { x: 0, y: 0, z: 0 } },
    ]);

    let idles = 0;
    view.once("idle", () => idles++);
    view.emit("idle");
    view.emit("idle");
    expect(idles).toBe(1);
  });

  it("puts movestart/move/moveend/frustumChanged on view.camera, not on view", () => {
    const view = new FakeThreeView();
    const onView: string[] = [];
    const onCamera: string[] = [];

    // `view` has no camera events at all: subscribing is a type error, and the
    // camera's own emit must not reach view listeners.
    view.on("idle", () => onView.push("idle"));
    for (const e of ["movestart", "move", "moveend", "frustumChanged"] as const) {
      view.camera.on(e, () => onCamera.push(e));
    }

    view.emitUserMove(2);

    expect(onCamera).toEqual([
      "movestart",
      "move",
      "move",
      "moveend",
    ]);
    expect(onView).toEqual(["idle"]);
  });

  it("flyTo emits a full movestart..moveend burst; setCamera emits none", () => {
    const view = new FakeThreeView();
    const events: string[] = [];
    for (const e of ["movestart", "move", "moveend", "frustumChanged"] as const) {
      view.camera.on(e, () => events.push(e));
    }
    view.on("idle", () => events.push("idle"));

    view.flyTo({ lng: 4.3, lat: 52.05, height: 2000, heading: 30 }, 1000);
    expect(events).toEqual(["movestart", "move", "moveend", "idle"]);
    expect(view.flyToCalls).toEqual([
      {
        camPos: { lng: 4.3, lat: 52.05, height: 2000, heading: 30 },
        duration: 1000,
        maxHeight: undefined,
      },
    ]);
    expect(view.camera.positionGeographic).toEqual({
      lng: 4.3,
      lat: 52.05,
      height: 2000,
    });
    expect(view.camera.orientation.heading).toBe(30);

    events.length = 0;
    view.setCamera({ lng: 5, lat: 53, height: 300 });
    expect(events).toEqual(["idle"]);
    expect(view.setCameraCalls).toEqual([{ lng: 5, lat: 53, height: 300 }]);
    expect(view.camera.positionGeographic.height).toBe(300);
  });

  it("resize emits resize on the view and frustumChanged on the camera", () => {
    const view = new FakeThreeView();
    const events: string[] = [];
    view.on("resize", (w, h) => events.push(`resize:${w}x${h}`));
    view.camera.on("frustumChanged", () => events.push("frustumChanged"));
    view.on("idle", () => events.push("idle"));

    view.resize(1000, 700, 2);

    expect(events).toEqual(["resize:1000x700", "frustumChanged", "idle"]);
    expect(view.screenSize).toEqual(new Vector2(1000, 700));
    expect(view.pixelRatio).toBe(2);
  });
});

describe("FakeViewContext", () => {
  it("exposes real three scenes per pass key", () => {
    const ctx = new FakeViewContext();
    expect(ctx.scenes.opaque).toBeInstanceOf(Scene);
    const obj = new Scene();
    ctx.scenes.opaque.add(obj);
    expect(ctx.scenes.opaque.children).toEqual([obj]);
  });

  it("hands out unique batch ids and tracks pickable mesh registration", () => {
    const ctx = new FakeViewContext();
    const a = ctx.genGlobalBatchId();
    const b = ctx.genGlobalBatchId();
    expect(a).not.toBe(b);

    const wrapper = { id: "w" };
    ctx.registerPickableMesh("L1", wrapper);
    expect(ctx.pickableMeshes.get("L1")).toBe(wrapper);
    ctx.unregisterPickableMesh("L1");
    expect(ctx.pickableMeshes.size).toBe(0);
  });
});

describe("makeFakePickRay", () => {
  it("returns the configured ECEF ray and records its three arguments", () => {
    const view = new FakeThreeView();
    const getPickRay = makeFakePickRay(
      new Ray(new Vector3(10, 20, 30), new Vector3(0, 0, -1)),
    );
    const screenPos = new Vector2(605, 430);

    const ray = getPickRay(windowLikeOf(view), view.camera.raw, screenPos);

    expect(ray).toBeInstanceOf(Ray);
    expect(ray.origin).toEqual(new Vector3(10, 20, 30));
    expect(ray.direction).toEqual(new Vector3(0, 0, -1));
    expect(getPickRay.calls).toEqual([
      {
        windowLike: { width: 1280, height: 720, pixelRatio: 1 },
        camera: view.camera.raw,
        screenPos,
      },
    ]);
    expect(view.camera.raw).toBeInstanceOf(PerspectiveCamera);
  });
});
