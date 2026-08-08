/**
 * Row decode, exercised against the real fixture package and against synthetic
 * tables for the branches no fixture reaches.
 *
 * The fixture test is the contract that matters: three rows in, three
 * `CityObject`s out, with the hierarchy, the per-LoD semantic surfaces and the
 * absolute EPSG:7415 ring coordinates a mesh builder needs. The synthetic
 * tables cover attribute conversion, the `+extension` attribute spelling, the
 * non-surface geometry kinds, and the error/skip paths.
 *
 * Adapted from the task brief for `noUncheckedIndexedAccess`: every
 * `objects[id]` lookup is `CityObject | undefined` under that flag, so the
 * brief's chained member accesses go through the local `at()` helper instead.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { CityObject, Vec3 } from "@cityjson/navara-core";
import type { CityFooter } from "../src/footer";
import { CityParquetError } from "../src/footer";
import type {
  CityParquetTableData,
  GeometryColumnRef,
} from "../src/tableReader";
import { readCityParquetTable } from "../src/tableReader";
import {
  cityJsonTypeForObjectType,
  decodeTableObjects,
} from "../src/decodeTable";

const FIXTURE = fileURLToPath(
  new URL(
    "./fixtures/two-buildings-cityparquet/building.parquet",
    import.meta.url,
  ),
);

/** `objects[id]`, asserted present — `noUncheckedIndexedAccess` widens it. */
function at(
  objects: Record<string, CityObject>,
  id: string | undefined,
): CityObject {
  const found = id === undefined ? undefined : objects[id];
  expect(found).toBeDefined();
  return found as CityObject;
}

// ---------------------------------------------------------------------------
// Synthetic table + WKB builders
// ---------------------------------------------------------------------------

function footerOf(attributes: string[] = []): CityFooter {
  return {
    version: "1.0.0",
    epsg: 7415,
    primaryColumn: null,
    geometryColumns: [],
    attributes,
    sourceFormat: null,
  };
}

function tableOf(
  rows: Record<string, unknown>[],
  options: {
    attributes?: string[];
    geometryColumns?: GeometryColumnRef[];
  } = {},
): CityParquetTableData {
  return {
    footer: footerOf(options.attributes ?? []),
    rows,
    geometryColumns: options.geometryColumns ?? [],
  };
}

const LOD2_COLUMN: GeometryColumnRef = {
  name: "geometry_lod2_2",
  lod: "2.2",
  propsName: "geometry_properties_lod2_2",
};

/** A little-endian WKB writer, just enough to build test blobs. */
class WkbWriter {
  private readonly bytes: number[] = [];

  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }

  u32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    for (const x of b) this.bytes.push(x);
  }

  f64(v: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    for (const x of b) this.bytes.push(x);
  }

  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** MultiPolygonZ (type 1006) of `faces`; every ring is closed on write. */
function wkbMultiPolygonZ(
  faces: ReadonlyArray<ReadonlyArray<Vec3[]>>,
): Uint8Array {
  const w = new WkbWriter();
  w.u8(1);
  w.u32(1006);
  w.u32(faces.length);
  for (const face of faces) {
    w.u8(1);
    w.u32(1003);
    w.u32(face.length);
    for (const ring of face) {
      w.u32(ring.length + 1);
      for (const p of [...ring, ring[0] as Vec3]) {
        w.f64(p[0]);
        w.f64(p[1]);
        w.f64(p[2]);
      }
    }
  }
  return w.done();
}

/** PointZ (type 1001) — a geometry kind that yields no surfaces. */
function wkbPointZ(p: Vec3): Uint8Array {
  const w = new WkbWriter();
  w.u8(1);
  w.u32(1001);
  w.f64(p[0]);
  w.f64(p[1]);
  w.f64(p[2]);
  return w.done();
}

const TRIANGLE: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
];

const SQUARE: Vec3[] = [
  [0, 0, 5],
  [2, 0, 5],
  [2, 2, 5],
  [0, 2, 5],
];

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe("decodeTableObjects (fixture)", () => {
  // Fixture ground truth (tests/fixtures/two-buildings.city.json): Pand.0001
  // is a Building WITH its own Solid lod2.2 geometry and one child part;
  // Pand.0001-part1 is a BuildingPart (MultiSurface lod2.2); Pand.0002 is a
  // Building (Solid lod2.2, no children). All three also carry the
  // writer-synthesized lod0.0 footprint.
  it("reconstructs objects, hierarchy, semantics and LoDs", async () => {
    const objects = decodeTableObjects(
      await readCityParquetTable(await readFile(FIXTURE)),
    );
    const ids = Object.keys(objects);
    expect(ids.length).toBe(3);
    const part = ids
      .map((id) => at(objects, id))
      .find((o) => o.objectType === "BuildingPart");
    expect(part).toBeDefined();
    expect(part?.parents.length).toBe(1);
    const parent = at(objects, part?.parents[0]);
    expect(parent.children).toContain(part?.id);
    for (const o of ids.map((id) => at(objects, id))) {
      // All three rows carry geometry in this fixture.
      expect(o.surfaces.length).toBeGreaterThan(0);
      const lods = new Set(o.surfaces.map((s) => s.lod));
      expect(lods.has("2.2")).toBe(true);
      expect(lods.has("0")).toBe(true); // writer-synthesized LoD0 footprint
      for (const s of o.surfaces)
        for (const ring of s.rings) {
          expect(ring.length).toBeGreaterThanOrEqual(3);
          for (const [x, y, z] of ring) {
            expect(Number.isFinite(x + y + z)).toBe(true);
          }
        }
      expect(o.bbox).not.toBeNull();
      // The object's own LoD is the highest of its geometry columns.
      expect(o.lod).toBe("2.2");
    }
    const solidBearer = ids
      .map((id) => at(objects, id))
      .find((o) => o.objectType === "Building");
    expect(solidBearer).toBeDefined();
    const types = new Set(
      (solidBearer?.surfaces ?? [])
        .filter((s) => s.lod === "2.2")
        .map((s) => s.type),
    );
    expect(types.has("RoofSurface")).toBe(true);
    expect(types.has("WallSurface")).toBe(true);
    expect(types.has("GroundSurface")).toBe(true);
    expect(Object.keys(solidBearer?.attributes ?? {}).length).toBeGreaterThan(
      0,
    );
  });

  it("carries the semantic surface's extra attributes and the source bbox", async () => {
    const objects = decodeTableObjects(
      await readCityParquetTable(await readFile(FIXTURE)),
    );
    const first = at(objects, "NL.IMBAG.Pand.0001");
    // The fixture's second RoofSurface carries `slope: 35.0`, which must reach
    // the Surface as an attribute (a rule can then colour by it).
    const sloped = first.surfaces.filter(
      (s) => s.lod === "2.2" && s.attributes.slope === 35,
    );
    expect(sloped.length).toBe(1);
    expect(sloped[0]?.type).toBe("RoofSurface");
    // `type` itself is never duplicated into the attributes.
    for (const s of first.surfaces) expect("type" in s.attributes).toBe(false);
    // The bbox comes from the row's own struct, verbatim.
    expect(first.bbox).toEqual([85000, 446000, 0, 85010, 446008, 8.4]);
    // Attributes: a DOUBLE stays a number, an INT64 becomes a JS number.
    expect(first.attributes.measuredHeight).toBe(8.4);
    expect(first.attributes.roofType).toBe("gabled");
    expect(typeof first.attributes.yearOfConstruction).toBe("number");
    // A null cell contributes no key at all.
    const part = at(objects, "NL.IMBAG.Pand.0001-part1");
    expect("roofType" in part.attributes).toBe(false);
  });

  it("emits one surface per WKB face, with unlabelled LoD0 faces unknown", async () => {
    const objects = decodeTableObjects(
      await readCityParquetTable(await readFile(FIXTURE)),
    );
    const first = at(objects, "NL.IMBAG.Pand.0001");
    // The lod2.2 Solid has 7 faces (one roof plane is split into a triangle).
    expect(first.surfaces.filter((s) => s.lod === "2.2").length).toBe(7);
    // The synthesized LoD0 footprint carries no `surfaces`, so every one of its
    // faces is unknown with no attributes.
    const lod0 = first.surfaces.filter((s) => s.lod === "0");
    expect(lod0.length).toBeGreaterThan(0);
    for (const s of lod0) {
      expect(s.type).toBe("unknown");
      expect(s.attributes).toEqual({});
    }
  });

  it("keeps a geometry-less row as an object with empty surfaces (synthetic)", async () => {
    const real = await readCityParquetTable(await readFile(FIXTURE));
    const table: CityParquetTableData = {
      ...real,
      rows: [
        {
          id: "ghost",
          feature_id: "ghost",
          object_type: "Building",
          parents: undefined,
          children: undefined,
          bbox: null,
        },
      ],
    };
    const objects = decodeTableObjects(table);
    const ghost = at(objects, "ghost");
    expect(ghost.surfaces).toEqual([]);
    // undefined (an absent column) → [], so the test is nullish not `=== null`.
    expect(ghost.parents).toEqual([]);
    expect(ghost.children).toEqual([]);
    expect(ghost.bbox).toBeNull();
    expect(ghost.lod).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Synthetic rows
// ---------------------------------------------------------------------------

describe("decodeTableObjects (synthetic rows)", () => {
  it("restores the '+' spelling of extension attributes and merges other_attributes", () => {
    const objects = decodeTableObjects(
      tableOf(
        [
          {
            id: "a",
            object_type: "Building",
            ex_height: 12.5,
            plain: "kept",
            absent: null,
            other_attributes: '{"diverted":1,"bbox":"a string"}',
          },
        ],
        { attributes: ["ex_height", "plain", "absent"] },
      ),
    );
    expect(at(objects, "a").attributes).toEqual({
      "+height": 12.5,
      plain: "kept",
      diverted: 1,
      bbox: "a string",
    });
  });

  it("converts the cell shapes hyparquet can hand back", () => {
    const objects = decodeTableObjects(
      tableOf(
        [
          {
            id: "a",
            object_type: "Building",
            big: 2024n,
            when: new Date("2020-01-02T03:04:05.678Z"),
            blob: new TextEncoder().encode("bytes"),
            list: ["x", "y"],
            bigList: [1n, 2n],
            struct: { nested: true },
          },
        ],
        {
          attributes: ["big", "when", "blob", "list", "bigList", "struct"],
        },
      ),
    );
    expect(at(objects, "a").attributes).toEqual({
      big: 2024,
      when: "2020-01-02T03:04:05.678Z",
      blob: "bytes",
      list: ["x", "y"],
      bigList: [1, 2],
      struct: { nested: true },
    });
  });

  /**
   * The conversion above is lossy exactly once: past 2^53 a double can no
   * longer name every integer, so `Number(2n ** 63n - 1n)` is
   * 9223372036854775808 — a value that was never in the file, differing from
   * the stored one with no warning. INT64 columns at that magnitude are
   * identifiers (BAG keys, snowflake ids), and an identifier that is silently
   * off by one is worse than an identifier of the wrong TYPE: a string still
   * displays, filters and shares correctly, and equality against another copy
   * of the same id still holds.
   */
  it("keeps an out-of-range INT64 as a string rather than rounding it", () => {
    const objects = decodeTableObjects(
      tableOf(
        [
          {
            id: "a",
            object_type: "Building",
            huge: 2n ** 63n - 1n,
            veryNegative: -(2n ** 63n),
            // Still exactly representable: these stay numbers, so the escape
            // hatch cannot creep over ordinary counts and years.
            safe: BigInt(Number.MAX_SAFE_INTEGER),
            hugeList: [2n ** 53n + 1n, 7n],
          },
        ],
        { attributes: ["huge", "veryNegative", "safe", "hugeList"] },
      ),
    );
    expect(at(objects, "a").attributes).toEqual({
      huge: "9223372036854775807",
      veryNegative: "-9223372036854775808",
      safe: Number.MAX_SAFE_INTEGER,
      hugeList: ["9007199254740993", 7],
    });
  });

  it("reverse-maps the object type and normalises parents/children", () => {
    const objects = decodeTableObjects(
      tableOf([
        {
          id: "s",
          object_type: "Storey",
          parents: ["b"],
          children: null,
        },
      ]),
    );
    const storey = at(objects, "s");
    expect(storey.objectType).toBe("BuildingStorey");
    expect(storey.parents).toEqual(["b"]);
    expect(storey.children).toEqual([]);
  });

  it("reads a bbox struct and rejects a malformed one", () => {
    const objects = decodeTableObjects(
      tableOf([
        {
          id: "good",
          object_type: "Building",
          bbox: { xmin: 1, ymin: 2, zmin: 3, xmax: 4, ymax: 5, zmax: 6 },
        },
        {
          id: "partial",
          object_type: "Building",
          bbox: { xmin: 1, ymin: 2, zmin: 3 },
        },
        { id: "absent", object_type: "Building" },
      ]),
    );
    expect(at(objects, "good").bbox).toEqual([1, 2, 3, 4, 5, 6]);
    expect(at(objects, "partial").bbox).toBeNull();
    expect(at(objects, "absent").bbox).toBeNull();
  });

  it("labels faces from face_semantics and drops the structural surface keys", () => {
    const objects = decodeTableObjects(
      tableOf(
        [
          {
            id: "a",
            object_type: "Building",
            geometry_lod2_2: wkbMultiPolygonZ([[TRIANGLE], [SQUARE], [SQUARE]]),
            geometry_properties_lod2_2: {
              type: "MultiSurface",
              surfaces: JSON.stringify([
                { type: "RoofSurface", slope: 12, parent: 3, children: [4] },
                { type: "NotASurfaceType", note: "kept" },
              ]),
              face_semantics: [0, 1, null],
            },
          },
        ],
        { geometryColumns: [LOD2_COLUMN] },
      ),
    );
    const surfaces = at(objects, "a").surfaces;
    expect(surfaces.length).toBe(3);
    expect(surfaces[0]?.type).toBe("RoofSurface");
    // `parent`/`children` are structural, not semantics — as for CityJSON.
    expect(surfaces[0]?.attributes).toEqual({ slope: 12 });
    expect(surfaces[0]?.lod).toBe("2.2");
    // An unrecognised type degrades to "unknown" but keeps its attributes.
    expect(surfaces[1]?.type).toBe("unknown");
    expect(surfaces[1]?.attributes).toEqual({ note: "kept" });
    // A null semantic index means "no semantics for this face".
    expect(surfaces[2]?.type).toBe("unknown");
    expect(surfaces[2]?.attributes).toEqual({});
    // Rings arrive unclosed and absolute.
    expect(surfaces[0]?.rings).toEqual([TRIANGLE]);
  });

  it("skips a non-surface geometry kind without throwing, but still counts its LoD", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const objects = decodeTableObjects(
        tableOf(
          [
            {
              id: "a",
              object_type: "Building",
              geometry_lod2_2: wkbPointZ([1, 2, 3]),
            },
          ],
          { geometryColumns: [LOD2_COLUMN] },
        ),
      );
      const a = at(objects, "a");
      expect(a.surfaces).toEqual([]);
      // Mirrors parseCityJSON: a non-surface geometry still sets the LoD.
      expect(a.lod).toBe("2.2");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("treats an empty face list as a valid empty geometry", () => {
    const objects = decodeTableObjects(
      tableOf(
        [
          {
            id: "a",
            object_type: "Building",
            geometry_lod2_2: wkbMultiPolygonZ([]),
          },
        ],
        { geometryColumns: [LOD2_COLUMN] },
      ),
    );
    expect(at(objects, "a").surfaces).toEqual([]);
    expect(at(objects, "a").lod).toBe("2.2");
  });

  it("reports a malformed geometry blob as a CityParquetError naming the object and column", () => {
    const table = tableOf(
      [
        {
          id: "broken",
          object_type: "Building",
          geometry_lod2_2: new Uint8Array([1, 99, 0, 0, 0]),
        },
      ],
      { geometryColumns: [LOD2_COLUMN] },
    );
    const caught = (() => {
      try {
        decodeTableObjects(table);
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(caught).toBeInstanceOf(CityParquetError);
    expect((caught as CityParquetError).message).toContain("broken");
    expect((caught as CityParquetError).message).toContain("geometry_lod2_2");
    expect((caught as CityParquetError).cause).toBeDefined();
  });

  it("reports a geometry cell that is not WKB bytes as a CityParquetError", () => {
    const table = tableOf(
      [
        {
          id: "wrong",
          object_type: "Building",
          // What hyparquet hands back if a GEOMETRY-annotated column is read
          // with its default parsers — GeoJSON, not the raw blob.
          geometry_lod2_2: { type: "Polygon", coordinates: [] },
        },
      ],
      { geometryColumns: [LOD2_COLUMN] },
    );
    expect(() => decodeTableObjects(table)).toThrow(CityParquetError);
    expect(() => decodeTableObjects(table)).toThrow(/WKB/);
  });

  it("skips a row with no usable id or object_type, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const objects = decodeTableObjects(
        tableOf([
          { id: null, object_type: "Building" },
          { id: "b", object_type: null },
          { id: "c", object_type: "Building" },
        ]),
      );
      expect(Object.keys(objects)).toEqual(["c"]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("labels faces from a bigint face_semantics list (INT64 writers)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const objects = decodeTableObjects(
        tableOf(
          [
            {
              id: "a",
              object_type: "Building",
              geometry_lod2_2: wkbMultiPolygonZ([[TRIANGLE], [SQUARE]]),
              geometry_properties_lod2_2: {
                type: "MultiSurface",
                surfaces: JSON.stringify([
                  { type: "GroundSurface" },
                  { type: "RoofSurface" },
                ]),
                // A LIST<INT64> column reads back as bigints. Rejecting them
                // would leave every surface "unknown" on a file that renders.
                face_semantics: [0n, 1n],
              },
            },
          ],
          { geometryColumns: [LOD2_COLUMN] },
        ),
      );
      const surfaces = at(objects, "a").surfaces;
      expect(surfaces.map((s) => s.type)).toEqual([
        "GroundSurface",
        "RoofSurface",
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns when face_semantics yields no usable index", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const objects = decodeTableObjects(
        tableOf(
          [
            {
              id: "bad-entries",
              object_type: "Building",
              geometry_lod2_2: wkbMultiPolygonZ([[TRIANGLE]]),
              geometry_properties_lod2_2: {
                type: "MultiSurface",
                surfaces: JSON.stringify([{ type: "RoofSurface" }]),
                // Neither an index nor a null: the silent-death shape.
                face_semantics: ["0"],
              },
            },
            {
              id: "all-null",
              object_type: "Building",
              geometry_lod2_2: wkbMultiPolygonZ([[TRIANGLE]]),
              geometry_properties_lod2_2: {
                type: "MultiSurface",
                surfaces: JSON.stringify([{ type: "RoofSurface" }]),
                face_semantics: [null],
              },
            },
          ],
          { geometryColumns: [LOD2_COLUMN] },
        ),
      );
      expect(at(objects, "bad-entries").surfaces[0]?.type).toBe("unknown");
      expect(at(objects, "all-null").surfaces[0]?.type).toBe("unknown");
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(
        messages.some((m) => m.includes("not usable surface indices")),
      ).toBe(true);
      expect(messages.some((m) => m.includes("no usable index"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("treats prototype-shaped ids and attribute names as ordinary keys", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const objects = decodeTableObjects(
        tableOf(
          [
            { id: "__proto__", object_type: "Building", polluted: 1 },
            { id: "constructor", object_type: "Building" },
            { id: "toString", object_type: "Building" },
          ],
          { attributes: ["polluted"] },
        ),
      );
      // The map carries no inherited members at all, so a hostile id can
      // neither vanish into a setter nor be mistaken for an existing entry.
      expect(Object.getPrototypeOf(objects)).toBeNull();
      expect(Object.keys(objects).sort()).toEqual([
        "__proto__",
        "constructor",
        "toString",
      ]);
      expect(at(objects, "__proto__").id).toBe("__proto__");
      expect(at(objects, "__proto__").attributes.polluted).toBe(1);
      expect(at(objects, "constructor").objectType).toBe("Building");
      // None of these are duplicates, so nothing may warn about one.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps diverted attributes whose names shadow Object.prototype", () => {
    const objects = decodeTableObjects(
      tableOf([
        {
          id: "a",
          object_type: "Building",
          other_attributes:
            '{"hasOwnProperty":1,"toString":"kept","__proto__":{"injected":true}}',
        },
      ]),
    );
    const attributes = at(objects, "a").attributes;
    expect(attributes.hasOwnProperty).toBe(1);
    expect(attributes.toString).toBe("kept");
    // The injected key is an ordinary entry, not a new prototype.
    expect(Object.getPrototypeOf(attributes)).toBeNull();
    expect(Object.keys(attributes).sort()).toEqual([
      "__proto__",
      "hasOwnProperty",
      "toString",
    ]);
  });

  it("does not read a declared attribute off the row's prototype", () => {
    const objects = decodeTableObjects(
      tableOf(
        // The row carries no `constructor` column — and `row.constructor` on an
        // ordinary object is `Object` itself, not undefined.
        [{ id: "a", object_type: "Building" }],
        { attributes: ["constructor", "toString"] },
      ),
    );
    expect(at(objects, "a").attributes).toEqual({});
  });

  it("reports each warning kind once, then summarises the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rows = Array.from({ length: 5 }, () => ({
        id: null,
        object_type: "Building",
      }));
      expect(Object.keys(decodeTableObjects(tableOf(rows)))).toEqual([]);
      // One full warning for the first occurrence, one summary for the rest —
      // never one per row, which on a real package is a million console lines
      // written from the main thread.
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]?.[0])).toContain("4 more");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("cityJsonTypeForObjectType", () => {
  it("reverse-maps the four CityGML renames and passes others through", () => {
    expect(cityJsonTypeForObjectType("Storey")).toBe("BuildingStorey");
    expect(cityJsonTypeForObjectType("HollowSpace")).toBe("TunnelHollowSpace");
    expect(cityJsonTypeForObjectType("Square")).toBe("TransportSquare");
    expect(cityJsonTypeForObjectType("GenericOccupiedSpace")).toBe(
      "GenericCityObject",
    );
    expect(cityJsonTypeForObjectType("Building")).toBe("Building");
    // The duckdb extension's CityJSON spelling is tolerated too.
    expect(cityJsonTypeForObjectType("TransportSquare")).toBe(
      "TransportSquare",
    );
    // An extension class has no taxonomy entry and keeps its own name.
    expect(cityJsonTypeForObjectType("+SolarPanel")).toBe("+SolarPanel");
  });
});
