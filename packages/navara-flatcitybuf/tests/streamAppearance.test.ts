/**
 * Appearance on the streaming path: the planner swaps on a theme change, the
 * handle carries the theme on every fetch, learns the themes cells report,
 * feeds the layer-wide image cache, and repaints a cell when its image lands
 * — with the white mask under the highlight.
 */
import { describe, it, expect, vi } from "vitest";
import { makeEnuFrame, type CityTexture } from "@cityjson/navara-core";
import {
  TextureCache,
  type CityMeshHandle,
  type TextureSource,
} from "@cityjson/navara-cityjson";
import { Texture } from "three";
import { FcbStreamLayerHandle, type CellEntry } from "../src/streamLayer";
import { CellCache } from "../src/cellCache";
import { planCommit, type PlanCommitInput } from "../src/commitPlanner";
import { createLayerTextures } from "../src/layerTextures";
import type { CellMeshFactory } from "../src/cellMeshes";
import type { Grid } from "../src/tileGrid";
import type { FcbHeaderModel } from "../src/fcbSource";
import { viewportFootprint, type Ray } from "../src/viewportFootprint";
import { enuToEcef } from "@cityjson/navara-core";
import type { WorkerClient } from "../src/workerClient";
import type { CellGeometry, WorkerResponse } from "../src/workerProtocol";
import {
  RESIDENT_BYTE_BUDGET,
  RESIDENT_TRIANGLE_BUDGET,
} from "../src/constants";

const FRAME = makeEnuFrame(4.3571, 52.0116, 0);
const GRID: Grid = { originX: -5000, originY: -5000, rootCell: 10000, maxLevel: 8 };
const HEADER: FcbHeaderModel = {
  version: "1.0",
  featuresCount: 100,
  extent: [-5000, -5000, 0, 5000, 5000, 50],
  referenceSystem: "https://www.opengis.net/def/crs/EPSG/0/28992",
  epsg: 28992,
};
const TO_SOURCE_XY = (lng: number, lat: number) =>
  [(lng - FRAME.lngDeg) * 68000, (lat - FRAME.latDeg) * 111000] as const;
const TO_LNG_LAT = (x: number, y: number) =>
  [FRAME.lngDeg + x / 68000, FRAME.latDeg + y / 111000] as const;

function rays(): readonly [Ray, Ray, Ray, Ray] {
  const eye: readonly [number, number, number] = [0, 0, 500];
  const corner = (x: number, y: number): Ray => {
    const o = enuToEcef(FRAME, eye);
    const t = enuToEcef(FRAME, [x, y, 0]);
    const d = [t[0] - o[0], t[1] - o[1], t[2] - o[2]] as const;
    const len = Math.hypot(d[0], d[1], d[2]);
    return { origin: o, direction: [d[0] / len, d[1] / len, d[2] / len] };
  };
  return [corner(-400, -400), corner(400, -400), corner(400, 400), corner(-400, 400)];
}

const TEX: CityTexture = { image: "appearances/a.jpg", type: "JPG" };

/** One textured triangle (vertices 0..2 in group of texture 7). */
function texturedGeometry(): CellGeometry {
  return {
    positions: new Float32Array(9).fill(1),
    normals: new Float32Array(9).fill(2),
    baseColors: new Float32Array(9).fill(0.25),
    ruleColors: null,
    objectIndices: new Uint32Array(3).fill(0),
    surfaceIndices: new Uint32Array(3).fill(0),
    objectKeys: ["B1"],
    triangleCount: 1,
    uvs: new Float32Array(6),
    textureGroups: [{ start: 0, count: 3, textureIndex: 7 }],
    textures: [{ index: 7, texture: TEX }],
  };
}

function fakeClient() {
  let epoch = 0;
  const fetches: Array<Record<string, unknown>> = [];
  const client = {
    newEpoch: () => ++epoch,
    isCurrent: (e: number) => e === epoch,
    notify: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn(async (msg: Record<string, unknown>) =>
      msg.type === "probe"
        ? ({ type: "probed", id: 0, count: 5 } satisfies WorkerResponse)
        : ({ type: "done", id: 0 } satisfies WorkerResponse),
    ),
    sendStreaming: vi.fn(
      (msg: Record<string, unknown>, onMessage: (r: WorkerResponse) => void) => {
        if (msg.type === "recolor") {
          for (const key of msg.cells as string[]) {
            onMessage({
              type: "recolored",
              id: 0,
              key,
              ruleColors: new Float32Array(9).fill(0.5),
            });
          }
          onMessage({ type: "done", id: 0 });
          return Promise.resolve();
        }
        fetches.push(msg);
        for (const key of msg.cells as string[]) {
          onMessage({
            type: "cell",
            id: 0,
            key,
            geometry: texturedGeometry(),
            objects: [],
            surfaceAttrKeys: [],
            lodsSeen: ["2"],
            appearanceThemes: [{ kind: "texture", name: "rgb" }],
          });
        }
        onMessage({ type: "done", id: 0 });
        return Promise.resolve();
      },
    ),
  };
  return { client: client as unknown as WorkerClient, fetches };
}

/** A factory whose handles record colours and texture notifications. */
function recordingFactory(cache: TextureCache) {
  const handles: Array<{
    key: string;
    colors: Float32Array | null;
    textureChanges: number[];
    entry: CellEntry;
  }> = [];
  const factory: CellMeshFactory = {
    create(key, entry) {
      const rec = { key, colors: null as Float32Array | null, textureChanges: [] as number[], entry };
      handles.push(rec);
      // What the real `CityMeshArraysMesh` does through `buildGroupMaterials`.
      for (const g of entry.geometry.textureGroups ?? []) {
        if (g.textureIndex >= 0) cache.request(g.textureIndex);
      }
      const handle: CityMeshHandle = {
        ref: null,
        setColors: (c) => {
          rec.colors = Float32Array.from(c);
        },
        maskTextured: (c) => {
          const groups = entry.geometry.textureGroups ?? [];
          if (!groups.some((g) => cache.isReady(g.textureIndex))) return c;
          return new Float32Array(c.length).fill(1);
        },
        textureChanged: (i) => rec.textureChanges.push(i),
        setVisible: () => {},
        setThemeStyle: () => {},
        triangleCount: () => entry.geometry.triangleCount,
        batchIdMap: () => [],
        resolveRaycast: () => null,
        delete: () => {},
      };
      return handle;
    },
  };
  return { factory, handles };
}

function fakeSource() {
  const pending: Array<{ url: string; onLoad: (t: Texture) => void }> = [];
  const source: TextureSource = {
    load: (url, onLoad) => {
      pending.push({ url, onLoad });
    },
  };
  return { source, pending };
}

function makeHandle(opts: { onCommitNeeded?: () => void } = {}) {
  const { client, fetches } = fakeClient();
  const { source, pending } = fakeSource();
  const textures = createLayerTextures({
    baseUrl: "https://host/data/rotterdam.fcb",
    source,
  });
  const meshes = recordingFactory(textures.cache);
  const handle = new FcbStreamLayerHandle({
    id: "l1",
    client,
    grid: GRID,
    header: HEADER,
    cache: new CellCache<CellEntry>({
      maxTriangles: RESIDENT_TRIANGLE_BUDGET,
      maxBytes: RESIDENT_BYTE_BUDGET,
    }),
    frame: FRAME,
    toSourceXY: TO_SOURCE_XY,
    toLngLat: TO_LNG_LAT,
    heightOffsetM: 0,
    meshFactory: meshes.factory,
    pickRays: null,
    onCommitNeeded: opts.onCommitNeeded,
    textures,
  });
  return { handle, fetches, pending, textures, meshes };
}

describe("planCommit appearance", () => {
  const footprint = viewportFootprint({
    cornerRays: rays(),
    frame: FRAME,
    toSourceXY: TO_SOURCE_XY,
  })!;
  const base: PlanCommitInput = {
    footprint,
    probeCount: 5,
    grid: GRID,
    cache: new CellCache<CellEntry>({ maxTriangles: 1e6, maxBytes: 1e9 }),
    prevLevel: null,
    prevCommit: null,
    prevLod: null,
    prevHiddenTypes: [],
    ladder: [],
    lodMode: "auto",
    selectedLod: null,
    hiddenTypes: [],
  };

  it("swaps when the theme changes, and not before the first commit", () => {
    const first = planCommit({ ...base, appearance: { kind: "texture", name: "rgb" } });
    expect(first.kind).toBe("commit");
    // No previous appearance: nothing to swap from (level change aside).
    const plan = planCommit({
      ...base,
      prevLevel: first.kind === "commit" ? first.level : null,
      prevAppearance: null,
      appearance: { kind: "texture", name: "rgb" },
    });
    expect(plan.kind === "commit" && plan.isSwap).toBe(true);
    const same = planCommit({
      ...base,
      prevLevel: first.kind === "commit" ? first.level : null,
      prevAppearance: { kind: "texture", name: "rgb" },
      appearance: { kind: "texture", name: "rgb" },
    });
    expect(same.kind === "commit" ? same.isSwap : "n/a").not.toBe(true);
  });
});

describe("FcbStreamLayerHandle appearance", () => {
  it("setAppearance forces a commit and the fetch carries the theme", async () => {
    const onCommitNeeded = vi.fn();
    const { handle, fetches } = makeHandle({ onCommitNeeded });
    handle.setAppearance({ kind: "texture", name: "rgb" });
    expect(onCommitNeeded).toHaveBeenCalledTimes(1);
    handle.setAppearance({ kind: "texture", name: "rgb" });
    expect(onCommitNeeded).toHaveBeenCalledTimes(1);
    await handle.commit(rays());
    expect(fetches[0]!.appearance).toEqual({ kind: "texture", name: "rgb" });
    handle.delete();
  });

  it("learns the themes cells report and the image definitions they use", async () => {
    const { handle, textures, pending } = makeHandle();
    const themes = vi.fn();
    handle.onAppearanceThemes(themes);
    handle.setAppearance({ kind: "texture", name: "rgb" });
    await handle.commit(rays());
    expect(themes).toHaveBeenCalledWith([{ kind: "texture", name: "rgb" }]);
    expect(handle.appearanceThemes).toEqual([{ kind: "texture", name: "rgb" }]);
    expect(textures.definitions.get(7)).toEqual(TEX);
    // The cell mesh requested the image through the shared cache.
    expect(textures.cache.get(7)?.status).toBe("loading");
    expect(pending[0]!.url).toBe("https://host/data/appearances/a.jpg");
    handle.delete();
  });

  it("repaints the cells drawing an image when it lands, masked under the highlight", async () => {
    const { handle, pending, meshes } = makeHandle();
    handle.setAppearance({ kind: "texture", name: "rgb" });
    await handle.commit(rays());
    expect(meshes.handles.length).toBeGreaterThan(0);
    const cell = meshes.handles[0]!;
    expect(cell.textureChanges).toEqual([]);
    pending[0]!.onLoad(new Texture());
    expect(cell.textureChanges).toEqual([7]);
    expect(cell.colors![0]).toBe(1); // white mask
    // A highlight still paints over the mask.
    handle.setHighlight([
      { kind: "object", layerId: "l1", objectId: "B1" },
    ]);
    expect(cell.colors![0]).not.toBe(1);
    handle.delete();
  });

  it("disposes the layer's image cache on delete", async () => {
    const { handle, textures, pending } = makeHandle();
    handle.setAppearance({ kind: "texture", name: "rgb" });
    await handle.commit(rays());
    handle.delete();
    const texture = new Texture();
    const dispose = vi.spyOn(texture, "dispose");
    pending[0]!.onLoad(texture);
    expect(dispose).toHaveBeenCalled();
    expect(textures.cache.get(7)).toBeUndefined();
  });
});
