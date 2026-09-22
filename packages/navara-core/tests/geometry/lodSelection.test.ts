import { describe, it, expect } from "vitest";
import { buildCityMeshArrays } from "../../src/geometry/buildCityMeshArrays";
import {
  sameLodGeometry,
  type LodSelection,
} from "../../src/geometry/lodSelection";
import type {
  CityModel,
  CityObject,
  Surface,
  Vec3,
} from "../../src/citymodel/types";

const ring: Vec3[] = [
  [0, 0, 0],
  [10, 0, 0],
  [0, 10, 0],
];

function surface(lod: string | null): Surface {
  return { type: "RoofSurface", rings: [ring], attributes: {}, lod };
}

function object(id: string, lods: ReadonlyArray<string | null>): CityObject {
  return {
    id,
    objectType: "Building",
    attributes: {},
    surfaces: lods.map(surface),
    bbox: null,
    children: [],
    parents: [],
    lod: null,
  };
}

function model(objects: Record<string, ReadonlyArray<string | null>>): CityModel {
  return {
    sourceEncoding: "cityjson",
    metadata: {},
    bbox: null,
    objects: Object.fromEntries(
      Object.entries(objects).map(([id, lods]) => [id, object(id, lods)]),
    ),
    vertexCount: 0,
  };
}

// The Nishitokyo shape: every object has LoD 0 and 1, a few also LoD 2.
const nishitokyo = model({
  detailed: ["0", "1", "2"],
  basic: ["0", "1"],
});

describe("sameLodGeometry", () => {
  it("is true when dropping a LoD that no object's winner uses", () => {
    expect(sameLodGeometry(nishitokyo, ["2", "1", "0"], ["2", "1"])).toBe(true);
  });

  it("is false when a dropped LoD was some object's winner", () => {
    const withLod0Only = model({ detailed: ["0", "1", "2"], flat: ["0"] });
    expect(sameLodGeometry(withLod0Only, ["2", "1", "0"], ["2", "1"])).toBe(
      false,
    );
  });

  it("is false when an added LoD becomes a fallback winner", () => {
    expect(sameLodGeometry(nishitokyo, ["2"], ["2", "1"])).toBe(false);
  });

  it("treats order and duplicates as the same selection", () => {
    expect(sameLodGeometry(nishitokyo, ["1", "2"], ["2", "1", "1"])).toBe(true);
  });

  it("tells an empty selection from one that draws something", () => {
    expect(sameLodGeometry(nishitokyo, [], ["1"])).toBe(false);
    expect(sameLodGeometry(nishitokyo, ["1"], [])).toBe(false);
    expect(sameLodGeometry(nishitokyo, [], [])).toBe(true);
  });

  it("is true for an empty selection and one no object has", () => {
    expect(sameLodGeometry(nishitokyo, [], ["3"])).toBe(true);
  });

  it("compares a legacy exact LoD with the one-element array", () => {
    expect(sameLodGeometry(nishitokyo, "1", ["1"])).toBe(true);
    expect(sameLodGeometry(nishitokyo, "1", "2")).toBe(false);
  });

  it("never equates the draw-everything null with a selection", () => {
    expect(sameLodGeometry(nishitokyo, null, ["2", "1", "0"])).toBe(false);
    expect(sameLodGeometry(nishitokyo, ["2", "1", "0"], null)).toBe(false);
    expect(sameLodGeometry(nishitokyo, null, null)).toBe(true);
  });

  it("treats null in a selection as the unlabelled rung, below every label", () => {
    // Codex milestone review (Important): a source whose geometry column
    // carries no LoD label (a bare `geometry` column) produced surfaces with
    // `lod: null`, which no array selection could ever name — so a streamed
    // legacy table reported loaded objects and drew nothing. `null` is now a
    // rung of its own, and the LOWEST one: an object draws it only when it
    // has no selected labelled surface.
    const legacy = model({ bare: [null], labelled: ["1", null] });
    expect(sameLodGeometry(legacy, [null], [])).toBe(false);
    // The unlabelled rung never outranks a labelled one that is also selected.
    expect(sameLodGeometry(legacy, ["1", null], ["1"])).toBe(false);
    expect(sameLodGeometry(legacy, [null], ["1", null])).toBe(false);
  });

  // Oracle: whenever the helper says "same", the real builder must emit
  // identical arrays — the promise a skipped rebuild relies on — and whenever
  // the builder's output differs, the helper must say "different".
  it("agrees with buildCityMeshArrays for every pair of selections", () => {
    const mixed = model({
      detailed: ["0", "1", "2", "2.2"],
      basic: ["0", "1"],
      flat: ["0"],
      unlabelled: [null, "1"],
      empty: [],
    });
    const selections: LodSelection[] = [
      null,
      "1",
      "2",
      "0",
      [],
      ["0"],
      ["1"],
      ["2"],
      ["2.2"],
      ["3"],
      ["1", "0"],
      ["2", "1"],
      ["2", "1", "0"],
      ["2.2", "2", "1", "0"],
      ["2.2", "1"],
      [null],
      ["1", null],
      ["2.2", "2", "1", "0", null],
    ];
    const signature = (lod: LodSelection) => {
      const arrays = buildCityMeshArrays(mixed, "t", [0, 0, 0], lod);
      return JSON.stringify([
        [...arrays.objectIndices],
        [...arrays.surfaceIndices],
      ]);
    };
    for (const a of selections) {
      for (const b of selections) {
        const same = signature(a) === signature(b);
        const claimed = sameLodGeometry(mixed, a, b);
        if (claimed) expect({ a, b, same }).toEqual({ a, b, same: true });
        if (!same) expect({ a, b, claimed }).toEqual({ a, b, claimed: false });
      }
    }
  });
});
