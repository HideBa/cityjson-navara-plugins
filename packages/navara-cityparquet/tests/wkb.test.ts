/**
 * The little-endian ISO-WKB decoder, against hand-built buffers plus one real
 * `cityparquet` geometry blob.
 *
 * The hand-built cases pin the shapes the writer emits (see
 * `cityparquet-rs/crates/cityparquet/src/wkb_write.rs`) and the malformed
 * inputs the decoder must refuse rather than silently repair.
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
import type { WkbFace } from "../src/wkb";
import { decodeWkb, WkbError } from "../src/wkb";

/** Little-endian byte builder for hand-written WKB buffers. */
class W {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v);
    return this;
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.bytes.push(...b);
    return this;
  }
  f64(v: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.bytes.push(...b);
    return this;
  }
  pt(x: number, y: number, z: number) {
    return this.f64(x).f64(y).f64(z);
  }
  out() {
    return new Uint8Array(this.bytes);
  }
}

/** A closed unit-square PolygonZ at height `z`. */
function polygonZ(w: W, z: number) {
  w.u8(1)
    .u32(1003)
    .u32(1) // 1 ring
    .u32(5)
    .pt(0, 0, z)
    .pt(1, 0, z)
    .pt(1, 1, z)
    .pt(0, 1, z)
    .pt(0, 0, z);
}

describe("decodeWkb", () => {
  it("decodes PolyhedralSurfaceZ into faces with closing vertex stripped", () => {
    const w = new W();
    w.u8(1).u32(1015).u32(2);
    polygonZ(w, 0);
    polygonZ(w, 3);
    const d = decodeWkb(w.out());
    if (d.kind !== "faces") throw new Error("wrong kind");
    expect(d.faces.length).toBe(2);
    expect(d.memberFaceCounts).toEqual([2]);
    expect(d.faces[0]?.[0]?.length).toBe(4); // closing vertex stripped
    expect(d.faces[1]?.[0]?.[0]).toEqual([0, 0, 3]);
  });

  it("decodes MultiPolygonZ (footprints) and polygon holes", () => {
    const w = new W();
    w.u8(1)
      .u32(1006)
      .u32(1)
      .u8(1)
      .u32(1003)
      .u32(2)
      .u32(5)
      .pt(0, 0, 0)
      .pt(4, 0, 0)
      .pt(4, 4, 0)
      .pt(0, 4, 0)
      .pt(0, 0, 0)
      .u32(5)
      .pt(1, 1, 0)
      .pt(2, 1, 0)
      .pt(2, 2, 0)
      .pt(1, 2, 0)
      .pt(1, 1, 0);
    const d = decodeWkb(w.out());
    if (d.kind !== "faces") throw new Error("wrong kind");
    expect(d.faces[0]?.length).toBe(2); // exterior + hole
  });

  it("decodes GeometryCollectionZ of two solids with per-member counts", () => {
    const w = new W();
    w.u8(1).u32(1007).u32(2);
    w.u8(1).u32(1015).u32(1);
    polygonZ(w, 0);
    w.u8(1).u32(1015).u32(2);
    polygonZ(w, 1);
    polygonZ(w, 2);
    const d = decodeWkb(w.out());
    if (d.kind !== "faces") throw new Error("wrong kind");
    expect(d.faces.length).toBe(3);
    expect(d.memberFaceCounts).toEqual([1, 2]);
  });

  it("decodes MultiPointZ into points", () => {
    const w = new W();
    w.u8(1)
      .u32(1004)
      .u32(2)
      .u8(1)
      .u32(1001)
      .pt(1, 2, 3)
      .u8(1)
      .u32(1001)
      .pt(4, 5, 6);
    const d = decodeWkb(w.out());
    if (d.kind !== "points") throw new Error("wrong kind");
    expect(d.points).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("decodes MultiLineStringZ into lines", () => {
    const w = new W();
    w.u8(1)
      .u32(1005)
      .u32(2)
      .u8(1)
      .u32(1002)
      .u32(2)
      .pt(0, 0, 0)
      .pt(1, 0, 0)
      .u8(1)
      .u32(1002)
      .u32(3)
      .pt(0, 0, 0)
      .pt(0, 1, 0)
      .pt(0, 1, 1);
    const d = decodeWkb(w.out());
    if (d.kind !== "lines") throw new Error("wrong kind");
    expect(d.lines.map((l) => l.length)).toEqual([2, 3]);
    expect(d.lines[1]?.[2]).toEqual([0, 1, 1]);
  });

  it("rejects big-endian, unknown type codes, truncation, open rings", () => {
    expect(() => decodeWkb(new W().u8(0).u32(1015).out())).toThrow(WkbError);
    expect(() => decodeWkb(new W().u8(1).u32(999).out())).toThrow(WkbError);
    const t = new W();
    t.u8(1).u32(1015).u32(1);
    polygonZ(t, 0);
    expect(() => decodeWkb(t.out().slice(0, 20))).toThrow(WkbError);
    const open = new W();
    open
      .u8(1)
      .u32(1015)
      .u32(1)
      .u8(1)
      .u32(1003)
      .u32(1)
      .u32(4)
      .pt(0, 0, 0)
      .pt(1, 0, 0)
      .pt(1, 1, 0)
      .pt(0, 1, 0);
    expect(() => decodeWkb(open.out())).toThrow(WkbError);
  });

  it("names the offset when the buffer is truncated", () => {
    const t = new W();
    t.u8(1).u32(1015).u32(1);
    polygonZ(t, 0);
    // 20 bytes stops inside the first ring's numPoints field, which starts at
    // offset 18 (order + type + numFaces + order + type + numRings).
    expect(() => decodeWkb(t.out().slice(0, 20))).toThrow(/offset 18/);
  });

  it("rejects a GeometryCollection member that is not a PolyhedralSurfaceZ", () => {
    const w = new W();
    w.u8(1).u32(1007).u32(1).u8(1).u32(1006).u32(1);
    polygonZ(w, 0);
    expect(() => decodeWkb(w.out())).toThrow(WkbError);
  });

  it("rejects a ring with fewer than 4 raw points, and a zero-ring polygon", () => {
    const short = new W();
    short
      .u8(1)
      .u32(1015)
      .u32(1)
      .u8(1)
      .u32(1003)
      .u32(1)
      .u32(3)
      .pt(0, 0, 0)
      .pt(1, 0, 0)
      .pt(0, 0, 0);
    expect(() => decodeWkb(short.out())).toThrow(WkbError);

    const noRings = new W();
    noRings.u8(1).u32(1015).u32(1).u8(1).u32(1003).u32(0);
    expect(() => decodeWkb(noRings.out())).toThrow(WkbError);
  });

  it("rejects trailing bytes after a complete geometry", () => {
    const w = new W();
    w.u8(1).u32(1015).u32(1);
    polygonZ(w, 0);
    expect(() => decodeWkb(w.out())).not.toThrow();
    w.u8(0xde).u8(0xad);
    expect(() => decodeWkb(w.out())).toThrow(WkbError);
  });
});

/**
 * hyparquet's `AsyncBuffer` slices absolute file offsets, so a `readFile`
 * result (possibly a window into a larger pooled buffer) is normalised onto
 * its own `ArrayBuffer` first. Mirrors `vendorHyparquet.test.ts`.
 */
function asyncBufferOf(bytes: Uint8Array): AsyncBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return {
    byteLength: buf.byteLength,
    slice: (s: number, e?: number) => buf.slice(s, e),
  };
}

const FIXTURE = fileURLToPath(
  new URL(
    "./fixtures/two-buildings-cityparquet/building.parquet",
    import.meta.url,
  ),
);

async function readFixtureRows(): Promise<Record<string, unknown>[]> {
  const file = asyncBufferOf(await readFile(FIXTURE));
  const metadata = await parquetMetadataAsync(file);
  return await parquetReadObjects({
    file,
    metadata,
    compressors,
    utf8: false,
    columns: ["id", "object_type", "geometry_lod2_2"],
  });
}

function wkbOf(rows: Record<string, unknown>[], id: string): Uint8Array {
  const blob = rows.find((r) => r.id === id)?.geometry_lod2_2;
  expect(blob).toBeInstanceOf(Uint8Array);
  return blob as Uint8Array;
}

/**
 * Every ring in a real shell: no holes, at least a triangle once the closing
 * vertex is off, and coordinates in the fixture's EPSG:7415 easting band —
 * which would not hold if the XYZ triples had been read in the wrong order or
 * with the wrong endianness.
 */
function expectPlausibleShell(faces: WkbFace[], minRingSize: number) {
  for (const face of faces) {
    expect(face.length).toBe(1); // exterior ring only, no holes
    const ring = face[0];
    expect(ring).toBeDefined();
    expect(ring?.length).toBeGreaterThanOrEqual(minRingSize);
    for (const [x, y, z] of ring ?? []) {
      expect(x).toBeGreaterThan(80000);
      expect(x).toBeLessThan(90000);
      expect(Number.isFinite(y)).toBe(true);
      expect(Number.isFinite(z)).toBe(true);
    }
  }
}

describe("decodeWkb on real cityparquet data", () => {
  it("decodes the BuildingPart's lod2.2 MultiSurface into six quad faces", async () => {
    const rows = await readFixtureRows();
    const d = decodeWkb(wkbOf(rows, "NL.IMBAG.Pand.0001-part1"));
    if (d.kind !== "faces") throw new Error(`expected faces, got ${d.kind}`);
    // A CityJSON MultiSurface is written as MultiPolygonZ: one member, six
    // quad surfaces (the box the source fixture models).
    expect(d.faces.length).toBe(6);
    expect(d.memberFaceCounts).toEqual([6]);
    expectPlausibleShell(d.faces, 4);
  });

  it("decodes the Buildings' lod2.2 Solids as PolyhedralSurfaceZ shells", async () => {
    const rows = await readFixtureRows();

    // Pand.0001's shell is a box with one corner cut off: seven faces, six
    // quads and a triangle — so a real ring can be shorter than four.
    const a = decodeWkb(wkbOf(rows, "NL.IMBAG.Pand.0001"));
    if (a.kind !== "faces") throw new Error(`expected faces, got ${a.kind}`);
    expect(a.faces.length).toBe(7);
    expect(a.memberFaceCounts).toEqual([7]);
    expect(
      a.faces.map((f) => f[0]?.length ?? 0).sort((x, y) => x - y),
    ).toEqual([3, 4, 4, 4, 4, 4, 4]);
    expectPlausibleShell(a.faces, 3);

    // Pand.0002 is a plain six-face box.
    const b = decodeWkb(wkbOf(rows, "NL.IMBAG.Pand.0002"));
    if (b.kind !== "faces") throw new Error(`expected faces, got ${b.kind}`);
    expect(b.faces.length).toBe(6);
    expect(b.memberFaceCounts).toEqual([6]);
    expectPlausibleShell(b.faces, 4);
  });
});
