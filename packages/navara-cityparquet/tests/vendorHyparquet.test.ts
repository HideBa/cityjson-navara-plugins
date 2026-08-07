/**
 * The vendored hyparquet copy, exercised against a real `cityparquet` package.
 *
 * This is the guard on the local patch (see `src/vendor/hyparquet/VENDORED.md`):
 * the fixture's `id` column is DELTA_BYTE_ARRAY in a V1 data page, which
 * unpatched upstream 1.28.1 refuses outright. It also pins the two decode
 * conventions the rest of this package is built on: with `utf8: false`,
 * STRING-annotated columns still come back as JS strings, while the
 * un-annotated BYTE_ARRAY geometry blobs stay raw `Uint8Array` WKB.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compressors } from "hyparquet-compressors";
import { describe, expect, it } from "vitest";
import type { AsyncBuffer } from "../src/vendor/hyparquet/index.js";
import {
  parquetMetadataAsync,
  parquetReadObjects,
} from "../src/vendor/hyparquet/index.js";

const FIXTURE = fileURLToPath(
  new URL(
    "./fixtures/two-buildings-cityparquet/building.parquet",
    import.meta.url,
  ),
);

/**
 * hyparquet's `AsyncBuffer` slices absolute file offsets, so the view Node
 * hands back has to be normalised to its own ArrayBuffer first — a `readFile`
 * result may be a window into a larger pooled buffer, and a non-zero
 * `byteOffset` would shift every offset in the footer.
 *
 * The copy is written out by hand rather than as `bytes.buffer.slice(...)`
 * only because `Uint8Array#buffer` is typed `ArrayBufferLike`, which would
 * widen the result to include `SharedArrayBuffer`.
 */
function asyncBufferOf(bytes: Uint8Array): AsyncBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return {
    byteLength: buf.byteLength,
    slice: (s: number, e?: number) => buf.slice(s, e),
  };
}

describe("vendored hyparquet", () => {
  it("reads footer kv metadata and DELTA_BYTE_ARRAY ids from a real package", async () => {
    const file = asyncBufferOf(await readFile(FIXTURE));
    const metadata = await parquetMetadataAsync(file);
    const kv = metadata.key_value_metadata ?? [];
    expect(kv.map((e) => e.key)).toContain("city");
    const rows = await parquetReadObjects({
      file,
      metadata,
      compressors,
      utf8: false,
      columns: ["id", "object_type", "geometry_lod2_2"],
    });
    expect(rows.length).toBe(3);
    expect(typeof rows[0]?.id).toBe("string");
    const wkbRow = rows.find((r) => r.geometry_lod2_2 != null)!;
    expect(wkbRow.geometry_lod2_2).toBeInstanceOf(Uint8Array);
  });
});
