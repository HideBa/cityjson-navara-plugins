/**
 * Minimal little-endian ISO-WKB reader for the CityJSON → CityParquet geometry
 * mapping. Behaviour mirrors `cityparquet-rs/crates/cityparquet/src/wkb_read.rs`
 * — the inverse of the writer that produced these blobs — with one deliberate
 * difference: the Rust reader interns coordinates into a shared pool because
 * its caller rebuilds a CityJSON vertex list, whereas this one hands back plain
 * `Vec3` rings, which is what the mesh builder wants. Deduplication, if it is
 * ever worth doing here, belongs at the mesh-building layer.
 *
 * Engine-free: no `@navaramap/*` imports.
 */

import type { Vec3 } from "@cityjson/navara-core";

/** A polygon ring, closing vertex already stripped. */
export type WkbRing = Vec3[];
/** A polygon: `rings[0]` is the exterior ring, the rest are holes. */
export type WkbFace = WkbRing[];

export type DecodedWkb =
  | { kind: "points"; points: Vec3[] }
  | { kind: "lines"; lines: Vec3[][] }
  | {
      kind: "faces";
      faces: WkbFace[];
      /**
       * How the flat `faces` list splits across the top-level geometry's
       * members. MultiPolygonZ/PolyhedralSurfaceZ produce a single entry
       * (`[faces.length]`); a GeometryCollectionZ produces one entry per
       * member, with the faces concatenated in member order.
       */
      memberFaceCounts: number[];
    };

/** Every malformed-buffer failure this module raises. */
export class WkbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WkbError";
  }
}

const POINT_Z = 1001;
const LINESTRING_Z = 1002;
const POLYGON_Z = 1003;
const MULTIPOINT_Z = 1004;
const MULTILINESTRING_Z = 1005;
const MULTIPOLYGON_Z = 1006;
const GEOMETRYCOLLECTION_Z = 1007;
const POLYHEDRALSURFACE_Z = 1015;

/**
 * Maximum container nesting depth. The writer only ever emits one level
 * (MultiSolid → collection of PolyhedralSurface) and this reader additionally
 * refuses any collection member that is not a PolyhedralSurfaceZ, so nothing
 * valid comes close to the cap — it is a structural guard so that relaxing the
 * member rule later cannot reopen unbounded recursion on a hostile buffer.
 */
const MAX_DEPTH = 16;

/**
 * Ring-closure tolerance. The writer repeats the first coordinate verbatim, so
 * a round-tripped ring closes bit-exactly; the tolerance exists for files we
 * did not write, where a coordinate may have been re-serialised through a
 * decimal text form. It is far below any meaningful projected-CRS resolution,
 * so it cannot swallow a genuinely distinct vertex.
 */
const RING_CLOSURE_EPSILON = 1e-9;

/** Bounds-checked little-endian cursor over a WKB buffer. */
class Cursor {
  private readonly view: DataView;
  private pos = 0;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get offset(): number {
    return this.pos;
  }

  get length(): number {
    return this.view.byteLength;
  }

  private require(n: number, what: string): void {
    if (this.pos + n > this.view.byteLength) {
      throw new WkbError(
        `truncated WKB: expected ${what} at offset ${this.pos} (buffer has ${this.view.byteLength} bytes)`,
      );
    }
  }

  u8(): number {
    this.require(1, "1 byte");
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  u32(): number {
    this.require(4, "4 bytes (u32)");
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.require(8, "8 bytes (f64)");
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  coord(): Vec3 {
    // Array-literal evaluation is left-to-right, so this reads x, y, z in
    // buffer order.
    return [this.f64(), this.f64(), this.f64()];
  }

  /**
   * Byte-order marker + type code. Only the little-endian marker (`0x01`) is
   * supported; anything else, big-endian `0x00` included, is an error.
   */
  header(): number {
    const byteOrder = this.u8();
    if (byteOrder !== 0x01) {
      throw new WkbError(
        `unsupported WKB byte order marker 0x${byteOrder.toString(16).padStart(2, "0")}: only little-endian (0x01) is supported`,
      );
    }
    return this.u32();
  }
}

function expectType(actual: number, expected: number, what: string): void {
  if (actual !== expected) {
    throw new WkbError(
      `expected ${what} (type ${expected}), got type code ${actual}`,
    );
  }
}

/** Full nested PointZ member: header + XYZ. */
function pointMember(c: Cursor): Vec3 {
  expectType(c.header(), POINT_Z, "PointZ");
  return c.coord();
}

/** LineStringZ body (header already consumed): numPoints + points. */
function lineStringBody(c: Cursor): Vec3[] {
  const n = c.u32();
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) pts.push(c.coord());
  return pts;
}

/** Full nested LineStringZ member. */
function lineStringMember(c: Cursor): Vec3[] {
  expectType(c.header(), LINESTRING_Z, "LineStringZ");
  return lineStringBody(c);
}

/**
 * One polygon ring: numPoints + points. WKB rings repeat their first
 * coordinate as the last; that closing vertex is validated and stripped, so a
 * ring needs at least 4 raw points to survive as a 3-vertex ring. A ring that
 * does not close is malformed — dropping its last point regardless would
 * silently delete a real vertex.
 */
function ring(c: Cursor): WkbRing {
  const nPoints = c.u32();
  if (nPoints < 4) {
    throw new WkbError(
      `WKB polygon ring has ${nPoints} points at offset ${c.offset}, need at least 4 (3 distinct plus the repeated closing vertex)`,
    );
  }
  const first = c.coord();
  const pts: WkbRing = [first];
  let last: Vec3 = first;
  for (let i = 1; i < nPoints; i++) {
    last = c.coord();
    pts.push(last);
  }
  const closed =
    Math.abs(first[0] - last[0]) < RING_CLOSURE_EPSILON &&
    Math.abs(first[1] - last[1]) < RING_CLOSURE_EPSILON &&
    Math.abs(first[2] - last[2]) < RING_CLOSURE_EPSILON;
  if (!closed) {
    throw new WkbError(
      `unclosed WKB ring: the last of ${nPoints} points does not repeat the first`,
    );
  }
  pts.pop();
  return pts;
}

/** PolygonZ body (header already consumed): numRings + rings. */
function polygonBody(c: Cursor): WkbFace {
  const nRings = c.u32();
  if (nRings === 0) {
    throw new WkbError("WKB polygon has zero rings");
  }
  const rings: WkbFace = [];
  for (let i = 0; i < nRings; i++) rings.push(ring(c));
  return rings;
}

/** Full nested PolygonZ member. */
function polygonMember(c: Cursor): WkbFace {
  expectType(c.header(), POLYGON_Z, "PolygonZ");
  return polygonBody(c);
}

/**
 * The body shared by MultiPolygonZ and PolyhedralSurfaceZ: a count followed by
 * that many complete nested PolygonZ members.
 */
function polygonListBody(c: Cursor): WkbFace[] {
  const n = c.u32();
  const faces: WkbFace[] = [];
  for (let i = 0; i < n; i++) faces.push(polygonMember(c));
  return faces;
}

/**
 * Dispatches on a just-read type code to the matching body parser. Used for the
 * top-level geometry (depth 0) and for GeometryCollection members, which are
 * themselves complete nested WKB geometries one level down.
 */
function parseBody(c: Cursor, typeCode: number, depth: number): DecodedWkb {
  if (depth > MAX_DEPTH) {
    throw new WkbError(
      `WKB geometry nesting exceeds the maximum depth of ${MAX_DEPTH}`,
    );
  }
  switch (typeCode) {
    case POINT_Z:
      return { kind: "points", points: [c.coord()] };
    case MULTIPOINT_Z: {
      const n = c.u32();
      const points: Vec3[] = [];
      for (let i = 0; i < n; i++) points.push(pointMember(c));
      return { kind: "points", points };
    }
    case LINESTRING_Z:
      return { kind: "lines", lines: [lineStringBody(c)] };
    case MULTILINESTRING_Z: {
      const n = c.u32();
      const lines: Vec3[][] = [];
      for (let i = 0; i < n; i++) lines.push(lineStringMember(c));
      return { kind: "lines", lines };
    }
    case POLYGON_Z: {
      // The writer never emits a bare PolygonZ at the top level (a single
      // surface becomes a MultiPolygonZ), but a one-face surface is the
      // unambiguous reading, so accept it rather than reject readable data.
      const faces = [polygonBody(c)];
      return { kind: "faces", faces, memberFaceCounts: [1] };
    }
    case MULTIPOLYGON_Z:
    case POLYHEDRALSURFACE_Z: {
      const faces = polygonListBody(c);
      return { kind: "faces", faces, memberFaceCounts: [faces.length] };
    }
    case GEOMETRYCOLLECTION_Z: {
      const n = c.u32();
      const faces: WkbFace[] = [];
      const memberFaceCounts: number[] = [];
      for (let i = 0; i < n; i++) {
        // The writer only emits collections of solids (MultiSolid /
        // CompositeSolid → GeometryCollection of PolyhedralSurface), and the
        // per-member face counts this returns only mean anything for members
        // that are surface lists — so anything else is refused rather than
        // flattened into a shape the caller would misread.
        const memberType = c.header();
        expectType(
          memberType,
          POLYHEDRALSURFACE_Z,
          "a GeometryCollection member to be PolyhedralSurfaceZ",
        );
        const member = parseBody(c, memberType, depth + 1);
        // Unreachable in practice — 1015 always decodes to `faces` — but the
        // narrowing has to happen somewhere, and an error beats a cast.
        if (member.kind !== "faces") {
          throw new WkbError(
            "GeometryCollection member did not decode to faces",
          );
        }
        // A concat loop rather than `push(...member.faces)`: a real solid can
        // carry more faces than the argument-list limit a spread would hit.
        for (const face of member.faces) faces.push(face);
        memberFaceCounts.push(member.faces.length);
      }
      return { kind: "faces", faces, memberFaceCounts };
    }
    default:
      throw new WkbError(`unsupported WKB type code ${typeCode}`);
  }
}

/**
 * Parses a complete little-endian WKB buffer, as produced by the CityParquet
 * writer. Any unsupported type code, a big-endian marker, an unclosed ring, a
 * truncated buffer or trailing bytes after a complete geometry is a
 * {@link WkbError}.
 */
export function decodeWkb(bytes: Uint8Array): DecodedWkb {
  const c = new Cursor(bytes);
  const decoded = parseBody(c, c.header(), 0);
  if (c.offset !== c.length) {
    throw new WkbError(
      `trailing bytes: ${c.length - c.offset} bytes remain after a complete WKB geometry of ${c.offset} bytes`,
    );
  }
  return decoded;
}
