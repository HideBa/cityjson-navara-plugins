/**
 * The CityParquet stream reader, on the multi-row-group fixture read through
 * range buffers: an open that reads the footer plus the `bbox` and `parents`
 * columns only, and `readRows` that reads whole families by row range.
 *
 * The fixture is 20 copies of `two-buildings` (copy k = rows 3k..3k+2, k*50 m
 * east): Pand.0001_k with its part Pand.0001-part1_k, then Pand.0002_k.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CityObject } from "@cityjson/navara-core";
import { describe, expect, it } from "vitest";
import { decodeTableObjects } from "../src/decodeTable";
import type { RangeBuffer } from "../src/rangeSource";
import { asyncBufferFromBlob } from "../src/rangeSource";
import type { ReadBatch } from "../src/streamReader";
import {
  AdmissionRefusedError,
  assertRowCount,
  openCityParquetStream,
} from "../src/streamReader";
import { CityParquetError } from "../src/footer";
import { readCityParquetTable } from "../src/tableReader";

const fixture = (dir: string) =>
  fileURLToPath(new URL(`./fixtures/${dir}/building.parquet`, import.meta.url));

async function bytesOf(dir: string): Promise<Uint8Array<ArrayBuffer>> {
  const file = await readFile(fixture(dir));
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file);
  return bytes;
}

async function bufferOf(dir: string): Promise<RangeBuffer> {
  return asyncBufferFromBlob(new Blob([await bytesOf(dir)]));
}

/** A buffer that records every slice it serves. */
function recording(inner: RangeBuffer): {
  buffer: RangeBuffer;
  slices: [number, number][];
} {
  const slices: [number, number][] = [];
  return {
    slices,
    buffer: {
      byteLength: inner.byteLength,
      bytesRead: inner.bytesRead,
      setSignal: (s) => inner.setSignal(s),
      slice(start, end) {
        slices.push([start, end ?? inner.byteLength]);
        return inner.slice(start, end);
      },
    },
  };
}

async function collect(
  iterable: AsyncIterable<ReadBatch>,
): Promise<ReadBatch[]> {
  const out: ReadBatch[] = [];
  for await (const batch of iterable) out.push(batch);
  return out;
}

const COPY_9_IDS = [
  "NL.IMBAG.Pand.0001_9",
  "NL.IMBAG.Pand.0001-part1_9",
  "NL.IMBAG.Pand.0002_9",
];
/** Tight around copy 9 (x 85450..85485); copies 8 and 10 are 15 m away. */
const COPY_9_BOX = [85449, 445999, 85486, 446013] as const;

describe("openCityParquetStream", () => {
  it("reports the table's rows, LoDs, CRS and the merged extent of its row bboxes", async () => {
    const bytes = await bytesOf("multigroup-cityparquet");
    const resident = decodeTableObjects(await readCityParquetTable(bytes));
    let extent: number[] | null = null;
    for (const object of Object.values(resident)) {
      const b = object.bbox!;
      extent = extent
        ? [
            Math.min(extent[0]!, b[0]),
            Math.min(extent[1]!, b[1]),
            Math.min(extent[2]!, b[2]),
            Math.max(extent[3]!, b[3]),
            Math.max(extent[4]!, b[4]),
            Math.max(extent[5]!, b[5]),
          ]
        : [...b];
    }

    const stream = await openCityParquetStream([
      asyncBufferFromBlob(new Blob([bytes])),
    ]);
    expect(stream.header.objectsCount).toBe(60);
    expect(stream.header.lods).toEqual(["0", "2.2"]);
    expect(stream.header.epsg).toBe(7415);
    expect(stream.header.referenceSystem).toBe(
      "https://www.opengis.net/def/crs/EPSG/0/7415",
    );
    expect(stream.header.version).toMatch(/\d/);
    expect(stream.header.invalidBBoxRows).toBe(0);
    // Every geometry column of this fixture names its LoD, so the unlabelled
    // rung is absent (Codex milestone review, Important — the flag is what
    // lets the worker adapter keep a bare `geometry` column visible).
    expect(stream.header.unlabelledGeometry).toBe(false);
    expect(stream.header.extent).toEqual(extent);
    expect(stream.index.rowCount).toBe(60);
  });

  it("reads only the footer and the bbox/parents columns to open", async () => {
    const bytes = await bytesOf("multigroup-cityparquet");
    const tail = new DataView(bytes.buffer, bytes.byteLength - 8, 4);
    const footerStart = bytes.byteLength - 8 - tail.getUint32(0, true);
    const { buffer, slices } = recording(
      asyncBufferFromBlob(new Blob([bytes])),
    );
    await openCityParquetStream([buffer]);
    // The first slice is hyparquet's footer fetch: the last 512 KiB of the
    // file, which on this 250 KB fixture is all of it. Every later slice is a
    // column read; count what those take from the data region.
    expect(slices[0]).toEqual([
      Math.max(0, bytes.byteLength - 512 * 1024),
      bytes.byteLength,
    ]);
    let dataBytes = 0;
    for (const [s, e] of slices.slice(1)) {
      dataBytes += Math.max(0, Math.min(e, footerStart) - s);
    }
    expect(dataBytes).toBeGreaterThan(0);
    expect(dataBytes).toBeLessThan(footerStart * 0.05);
  });

  it("reports each table's own name and row count, summing to objectsCount", async () => {
    // Per-table counts are what lets the app report a FAMILY's size: the sum
    // alone cannot say how many of the rows are buildings.
    const stream = await openCityParquetStream([
      asyncBufferFromBlob(
        new File([await bytesOf("multigroup-cityparquet")], "building.parquet"),
      ),
      asyncBufferFromBlob(
        new File(
          [await bytesOf("two-buildings-cityparquet")],
          "bridge.parquet",
        ),
      ),
    ]);
    expect(stream.header.tables).toEqual([
      { name: "building.parquet", rowCount: 60 },
      { name: "bridge.parquet", rowCount: 3 },
    ]);
    expect(stream.header.tables.reduce((n, t) => n + t.rowCount, 0)).toBe(
      stream.header.objectsCount,
    );
  });

  it("names a table by its index when its source carries no name", async () => {
    const stream = await openCityParquetStream([
      await bufferOf("multigroup-cityparquet"),
    ]);
    // 0-based, like `FamilyRange.table` and `StreamRow.table`.
    expect(stream.header.tables).toEqual([{ name: "table-0", rowCount: 60 }]);
  });

  it("refuses tables that declare different EPSG codes", async () => {
    const open = openCityParquetStream([
      await bufferOf("multigroup-cityparquet"),
      await bufferOf("two-buildings-cityparquet-28992"),
    ]);
    await expect(open).rejects.toBeInstanceOf(AdmissionRefusedError);
    await expect(open).rejects.toMatchObject({ code: "mixed-crs" });
  });
});

describe("readRows", () => {
  it("reads exactly the families a box hits, with rings and a row entry each", async () => {
    const stream = await openCityParquetStream([
      await bufferOf("multigroup-cityparquet"),
    ]);
    const ranges = stream.index.query(COPY_9_BOX);
    expect(ranges).toEqual([{ table: 0, start: 27, end: 30 }]);

    const batches = await collect(
      stream.readRows(ranges, null, new AbortController().signal),
    );
    expect(batches).toHaveLength(1);
    const { objects, rows } = batches[0]!;
    expect(Object.keys(objects).sort()).toEqual([...COPY_9_IDS].sort());
    for (const id of COPY_9_IDS) {
      const object: CityObject = objects[id]!;
      expect(object.surfaces.length).toBeGreaterThan(0);
      expect(object.surfaces[0]!.rings[0]!.length).toBeGreaterThanOrEqual(3);
    }
    expect(rows.get("NL.IMBAG.Pand.0001_9")).toEqual({
      table: 0,
      row: 27,
      familyRoot: "NL.IMBAG.Pand.0001_9",
    });
    expect(rows.get("NL.IMBAG.Pand.0001-part1_9")).toEqual({
      table: 0,
      row: 28,
      familyRoot: "NL.IMBAG.Pand.0001_9",
    });
    expect(rows.get("NL.IMBAG.Pand.0002_9")).toEqual({
      table: 0,
      row: 29,
      familyRoot: "NL.IMBAG.Pand.0002_9",
    });
  });

  it("reads fewer bytes and no LoD-2 surfaces under maxLod 1", async () => {
    const buffer = await bufferOf("multigroup-cityparquet");
    const stream = await openCityParquetStream([buffer]);
    const ranges = [{ table: 0, start: 0, end: 60 }];
    const signal = new AbortController().signal;

    const before = buffer.bytesRead();
    const low = await collect(stream.readRows(ranges, "1", signal));
    const lowBytes = buffer.bytesRead() - before;
    const all = await collect(stream.readRows(ranges, null, signal));
    const allBytes = buffer.bytesRead() - before - lowBytes;

    expect(lowBytes).toBeLessThan(allBytes);
    const lods = (batches: ReadBatch[]) =>
      new Set(
        batches.flatMap((b) =>
          Object.values(b.objects).flatMap((o) => o.surfaces.map((s) => s.lod)),
        ),
      );
    expect(lods(low)).toEqual(new Set(["0"]));
    expect(lods(all)).toEqual(new Set(["0", "2.2"]));
    expect(Object.keys(low[0]!.objects)).toHaveLength(60);
  });

  it("rejects with AbortError when aborted mid-iteration, and reads again under a fresh signal", async () => {
    const stream = await openCityParquetStream([
      await bufferOf("multigroup-cityparquet"),
    ]);
    const ranges = [
      { table: 0, start: 0, end: 3 },
      { table: 0, start: 30, end: 33 },
    ];
    const controller = new AbortController();
    const iterator = stream
      .readRows(ranges, null, controller.signal)
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });

    const again = await collect(
      stream.readRows(ranges, null, new AbortController().signal),
    );
    expect(again).toHaveLength(2);
    expect(Object.keys(again[1]!.objects)).toContain("NL.IMBAG.Pand.0001_10");
  });
});

describe("assertRowCount", () => {
  it("accepts a read that returned exactly its row range", () => {
    expect(() => assertRowCount(8, 16, 24)).not.toThrow();
  });

  it.each([
    ["short", 7],
    ["long", 9],
  ])("refuses a %s read as a CityParquetError naming the range", (_, n) => {
    expect(() => assertRowCount(n, 16, 24)).toThrow(CityParquetError);
    expect(() => assertRowCount(n, 16, 24)).toThrow(/rows 16..24/);
  });
});

/**
 * Codex milestone review (Critical): the row gates (`MAX_FETCH_READ_ROWS`,
 * `VIEWPORT_FEATURE_BUDGET`) bound rows, not bytes. `useOffsetIndex` was
 * requested but never REQUIRED, so on a file without a page index hyparquet
 * reads whole column chunks — a single-row-group table could pass a one-family
 * fetch and download the lot. `estimateReadBytes` plans the physical cost from
 * the footer alone, so a fetch can be refused before a single slice is read.
 */
describe("estimateReadBytes", () => {
  /** Copy 9: rows 27..30, inside the fixture's 8-row row groups. */
  const COPY_9_RANGE = [{ table: 0, start: 27, end: 30 }] as const;

  it("charges only the selected fraction of an indexed chunk, and the whole of an unindexed one", async () => {
    const indexed = await openCityParquetStream([
      await bufferOf("multigroup-cityparquet"),
    ]);
    const unindexed = await openCityParquetStream([
      await bufferOf("multigroup-noindex-cityparquet"),
    ]);
    const a = indexed.estimateReadBytes(COPY_9_RANGE, null);
    const b = unindexed.estimateReadBytes(COPY_9_RANGE, null);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });

  it("charges less for a lower LoD, which reads fewer columns", async () => {
    const stream = await openCityParquetStream([
      await bufferOf("multigroup-cityparquet"),
    ]);
    expect(stream.estimateReadBytes(COPY_9_RANGE, "0")).toBeLessThan(
      stream.estimateReadBytes(COPY_9_RANGE, null),
    );
  });

  it("charges nothing for no ranges, and never counts a row group twice", async () => {
    const stream = await openCityParquetStream([
      await bufferOf("multigroup-cityparquet"),
    ]);
    expect(stream.estimateReadBytes([], null)).toBe(0);
    // Two ranges inside ONE row group cost no more than the whole group.
    const split = stream.estimateReadBytes(
      [
        { table: 0, start: 24, end: 26 },
        { table: 0, start: 26, end: 28 },
      ],
      null,
    );
    const whole = stream.estimateReadBytes([{ table: 0, start: 24, end: 32 }], null);
    expect(split).toBeLessThanOrEqual(whole);
  });

  it.each(["multigroup-cityparquet", "multigroup-noindex-cityparquet"])(
    "stays within a small factor of what %s actually fetches",
    async (dir) => {
      // The estimate is a PLANNING bound, not a hard ceiling: it charges a
      // compressed chunk by its row fraction, while a real indexed read
      // fetches whole pages and the offset index itself. On these fixtures
      // (256-byte pages, 8-row groups) that overhead is the larger part; on a
      // production file with megabyte pages it is noise. The bound this test
      // pins is "the same order of magnitude", which is what a 96 MiB refusal
      // gate needs.
      const buffer = await bufferOf(dir);
      const stream = await openCityParquetStream([buffer]);
      const before = buffer.bytesRead();
      const estimate = stream.estimateReadBytes(COPY_9_RANGE, null);
      await collect(
        stream.readRows(COPY_9_RANGE, null, new AbortController().signal),
      );
      const actual = buffer.bytesRead() - before;
      expect(estimate).toBeGreaterThan(actual / 4);
      expect(estimate).toBeLessThan(actual * 4);
    },
  );
});
