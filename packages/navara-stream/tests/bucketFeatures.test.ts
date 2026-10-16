import { describe, it, expect } from "vitest";
import { makeGrid } from "../src/tileGrid";
import { bucketFeatures } from "../src/bucketFeatures";
import type { CityModel } from "@cityjson/navara-core";

const grid = makeGrid([0, 0, 0, 1000, 1000, 30]); // rootCell 1600, level 2 -> 400 m

function model(id: string, cx: number, cy: number): CityModel {
  return {
    sourceEncoding: "flatcitybuf",
    metadata: {},
    bbox: [cx - 5, cy - 5, 0, cx + 5, cy + 5, 10],
    vertexCount: 8,
    objects: {
      [id]: {
        id,
        objectType: "Building",
        attributes: {},
        surfaces: [],
        bbox: [cx - 5, cy - 5, 0, cx + 5, cy + 5, 10],
        children: [],
        parents: [],
        lod: "2.2",
      },
    },
  };
}

describe("bucketFeatures", () => {
  it("routes each feature to the cell containing its bbox centre", () => {
    const out = bucketFeatures(
      [model("a", 100, 100), model("b", 500, 100)],
      grid,
      2,
      new Set(),
    );
    expect([...out.keys()].sort()).toEqual(["2/0/0", "2/1/0"]);
    expect(Object.keys(out.get("2/0/0")!.objects)).toEqual(["a"]);
    expect(Object.keys(out.get("2/1/0")!.objects)).toEqual(["b"]);
  });

  it("assigns a straddling feature to exactly one cell", () => {
    // Spans the 400 m boundary but its centre is at 395 -> cell 0 only.
    const out = bucketFeatures([model("s", 395, 100)], grid, 2, new Set());
    expect([...out.keys()]).toEqual(["2/0/0"]);
  });

  it("skips features owned by an already-resident cell", () => {
    const out = bucketFeatures(
      [model("a", 100, 100), model("b", 500, 100)],
      grid,
      2,
      new Set(["2/0/0"]),
    );
    expect([...out.keys()]).toEqual(["2/1/0"]);
  });

  it("merges multiple features landing in the same cell", () => {
    const out = bucketFeatures(
      [model("a", 100, 100), model("b", 150, 150)],
      grid,
      2,
      new Set(),
    );
    expect(Object.keys(out.get("2/0/0")!.objects).sort()).toEqual(["a", "b"]);
  });

  it("drops a feature whose bbox is non-finite instead of throwing or misfiling it", () => {
    const bad = model("bad", 100, 100);
    const badObj = bad.objects.bad!;
    const broken = {
      ...bad,
      objects: {
        bad: { ...badObj, bbox: [0, 0, 0, Infinity, 10, 10] as const },
      },
    };
    const out = bucketFeatures(
      [broken, model("ok", 500, 100)],
      grid,
      2,
      new Set(),
    );
    expect([...out.keys()]).toEqual(["2/1/0"]);
    for (const cell of out.values()) {
      expect(Object.keys(cell.objects)).not.toContain("bad");
    }
  });

  it("keeps the model's sourceEncoding instead of assuming FlatCityBuf", () => {
    const m: CityModel = {
      ...model("a", 100, 100),
      sourceEncoding: "cityparquet",
    };
    const out = bucketFeatures([m], grid, 2, new Set());
    expect(out.get("2/0/0")!.sourceEncoding).toBe("cityparquet");
  });
});

/** A family: a parent centred at (px, 100) and one part centred at
 *  (cx, 100), with the model's bbox the union of both. */
function family(px: number, cx: number): CityModel {
  const parent = model("p", px, 100).objects.p!;
  const part = {
    ...model("c", cx, 100).objects.c!,
    objectType: "BuildingPart",
  };
  return {
    sourceEncoding: "cityparquet",
    metadata: {},
    bbox: [
      Math.min(px, cx) - 5,
      95,
      0,
      Math.max(px, cx) + 5,
      105,
      10,
    ],
    vertexCount: 16,
    objects: {
      p: { ...parent, children: ["c"] },
      c: { ...part, parents: ["p"] },
    },
  };
}

describe("bucketFeatures ownership", () => {
  // Parent at x 100 and part at x 480: the model's bbox is x 95..485, centre
  // x 290 -> cell 2/0/0, while the part's own centre is in 2/1/0.
  const straddling = family(100, 480);

  it("'object' (the default) files each object by its own centre", () => {
    const out = bucketFeatures([straddling], grid, 2, new Set());
    expect(Object.keys(out.get("2/0/0")!.objects)).toEqual(["p"]);
    expect(Object.keys(out.get("2/1/0")!.objects)).toEqual(["c"]);
  });

  it("'feature' files every object of a model by the model's bbox centre", () => {
    const out = bucketFeatures([straddling], grid, 2, new Set(), "feature");
    expect([...out.keys()]).toEqual(["2/0/0"]);
    expect(Object.keys(out.get("2/0/0")!.objects).sort()).toEqual(["c", "p"]);
  });

  it("'feature' files a geometry-less parent with its parts", () => {
    const withBareParent: CityModel = {
      ...straddling,
      objects: {
        ...straddling.objects,
        p: { ...straddling.objects.p!, bbox: null, surfaces: [] },
      },
    };
    const out = bucketFeatures(
      [withBareParent],
      grid,
      2,
      new Set(),
      "feature",
    );
    expect([...out.keys()]).toEqual(["2/0/0"]);
    expect(Object.keys(out.get("2/0/0")!.objects).sort()).toEqual(["c", "p"]);
  });

  it("'feature' skips a model whose family has no bbox", () => {
    const out = bucketFeatures(
      [{ ...straddling, bbox: null }, model("ok", 500, 100)],
      grid,
      2,
      new Set(),
      "feature",
    );
    expect([...out.keys()]).toEqual(["2/1/0"]);
  });

  it("'feature' skips a model owned by an already-resident cell", () => {
    const out = bucketFeatures(
      [straddling],
      grid,
      2,
      new Set(["2/0/0"]),
      "feature",
    );
    expect(out.size).toBe(0);
  });
});
