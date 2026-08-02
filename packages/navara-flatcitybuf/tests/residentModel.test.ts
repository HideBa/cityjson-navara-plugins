import { describe, it, expect, vi } from "vitest";
import { CellCache } from "../src/cellCache";
import type { CellEntry } from "../src/streamLayer";
import {
  buildResidentModel,
  createResidentModelMemo,
} from "../src/residentModel";

function entry(ids: string[], surfaceAttrKeys = ["slope"]): CellEntry {
  return {
    objects: ids.map((id) => ({
      id,
      objectType: "Building",
      attributes: {},
      bbox: [0, 0, 0, 1, 1, 1] as [
        number,
        number,
        number,
        number,
        number,
        number,
      ],
      lod: "2.2",
      surfaceCount: 2,
      roofMetrics: [],
      footprintAreaSqM: 10,
      volumeCuM: 30,
      parents: [],
      children: [],
    })),
    surfaceAttrKeys,
  } as unknown as CellEntry;
}

function cacheWith(
  ...cells: ReadonlyArray<readonly [string, CellEntry]>
): CellCache<CellEntry> {
  const cache = new CellCache<CellEntry>({
    maxTriangles: Infinity,
    maxBytes: Infinity,
  });
  for (const [key, value] of cells)
    cache.set(key, value, { triangles: 1, bytes: 1 });
  return cache;
}

function populated(): CellCache<CellEntry> {
  return cacheWith(
    ["2/0/0", entry(["a", "b"])],
    ["2/1/0", entry(["c"])],
  );
}

describe("buildResidentModel", () => {
  it("merges objects across resident cells", () => {
    const m = buildResidentModel(populated());
    expect(Object.keys(m.objects).sort()).toEqual(["a", "b", "c"]);
    expect(m.cellCount).toBe(2);
    expect(m.featureCount).toBe(3);
  });

  it("unions surface attribute keys, sorted", () => {
    const cache = cacheWith(
      ["2/0/0", entry(["a"], ["slope", "azimuth"])],
      ["2/1/0", entry(["b"], ["slope", "area"])],
    );
    expect(buildResidentModel(cache).surfaceAttrKeys).toEqual([
      "area",
      "azimuth",
      "slope",
    ]);
  });

  it("returns an empty model for an empty cache", () => {
    const cache = new CellCache<CellEntry>({
      maxTriangles: Infinity,
      maxBytes: Infinity,
    });
    expect(buildResidentModel(cache)).toEqual({
      objects: {},
      cellCount: 0,
      featureCount: 0,
      surfaceAttrKeys: [],
    });
  });

  it("skips a cell evicted between keys() and get() rather than fabricating one", () => {
    const cache = populated();
    const realGet = cache.get.bind(cache);
    vi.spyOn(cache, "get").mockImplementation((key) =>
      key === "2/1/0" ? undefined : realGet(key),
    );
    const m = buildResidentModel(cache);
    expect(Object.keys(m.objects).sort()).toEqual(["a", "b"]);
    expect(m.cellCount).toBe(1);
    expect(m.featureCount).toBe(2);
  });

  it("lets a later cell win for a duplicated object id", () => {
    const later = entry(["a"]);
    const cache = cacheWith(["2/0/0", entry(["a"])], ["2/1/0", later]);
    expect(buildResidentModel(cache).objects.a).toBe(later.objects[0]);
    expect(buildResidentModel(cache).featureCount).toBe(1);
  });
});

describe("createResidentModelMemo", () => {
  it("returns the identical object (reference equality) for a repeated call at the same version", () => {
    const memo = createResidentModelMemo();
    const cache = cacheWith(["1/0/0", entry(["a"])]);
    expect(memo(cache, 3)).toBe(memo(cache, 3));
    expect(memo(cache, 4)).not.toBe(memo(cache, 3));
  });

  it("recomputes only when a caller asks at a new version, never eagerly", () => {
    const memo = createResidentModelMemo();
    const cache = populated();
    const keysSpy = vi.spyOn(cache, "keys");

    const first = memo(cache, 1);
    expect(keysSpy).toHaveBeenCalledTimes(1);

    // Cells commit into the cache while nobody asks for a model. A memo is a
    // plain function: nothing recomputes until a caller actually calls it.
    cache.set("2/2/0", entry(["d"]), { triangles: 1, bytes: 1 });
    expect(keysSpy).toHaveBeenCalledTimes(1);

    // Asking again at the STALE version still hits the memo — no new read,
    // same object, so the caller can use it as a hook dependency.
    expect(memo(cache, 1)).toBe(first);
    expect(keysSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(first.objects).sort()).toEqual(["a", "b", "c"]);

    // Only the new version triggers exactly one more merge.
    const second = memo(cache, 2);
    expect(keysSpy).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(Object.keys(second.objects).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps one entry only: going back to an older version recomputes", () => {
    const memo = createResidentModelMemo();
    const cache = populated();
    const atOne = memo(cache, 1);
    memo(cache, 2);
    expect(memo(cache, 1)).not.toBe(atOne);
  });

  it("gives each memo its own independent cache binding", () => {
    const memoA = createResidentModelMemo();
    const memoB = createResidentModelMemo();
    const cacheA = populated();
    const cacheB = cacheWith(["2/0/0", entry(["z"])]);

    const mA = memoA(cacheA, 1);
    const mB = memoB(cacheB, 1);
    expect(Object.keys(mA.objects).sort()).toEqual(["a", "b", "c"]);
    expect(Object.keys(mB.objects)).toEqual(["z"]);
    // Computing B in between must not disturb A's single entry.
    expect(memoA(cacheA, 1)).toBe(mA);
  });

  it("recomputes for a different cache at the same version", () => {
    const memo = createResidentModelMemo();
    const cacheA = populated();
    const cacheB = cacheWith(["2/0/0", entry(["z"])]);
    const mA = memo(cacheA, 1);
    const mB = memo(cacheB, 1);
    expect(mB).not.toBe(mA);
    expect(Object.keys(mB.objects)).toEqual(["z"]);
  });
});
