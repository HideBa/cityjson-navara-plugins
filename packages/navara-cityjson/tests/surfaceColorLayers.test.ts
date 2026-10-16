import { describe, expect, it } from "vitest";
import type { CityObject } from "@cityjson/navara-core";
import {
  computeStyleColors,
  paintSlotFlags,
  type SlotFlagWriter,
} from "../src/surfaceColorLayers";
import { SLOT_HOVERED, SLOT_SELECTED, SLOT_TEXTURED } from "../src/slotFlags";

/** Two slots: object 0 surface 0, object 1 surface 1. */
const slotObjects = new Uint32Array([0, 1]);
const slotSurfaces = new Uint32Array([0, 1]);
const objectKeys = ["B1", "B2"];
// 0.25 / 0.5 are exactly representable in a Float32Array, so the toEqual
// assertions below are safe (0.1 and 0.2 are not — they round on storage).
const base = new Float32Array([0.25, 0.25, 0.25, 0.5, 0.5, 0.5]);

function obj(id: string, type: "RoofSurface" | "WallSurface"): CityObject {
  return {
    id,
    objectType: "Building",
    attributes: {},
    surfaces: [
      { type, rings: [], attributes: {}, lod: "2" },
      { type, rings: [], attributes: {}, lod: "2" },
    ],
    bbox: null,
    children: [],
    parents: [],
    lod: "2",
  };
}

const lookup = (id: string) =>
  id === "B1" ? obj("B1", "RoofSurface") : obj("B2", "WallSurface");

describe("computeStyleColors", () => {
  it("writes the evaluator color only where it returns non-null", () => {
    const out = computeStyleColors(
      // The evaluator returns a linear-sRGB triple (see Shared Interface
      // Contract) — the buffer takes it verbatim, with no hex round trip.
      (surface) =>
        surface.surface.type === "RoofSurface" ? [1, 0, 0.5] : null,
      slotObjects,
      slotSurfaces,
      objectKeys,
      lookup,
      base,
    );
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([1, 0, 0.5, 0.5, 0.5, 0.5]);
  });

  it("returns null when the evaluator never matches", () => {
    const out = computeStyleColors(
      () => null,
      slotObjects,
      slotSurfaces,
      objectKeys,
      lookup,
      base,
    );
    expect(out).toBeNull();
  });

  it("calls the evaluator once per slot", () => {
    const seen: string[] = [];
    computeStyleColors(
      (surface, object) => {
        seen.push(`${object.objectId}:${surface.surfaceIndex}`);
        return [1, 1, 1];
      },
      slotObjects,
      slotSurfaces,
      objectKeys,
      lookup,
      base,
    );
    expect(seen).toEqual(["B1:0", "B2:1"]);
  });

  it("hands the evaluator the attributes the object inherits from its parents", () => {
    const building: CityObject = {
      ...obj("B", "RoofSurface"),
      attributes: { b3_dak_type: "slanted" },
    };
    const part: CityObject = { ...obj("B-0", "RoofSurface"), parents: ["B"] };
    const seen: unknown[] = [];
    computeStyleColors(
      (_surface, object) => {
        seen.push(object.attributes);
        return null;
      },
      new Uint32Array([0]),
      new Uint32Array([0]),
      ["B-0"],
      (id) => (id === "B" ? building : id === "B-0" ? part : undefined),
      new Float32Array(3),
    );
    expect(seen).toEqual([{ b3_dak_type: "slanted" }]);
  });
});

/** A flag store over `n` slots, starting from `initial`. */
function flags(n: number, initial = 0): SlotFlagWriter & { all: number[] } {
  const all = new Array<number>(n).fill(initial);
  return {
    all,
    flags: (slot) => all[slot]!,
    setFlags: (slot, f) => {
      all[slot] = f;
    },
  };
}

describe("paintSlotFlags", () => {
  it("flags the selected object and the hovered one", () => {
    const t = flags(2);
    paintSlotFlags(
      t,
      slotObjects,
      slotSurfaces,
      objectKeys,
      [{ kind: "object", layerId: "L", objectId: "B1" }],
      { kind: "object", layerId: "L", objectId: "B2" },
    );
    expect(t.all).toEqual([SLOT_SELECTED, SLOT_HOVERED]);
  });

  it("sets both bits where selection and hover meet; the shader draws selection", () => {
    const t = flags(2);
    paintSlotFlags(
      t,
      slotObjects,
      slotSurfaces,
      objectKeys,
      [{ kind: "object", layerId: "L", objectId: "B1" }],
      { kind: "object", layerId: "L", objectId: "B1" },
    );
    expect(t.all).toEqual([SLOT_SELECTED | SLOT_HOVERED, 0]);
  });

  it("clears the previous highlight and keeps every other flag", () => {
    const t = flags(2, SLOT_TEXTURED | SLOT_SELECTED | SLOT_HOVERED);
    paintSlotFlags(t, slotObjects, slotSurfaces, objectKeys, [], null);
    expect(t.all).toEqual([SLOT_TEXTURED, SLOT_TEXTURED]);
  });

  it("honours surface-level selection granularity", () => {
    const t = flags(2);
    paintSlotFlags(
      t,
      slotObjects,
      slotSurfaces,
      objectKeys,
      [{ kind: "surface", layerId: "L", objectId: "B2", surfaceIndex: 9 }],
      null,
    );
    expect(t.all).toEqual([0, 0]);
  });

  // One object ("B1"), two surfaces, one slot each.
  const oneObject = new Uint32Array([0, 0]);
  const twoSurfaces = new Uint32Array([0, 1]);

  it("flags every selected surface of the SAME object, not just the last", () => {
    // Regression for the B16 smoke finding: keying the resolved selections
    // by object index alone made the second surface selection evict the
    // first, so only the last-painted face highlighted.
    const t = flags(2);
    paintSlotFlags(
      t,
      oneObject,
      twoSurfaces,
      ["B1"],
      [
        { kind: "surface", layerId: "L", objectId: "B1", surfaceIndex: 0 },
        { kind: "surface", layerId: "L", objectId: "B1", surfaceIndex: 1 },
      ],
      null,
    );
    expect(t.all).toEqual([SLOT_SELECTED, SLOT_SELECTED]);
  });

  it("keeps an object-kind selection covering all surfaces of the object", () => {
    const t = flags(2);
    paintSlotFlags(
      t,
      oneObject,
      twoSurfaces,
      ["B1"],
      [{ kind: "object", layerId: "L", objectId: "B1" }],
      null,
    );
    expect(t.all).toEqual([SLOT_SELECTED, SLOT_SELECTED]);
  });

  it("leaves an unselected surface of a partially selected object unflagged", () => {
    const t = flags(2);
    paintSlotFlags(
      t,
      oneObject,
      twoSurfaces,
      ["B1"],
      [{ kind: "surface", layerId: "L", objectId: "B1", surfaceIndex: 1 }],
      null,
    );
    expect(t.all).toEqual([0, SLOT_SELECTED]);
  });

  it("flags a hovered surface when nothing is selected", () => {
    const t = flags(2);
    paintSlotFlags(t, slotObjects, slotSurfaces, objectKeys, [], {
      kind: "surface",
      layerId: "L",
      objectId: "B2",
      surfaceIndex: 1,
    });
    expect(t.all).toEqual([0, SLOT_HOVERED]);
  });
});
