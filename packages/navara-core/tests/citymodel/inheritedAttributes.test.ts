import { describe, expect, it } from "vitest";
import { inheritedAttributes } from "../../src/citymodel/inheritedAttributes";
import type { CityObject } from "../../src/citymodel/types";

function object(
  id: string,
  attributes: Record<string, unknown>,
  parents: string[] = [],
): CityObject {
  return {
    id,
    objectType: parents.length ? "BuildingPart" : "Building",
    attributes,
    surfaces: [],
    bbox: null,
    children: [],
    parents,
    lod: "2",
  };
}

function lookupOf(...objects: CityObject[]) {
  const byId = new Map(objects.map((o) => [o.id, o]));
  return (id: string) => byId.get(id);
}

describe("inheritedAttributes", () => {
  it("returns an object's own attributes when it has no parent", () => {
    const b = object("b", { a: 1 });
    expect(inheritedAttributes(b, lookupOf(b))).toEqual({ a: 1 });
  });

  it("gives a BuildingPart its Building's attributes", () => {
    // The 3DBAG shape: b3_* attributes sit on the Building, the roofs on the part.
    const building = object("b", { b3_dak_type: "slanted", b3_h_dak_max: 12 });
    const part = object("b-0", { own: true }, ["b"]);
    expect(inheritedAttributes(part, lookupOf(building, part))).toEqual({
      b3_dak_type: "slanted",
      b3_h_dak_max: 12,
      own: true,
    });
  });

  it("lets the nearer object win a name both carry", () => {
    const building = object("b", { height: 10, roofType: "flat" });
    const part = object("b-0", { height: 4 }, ["b"]);
    const sub = object("b-0-0", {}, ["b-0"]);
    expect(inheritedAttributes(sub, lookupOf(building, part, sub))).toEqual({
      height: 4,
      roofType: "flat",
    });
  });

  it("lets the first listed parent win between two parents", () => {
    const p1 = object("p1", { k: "first" });
    const p2 = object("p2", { k: "second", only2: 2 });
    const child = object("c", {}, ["p1", "p2"]);
    expect(inheritedAttributes(child, lookupOf(p1, p2, child))).toEqual({
      k: "first",
      only2: 2,
    });
  });

  it("ignores a parent the model does not hold", () => {
    const part = object("b-0", { own: 1 }, ["missing"]);
    expect(inheritedAttributes(part, lookupOf(part))).toEqual({ own: 1 });
  });

  it("terminates on a parent cycle", () => {
    const a = object("a", { a: 1 }, ["b"]);
    const b = object("b", { b: 2 }, ["a"]);
    expect(inheritedAttributes(a, lookupOf(a, b))).toEqual({ a: 1, b: 2 });
  });

  it("returns the object's own record when nothing is inherited", () => {
    const b = object("b", { a: 1 });
    expect(inheritedAttributes(b, lookupOf(b))).toBe(b.attributes);
  });
});
