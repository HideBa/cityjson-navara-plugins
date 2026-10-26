/**
 * The worker's feature store: which held reads answer which LoD, the view a
 * held read gives of one LoD, and the byte budget.
 */
import { describe, expect, it } from "vitest";
import type { CityModel, CityObject, Surface } from "@cityjson/navara-core";
import {
  BYTES_PER_ENTRY,
  FeatureStore,
  ceilingCovers,
  lodView,
  modelBytes,
} from "../src/featureStore";

function surface(lod: string | null): Surface {
  return {
    type: "RoofSurface",
    rings: [
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
    ],
    attributes: {},
    lod,
  };
}

function model(lods: (string | null)[]): CityModel {
  const obj: CityObject = {
    id: "a",
    objectType: "Building",
    attributes: {},
    surfaces: lods.map(surface),
    bbox: [0, 0, 0, 1, 1, 0],
    children: [],
    parents: [],
    lod: null,
  };
  return {
    sourceEncoding: "cityparquet",
    metadata: {},
    bbox: obj.bbox,
    objects: { a: obj },
    vertexCount: 0,
  };
}

describe("ceilingCovers", () => {
  it("lets a read of every LoD answer any request", () => {
    expect(ceilingCovers(null, null)).toBe(true);
    expect(ceilingCovers(null, "2")).toBe(true);
  });

  it("lets a numeric ceiling answer the LoDs at or below it", () => {
    expect(ceilingCovers("2", "1")).toBe(true);
    expect(ceilingCovers("2", "2")).toBe(true);
    expect(ceilingCovers("2", "3")).toBe(false);
    expect(ceilingCovers("2", null)).toBe(false);
  });

  it("matches a label that is not a number only by itself", () => {
    expect(ceilingCovers("high", "high")).toBe(true);
    expect(ceilingCovers("high", "1")).toBe(false);
    expect(ceilingCovers("2", "low")).toBe(false);
  });
});

describe("lodView", () => {
  it("keeps the surfaces a read at that ceiling would have returned", () => {
    const view = lodView(model(["0", "1", "2", "3", null]), "1");
    expect(view.objects.a!.surfaces.map((s) => s.lod)).toEqual([
      "0",
      "1",
      null,
    ]);
  });

  it("gives an object the LoD a read at the ceiling would report", () => {
    const held = model(["0", "1", "2"]);
    const withLod: CityModel = {
      ...held,
      objects: { a: { ...held.objects.a!, lod: "2" } },
    };
    expect(lodView(withLod, "1").objects.a!.lod).toBe("1");
    expect(lodView(withLod, "2").objects.a!.lod).toBe("2");
  });

  it("lowers an object's LoD above the ceiling though every surface is kept", () => {
    // A LoD 2 point or line geometry raises the object's LoD but carries no
    // surface.
    const held = model(["1"]);
    const withLod: CityModel = {
      ...held,
      objects: { a: { ...held.objects.a!, lod: "2" } },
    };
    expect(lodView(withLod, "1").objects.a!.lod).toBe("1");
  });

  it("is the model itself when nothing is filtered", () => {
    const held = model(["0", "1"]);
    expect(lodView(held, null)).toBe(held);
    expect(lodView(held, "3")).toBe(held);
  });

  it("leaves the held model untouched", () => {
    const held = model(["1", "2"]);
    lodView(held, "1");
    expect(held.objects.a!.surfaces).toHaveLength(2);
  });
});

describe("FeatureStore", () => {
  it("answers a held cell only for a LoD its ceiling covers", () => {
    const store = new FeatureStore(1e9);
    const held = [model(["1", "2"])];
    store.set("2/0/0", held, "2");
    expect(store.get("2/0/0", "1")).toBe(held);
    expect(store.get("2/0/0", "2")).toBe(held);
    expect(store.get("2/0/0", "3")).toBeUndefined();
    expect(store.get("2/1/0", "1")).toBeUndefined();
  });

  it("replaces a cell's read with a later one", () => {
    const store = new FeatureStore(1e9);
    store.set("2/0/0", [model(["1"])], "1");
    const wider = [model(["1", "2", "3"])];
    store.set("2/0/0", wider, null);
    expect(store.get("2/0/0", "3")).toBe(wider);
    expect(store.bytes).toBe(BYTES_PER_ENTRY + modelBytes(wider));
  });

  it("drops the least recently used cells over budget, never a kept one", () => {
    const one = BYTES_PER_ENTRY + modelBytes([model(["1"])]);
    const store = new FeatureStore(one * 2);
    store.set("a", [model(["1"])], "1");
    store.set("b", [model(["1"])], "1");
    store.set("c", [model(["1"])], "1");
    store.get("a", "1"); // a is now the most recent
    store.trim(new Set(["c"]));
    expect(store.get("b", "1")).toBeUndefined();
    expect(store.get("a", "1")).toBeDefined();
    expect(store.get("c", "1")).toBeDefined();
    expect(store.bytes).toBe(one * 2);
  });

  it("forgets everything on clear", () => {
    const store = new FeatureStore(1e9);
    store.set("a", [model(["1"])], "1");
    store.clear();
    expect(store.get("a", "1")).toBeUndefined();
    expect(store.bytes).toBe(0);
  });
});

describe("FeatureStore exact entries", () => {
  it("answers only the same LoD for a source that states no ceiling", () => {
    const store = new FeatureStore(1e9);
    const held = [model(["1", "2"])];
    store.set("a", held, "2", true);
    expect(store.get("a", "2")).toBe(held);
    expect(store.get("a", "1")).toBeUndefined();
    store.set("b", held, null, true);
    expect(store.get("b", null)).toBe(held);
    expect(store.get("b", "1")).toBeUndefined();
  });
});
