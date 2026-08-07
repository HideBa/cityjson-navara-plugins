/**
 * The table reader, exercised against the real `cityparquet` fixture package.
 *
 * Two things are pinned here that the rest of the pipeline depends on: the
 * geometry columns are discovered from the file's OWN schema (so both LoDs are
 * found, each paired with its `geometry_properties_*` sibling), and every row
 * comes back with the decode conventions the WKB decoder expects — `id` a JS
 * string, the geometry blob a raw `Uint8Array`.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CityParquetError } from "../src/footer";
import { readCityParquetTable } from "../src/tableReader";

const FIXTURE = fileURLToPath(
  new URL(
    "./fixtures/two-buildings-cityparquet/building.parquet",
    import.meta.url,
  ),
);

/**
 * Counts the `slice` calls made against one `ArrayBuffer` instance, by shadowing
 * the prototype method with an own property that delegates to it.
 *
 * This is the mechanical test for "did the reader copy?": hyparquet reads a
 * file only through `AsyncBuffer.slice`, so a buffer that is sliced is a buffer
 * that was read in place, and one that is never sliced was copied first.
 */
function instrumentSlice(buffer: ArrayBuffer): { calls: number } {
  const counter = { calls: 0 };
  const original = buffer.slice.bind(buffer);
  Object.defineProperty(buffer, "slice", {
    configurable: true,
    writable: true,
    value: (start: number, end?: number) => {
      counter.calls += 1;
      return original(start, end);
    },
  });
  return counter;
}

describe("readCityParquetTable", () => {
  it("reads the fixture package table", async () => {
    const t = await readCityParquetTable(await readFile(FIXTURE));
    expect(t.footer.epsg).toBe(7415);
    expect(t.rows.length).toBe(3);
    const names = t.geometryColumns.map((g) => g.name).sort();
    expect(names).toEqual(["geometry_lod0_0", "geometry_lod2_2"]);
    expect(
      t.geometryColumns.every((g) =>
        g.propsName?.startsWith("geometry_properties_"),
      ),
    ).toBe(true);
    const part = t.rows.find((r) => r.object_type === "BuildingPart");
    expect(part).toBeDefined();
    expect(part?.geometry_lod2_2).toBeInstanceOf(Uint8Array);
    expect(typeof part?.id).toBe("string");
  });

  it("reports the display LoD of each geometry column", async () => {
    const t = await readCityParquetTable(await readFile(FIXTURE));
    const lods = new Map(t.geometryColumns.map((g) => [g.name, g.lod]));
    expect(lods.get("geometry_lod0_0")).toBe("0");
    expect(lods.get("geometry_lod2_2")).toBe("2.2");
  });

  it("projects the identity, attribute and geometry columns and nothing else", async () => {
    const t = await readCityParquetTable(await readFile(FIXTURE));
    const first = t.rows[0];
    expect(first).toBeDefined();
    const keys = Object.keys(first ?? {});
    // Present in the schema and asked for.
    for (const wanted of [
      "id",
      "feature_id",
      "object_type",
      "parents",
      "children",
      "bbox",
      "geometry_lod0_0",
      "geometry_lod2_2",
      "geometry_properties_lod0_0",
      "geometry_properties_lod2_2",
      "other_attributes",
      "measuredHeight",
      "roofType",
    ]) {
      expect(keys).toContain(wanted);
    }
    // Present in the schema but deliberately skipped — appearance, templates
    // and the containers this reader does not model.
    for (const skipped of [
      "address",
      "template",
      "other",
      "children_roles",
      "material_lod0_0",
      "material_lod2_2",
      "texture_lod0_0",
      "texture_lod2_2",
    ]) {
      expect(keys).not.toContain(skipped);
    }
  });

  it("slices the caller's own buffer when the view spans it", async () => {
    const raw = await readFile(FIXTURE);
    const buf = new ArrayBuffer(raw.byteLength);
    new Uint8Array(buf).set(raw);
    const sliced = instrumentSlice(buf);

    const t = await readCityParquetTable(new Uint8Array(buf));

    // The reader read THROUGH the caller's buffer — no up-front copy, which on
    // a large package is the difference between opening and not.
    expect(sliced.calls).toBeGreaterThan(0);
    expect(t.rows.length).toBe(3);
  });

  it("copies a partial view, so absolute footer offsets still land", async () => {
    const raw = await readFile(FIXTURE);
    const padded = new ArrayBuffer(raw.byteLength + 8);
    new Uint8Array(padded, 8).set(raw);
    const sliced = instrumentSlice(padded);

    const t = await readCityParquetTable(
      new Uint8Array(padded, 8, raw.byteLength),
    );

    // The offset buffer was NOT sliced: hyparquet's absolute offsets would be
    // 8 bytes wrong against it, so this path must normalise onto a copy.
    expect(sliced.calls).toBe(0);
    expect(t.rows.length).toBe(3);
  });

  it("reports a failed normalising copy as a CityParquetError", async () => {
    const padded = new ArrayBuffer(64);
    const view = new Uint8Array(padded, 8, 16);
    const RealArrayBuffer = globalThis.ArrayBuffer;
    // The only allocation this reader makes itself is the normalising copy, and
    // it happens synchronously before the first `await` — so a stub that lives
    // for exactly the length of the call reaches that one site and no other.
    globalThis.ArrayBuffer = function FailingArrayBuffer() {
      throw new RangeError("Array buffer allocation failed");
    } as unknown as ArrayBufferConstructor;
    let pending: Promise<unknown>;
    try {
      pending = readCityParquetTable(view);
    } finally {
      globalThis.ArrayBuffer = RealArrayBuffer;
    }

    const caught = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(CityParquetError);
    expect((caught as CityParquetError).message).toMatch(/not enough memory/i);
    expect((caught as CityParquetError).cause).toBeInstanceOf(RangeError);
  });

  it("rejects a non-parquet buffer with a friendly error", async () => {
    await expect(
      readCityParquetTable(new Uint8Array([1, 2, 3, 4])),
    ).rejects.toThrow(/parquet/i);
    await expect(
      readCityParquetTable(new Uint8Array([1, 2, 3, 4])),
    ).rejects.toBeInstanceOf(CityParquetError);
    // The library's own failure stays reachable for a bug report.
    const caught = await readCityParquetTable(
      new Uint8Array([1, 2, 3, 4]),
    ).catch((e: unknown) => e);
    expect((caught as CityParquetError).cause).toBeInstanceOf(Error);
  });
});

/**
 * The two branches no real fixture can reach — an experimental encoding, and a
 * schema that omits optional columns — driven through a stubbed hyparquet.
 *
 * The stub is loaded with `vi.doMock` + a dynamic import rather than a
 * file-level `vi.mock` so the fixture tests above keep running against the real
 * reader; a hoisted mock would replace it for the whole file.
 */
async function readWithStub(options: {
  city: unknown;
  schemaColumns: string[];
}): Promise<{ columns: string[] | undefined }> {
  const seen: { columns: string[] | undefined } = { columns: undefined };
  vi.resetModules();
  vi.doMock("../src/vendor/hyparquet/index.js", () => ({
    parquetMetadataAsync: async () => ({
      num_rows: 0n,
      key_value_metadata: [{ key: "city", value: JSON.stringify(options.city) }],
    }),
    parquetSchema: () => ({
      element: { name: "root" },
      children: options.schemaColumns.map((name) => ({
        element: { name },
        children: [],
      })),
    }),
    parquetReadObjects: async (o: { columns?: string[] }) => {
      seen.columns = o.columns;
      return [];
    },
  }));
  const mod = await import("../src/tableReader");
  await mod.readCityParquetTable(new Uint8Array(0));
  return seen;
}

describe("readCityParquetTable (stubbed hyparquet)", () => {
  afterEach(() => {
    vi.doUnmock("../src/vendor/hyparquet/index.js");
    vi.resetModules();
  });

  it("refuses an experimental geometry encoding by name", async () => {
    await expect(
      readWithStub({
        city: {
          version: "1.0.0",
          columns: [{ name: "geometry_lod2_2", encoding: "cityparquet.solid" }],
        },
        schemaColumns: ["id", "geometry_lod2_2"],
      }),
    ).rejects.toThrow(/"cityparquet\.solid" geometry encoding/);
  });

  it("skips projected columns the schema does not carry", async () => {
    const seen = await readWithStub({
      city: {
        version: "1.0.0",
        columns: [{ name: "geometry", encoding: "WKB" }],
        // `absent` is declared but never written — a mirror may omit it.
        attributes: ["measuredHeight", "absent"],
      },
      // No `feature_id`, no `other_attributes`, no properties sibling.
      schemaColumns: ["id", "object_type", "geometry", "measuredHeight"],
    });
    expect(seen.columns).toEqual([
      "id",
      "object_type",
      "geometry",
      "measuredHeight",
    ]);
  });

  it("does not mistake a declared attribute for a geometry column", async () => {
    const seen = await readWithStub({
      city: {
        version: "1.0.0",
        columns: [{ name: "geometry_lod1_2", encoding: "WKB" }],
        // Legal per spec §13.1: a LoD the dataset does not otherwise use may
        // be an ordinary attribute name.
        attributes: ["geometry_lod3_1"],
      },
      schemaColumns: ["id", "geometry_lod1_2", "geometry_lod3_1"],
    });
    // `geometry_lod3_1` is projected as an attribute, not as geometry — and
    // no `geometry_properties_lod3_1` is asked for.
    expect(seen.columns).toEqual(["id", "geometry_lod1_2", "geometry_lod3_1"]);
  });
});
