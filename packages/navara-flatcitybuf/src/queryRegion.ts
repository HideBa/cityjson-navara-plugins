/**
 * "What the last fetch actually asked for", published for a UI to draw.
 *
 * A commit's query region is `viewportFootprint()`'s `bbox` — the same value
 * `FcbStreamLayerHandle.commit` puts on the wire as `{ type: "probe", bbox }`
 * and `{ type: "fetch", bbox }`, and the same value `planCommit` derives the
 * level and the cell cover from. There is deliberately NO second computation
 * here: this module only RESHAPES the footprint the commit already used, so a
 * diagnostic overlay can never drift from the region actually queried.
 *
 * Two coordinate systems, because the two consumers need different ones:
 *   - `bbox` stays in the layer's SOURCE CRS, which is what a bbox readout has
 *     to show (it is the CRS the file, the worker's spatial index and every
 *     `select()` speak).
 *   - `ring` is the same rectangle in lng/lat degrees, which is what a globe
 *     renderer can place. The edges are DENSIFIED before projection (see
 *     {@link RING_POINTS_PER_EDGE}): a straight line in a projected CRS is a
 *     curve in lng/lat, and a straight chord in ECEF cuts under the ellipsoid,
 *     so a bare four-corner ring would visibly bow away from the ground it is
 *     supposed to outline.
 *
 * Engine-free by construction (the NODE_IMPORT_SAFE = false rule): the
 * projection is injected as `toLngLat`, so this module never imports proj4 nor
 * `@navaramap/*`, and every assertion about it runs in plain Node.
 */
import type { Footprint } from "./viewportFootprint";

/**
 * How many ring vertices each of the four edges contributes (its start corner
 * plus `RING_POINTS_PER_EDGE - 1` interior samples). Eight puts a vertex every
 * ~1/8 of an edge, which is well inside a pixel at any camera height a
 * streaming commit happens from, for 32 projection calls per commit — a commit
 * already costs a worker round trip per cell, so this is free in comparison.
 */
export const RING_POINTS_PER_EDGE = 8;

/** The region the last commit fetched, ready to draw and to read out. */
export interface QueryRegion {
  /** Which layer asked. Carried on the event so a subscriber that watches
   *  several layers needs no closure per handle. */
  readonly layerId: string;
  /** `[minX, minY, maxX, maxY]` in the layer's SOURCE CRS — byte-for-byte the
   *  bbox the `probe`/`fetch` messages carried. */
  readonly bbox: readonly [number, number, number, number];
  /** The source CRS of {@link bbox}, from the FCB header. `null` only for a
   *  header that named no EPSG, which `openStream`'s CRS gate already refuses
   *  — carried anyway so a readout can say "unknown" instead of lying. */
  readonly epsg: number | null;
  /** The longer of the two bbox sides, in source-CRS units (metres: the CRS
   *  gate admits metric CRSs only). `Footprint.span`, unchanged. */
  readonly span: number;
  /** Ellipsoidal height of the layer's ground plane, i.e. its
   *  `heightOffsetM` — the plane `viewportFootprint` intersected the camera
   *  rays with. A renderer that draws the ring at any other height draws it
   *  somewhere the query was not taken. */
  readonly heightM: number;
  /**
   * The closed rectangle in `[lngDeg, latDeg]`, starting at the min/min corner
   * and running counter-clockwise. The first point is NOT repeated: a closed
   * ring is a property of the renderer, not of the data.
   */
  readonly ring: ReadonlyArray<readonly [number, number]>;
}

export interface QueryRegionInput {
  readonly layerId: string;
  readonly footprint: Footprint;
  readonly epsg: number | null;
  /** The layer's `heightOffsetM`. */
  readonly heightM: number;
  /** Source CRS -> geodetic degrees. The handle's own `toLngLat`, so the ring
   *  and the layer's cells are projected by the same converter. */
  readonly toLngLat: (x: number, y: number) => readonly [number, number];
}

/**
 * Reshape one commit's footprint into a drawable region.
 *
 * Returns `null` when the projection produced anything non-finite — the same
 * "no usable footprint" signal `viewportFootprint` uses, and for the same
 * reason: a NaN vertex reaching a line renderer is a mesh that either
 * disappears or smears across the globe, neither of which reads as "the query
 * could not be projected".
 */
export function queryRegionFrom(input: QueryRegionInput): QueryRegion | null {
  const [minX, minY, maxX, maxY] = input.footprint.bbox;
  const corners: ReadonlyArray<readonly [number, number]> = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];

  const ring: Array<readonly [number, number]> = [];
  for (let edge = 0; edge < 4; edge++) {
    const from = corners[edge]!;
    const to = corners[(edge + 1) % 4]!;
    // `< RING_POINTS_PER_EDGE`, not `<=`: the edge's end corner is the next
    // edge's start corner, so emitting it here would duplicate every corner.
    for (let step = 0; step < RING_POINTS_PER_EDGE; step++) {
      const t = step / RING_POINTS_PER_EDGE;
      const [lng, lat] = input.toLngLat(
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
      );
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      ring.push([lng, lat]);
    }
  }

  return {
    layerId: input.layerId,
    bbox: input.footprint.bbox,
    epsg: input.epsg,
    span: input.footprint.span,
    heightM: input.heightM,
    ring,
  };
}
