/**
 * Source-CRS vertices placed in a local ENU frame, each vertex projected once.
 *
 * A bake writes one position per triangle corner, and a vertex is a corner of
 * every surface that shares it (and of every LoD that reuses it), so placing
 * corners one by one runs proj4 about three times per distinct vertex on the
 * 3DBAG, and again on every rebuild. The parser hands every ring the SAME
 * `Vec3` object for the same vertex index (`buildSurface`), and triangulation
 * keeps those objects, so a cache keyed by the object projects each vertex
 * once for as long as the cache lives.
 *
 * What is cached is the proj4 half, `{@link ProjectedVertices}`: a vertex's
 * geodetic position as the terms of `geodeticToEcef` that do not depend on
 * height. It holds for any frame and any height offset, so a static layer
 * keeps one for its life and a new placement (a geoid offset arriving) does
 * not re-project. The ENU half is arithmetic per corner, in the same order as
 * `geodeticToEnu`, so a placed vertex is bit for bit
 * {@link sourceToEnuPoint}'s answer, stored as the Float32 the position
 * buffer holds.
 *
 * A `Vec3` is never mutated after parsing, which is what makes its identity a
 * valid key. The cache is bounded: when it holds `capacity` vertices it
 * starts again, so a source that shares few vertex objects cannot grow it by
 * an entry per corner for a layer's life. Sharing is local (a vertex's faces
 * are one object's), so a bound costs only the reuse across a restart.
 */
import type { Vec3 } from "../citymodel/types";
import { WGS84_A, WGS84_E2 } from "./enuFrame";
import { makeWgs84Converter, type SourceToEnuOptions } from "./sourceToEnu";

/** Per vertex: n, cos(phi), cos(lambda), sin(lambda), sin(phi). */
const TERMS = 5;

/** Source vertices' geodetic positions, projected once each, for one CRS. */
export interface ProjectedVertices {
  readonly epsg: number;
  /** The slot of `v`'s terms in {@link terms}, projecting it if new. */
  slotOf(v: Vec3): number;
  /** {@link TERMS} numbers per slot. Replaced when it grows: read it after
   *  {@link slotOf}. */
  terms(): Float64Array;
  /** How many projections it has run, a vertex projected again after a
   *  restart counted twice. */
  count(): number;
  /** How many vertices it holds now, at most its capacity. */
  size(): number;
}

/** The default bound: about 3.5 MB of entries and terms. */
const DEFAULT_CAPACITY = 1 << 16;

export function createProjectedVertices(
  epsg: number,
  capacity = DEFAULT_CAPACITY,
): ProjectedVertices {
  const convert = makeWgs84Converter(epsg);
  const slots = new Map<Vec3, number>();
  let store = new Float64Array(TERMS * Math.min(capacity, 1024));
  let count = 0;
  return {
    epsg,
    slotOf(v) {
      let slot = slots.get(v);
      if (slot !== undefined) return slot;
      // geodeticToEcef's own terms, computed the way it computes them.
      const [lng, lat] = convert.forward([v[0], v[1]]);
      const lam = (lng * Math.PI) / 180;
      const phi = (lat * Math.PI) / 180;
      const sinPhi = Math.sin(phi);
      if (slots.size === capacity) slots.clear();
      slot = slots.size;
      count++;
      if ((slot + 1) * TERMS > store.length) {
        const grown = new Float64Array(
          Math.min(store.length * 2, capacity * TERMS),
        );
        grown.set(store);
        store = grown;
      }
      const at = slot * TERMS;
      store[at] = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
      store[at + 1] = Math.cos(phi);
      store[at + 2] = Math.cos(lam);
      store[at + 3] = Math.sin(lam);
      store[at + 4] = sinPhi;
      slots.set(v, slot);
      return slot;
    },
    terms: () => store,
    count: () => count,
    size: () => slots.size,
  };
}

export interface VertexPlacer {
  /** Write `v`'s ENU position into `out[at..at+3]`. */
  place(v: Vec3, out: Float32Array, at: number): void;
  /** How many projections its {@link ProjectedVertices} has run. */
  projectedCount(): number;
}

/**
 * Places vertices in `opts.frame`, raised by `opts.heightOffset`. `projected`
 * carries projections over from an earlier placer of the same CRS; without
 * it the placer starts its own.
 */
export function createVertexPlacer(
  opts: SourceToEnuOptions,
  projected: ProjectedVertices = createProjectedVertices(opts.epsg),
): VertexPlacer {
  if (projected.epsg !== opts.epsg) {
    throw new Error(
      `A placer for EPSG:${opts.epsg} cannot reuse EPSG:${projected.epsg} projections.`,
    );
  }
  const { frame, heightOffset } = opts;
  const m = frame.matrix;
  return {
    place(v, out, at) {
      const slot = projected.slotOf(v);
      const t = projected.terms();
      const i = slot * TERMS;
      const n = t[i]!;
      const cosPhi = t[i + 1]!;
      const h = v[2] + heightOffset;
      // geodeticToEnu: ECEF, then the frame's transpose rotation.
      const x = (n + h) * cosPhi * t[i + 2]!;
      const y = (n + h) * cosPhi * t[i + 3]!;
      const z = (n * (1 - WGS84_E2) + h) * t[i + 4]!;
      const dx = x - m[12]!;
      const dy = y - m[13]!;
      const dz = z - m[14]!;
      out[at] = m[0]! * dx + m[1]! * dy + m[2]! * dz;
      out[at + 1] = m[4]! * dx + m[5]! * dy + m[6]! * dz;
      out[at + 2] = m[8]! * dx + m[9]! * dy + m[10]! * dz;
    },
    projectedCount: () => projected.count(),
  };
}
