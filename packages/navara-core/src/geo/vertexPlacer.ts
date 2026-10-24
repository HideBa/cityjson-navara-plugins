/**
 * Source-CRS vertices placed in a local ENU frame, each vertex projected once.
 *
 * A bake writes one position per triangle corner, and a vertex is a corner of
 * every surface that shares it (and of every LoD that reuses it), so placing
 * corners one by one runs proj4 about three times per distinct vertex on the
 * 3DBAG, and again on every rebuild. The parser hands every ring the SAME
 * `Vec3` object for the same vertex index (`buildSurface`), and triangulation
 * keeps those objects, so a cache keyed by the object projects each vertex
 * once for as long as the placer lives: one bake in the worker, the life of
 * one placement on the static path.
 *
 * The computation is {@link sourceToEnuPoint}'s, on the double-precision
 * source coordinates, stored as the Float32 the position buffer holds. A
 * `Vec3` is never mutated after parsing, which is what makes its identity a
 * valid key; a placer is tied to one frame and one height offset, so a new
 * placement needs a new placer.
 */
import type { Vec3 } from "../citymodel/types";
import {
  geodeticToEnu,
  makeWgs84Converter,
  type SourceToEnuOptions,
} from "./sourceToEnu";

export interface VertexPlacer {
  /** Write `v`'s ENU position into `out[at..at+3]`. */
  place(v: Vec3, out: Float32Array, at: number): void;
  /** How many distinct vertices have been projected so far. */
  projectedCount(): number;
}

export function createVertexPlacer(opts: SourceToEnuOptions): VertexPlacer {
  const convert = makeWgs84Converter(opts.epsg);
  const { frame, heightOffset } = opts;
  const slots = new Map<Vec3, number>();
  let store = new Float32Array(3 * 1024);
  let count = 0;
  return {
    place(v, out, at) {
      let slot = slots.get(v);
      if (slot === undefined) {
        const [lng, lat] = convert.forward([v[0], v[1]]);
        const enu = geodeticToEnu(lng, lat, v[2] + heightOffset, frame);
        slot = count++;
        if (slot * 3 + 3 > store.length) {
          const grown = new Float32Array(store.length * 2);
          grown.set(store);
          store = grown;
        }
        store[slot * 3] = enu[0];
        store[slot * 3 + 1] = enu[1];
        store[slot * 3 + 2] = enu[2];
        slots.set(v, slot);
      }
      out[at] = store[slot * 3]!;
      out[at + 1] = store[slot * 3 + 1]!;
      out[at + 2] = store[slot * 3 + 2]!;
    },
    projectedCount: () => count,
  };
}
