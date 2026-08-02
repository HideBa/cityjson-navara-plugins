/**
 * Georeferencing for a city model: source CRS -> WGS84 geodetic, used to
 * place a local-ENU-metre mesh on the globe (spec 4.3) and to report
 * geodetic bounds for fitAll/fitLayer.
 *
 * Deliberately free of @navaramap imports: the ECEF/ENU matrix comes from
 * @cityjson/navara-core's `makeEnuFrame`, never from Navara's
 * `eastNorthUpToFixedFrame`. That keeps this module unit-testable in Node and
 * keeps static layers and streaming cells on one frame implementation.
 *
 * Scope: this module places an **origin**, not vertices. Source-CRS deltas
 * from that origin are not ENU metres (a projected CRS carries a point scale
 * factor and a grid convergence angle), so every vertex is separately
 * transformed by core's `projectPositionsToEnu` in the geometry build path —
 * Task B6 for static layers, the FlatCityBuf worker for streaming cells.
 *
 * Vertical datum: CityJSON z is normally orthometric (NAP for EPSG:7415)
 * while the ENU frame sits on the WGS84 ellipsoid, so a geoid undulation
 * `heightOffset` is added to every vertex's geodetic height. It must be added
 * to the frame origin too — see `makePlacementFrame`.
 */
import proj4 from "proj4";
import { Matrix4 } from "three";
import {
  assertMetricCrs,
  ensureProjDef,
  makeEnuFrame,
  parseEpsgCode,
  type BBox3,
  type EnuFrame,
  type Vec3,
} from "@cityjson/navara-core";

// Re-exported, not redefined: the units gate and its error moved into
// `@cityjson/navara-core` (Task C5) so FlatCityBuf streaming admission and the
// static load path share ONE implementation. Callers that already import them
// from here keep working.
export { NonMetricCrsError, assertMetricCrs } from "@cityjson/navara-core";

export interface Lle {
  readonly lng: number;
  readonly lat: number;
  readonly height: number;
}

export interface GeodeticBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
  readonly minHeight: number;
  readonly maxHeight: number;
}

export class CrsUnresolvedError extends Error {
  constructor(readonly crs: string | number | undefined) {
    super(
      `Cannot georeference this layer: CRS ${
        crs === undefined ? "(missing)" : String(crs)
      } has no proj4 definition. Navara has no planar mode, so the layer cannot be loaded.`,
    );
    this.name = "CrsUnresolvedError";
  }
}

/**
 * The spec 4.3 CRS gate: a layer either has a CRS proj4 can reproject through
 * or it does not load at all. There is no planar fallback — an ungeoreferenced
 * mesh has nowhere to go on a globe renderer.
 *
 * Says nothing about units — see {@link resolveMetricEpsg}, which is what a
 * load path should call.
 */
export function resolveEpsg(crs: string | number | undefined): number {
  const epsg = typeof crs === "number" ? crs : parseEpsgCode(crs);
  if (epsg === null || epsg === undefined) throw new CrsUnresolvedError(crs);
  if (!ensureProjDef(epsg)) throw new CrsUnresolvedError(crs);
  return epsg;
}

/**
 * The full admission gate for a static layer: resolvable by proj4 AND
 * metre-based (core's `assertMetricCrs` — the same call FlatCityBuf's
 * `checkAdmission` makes, so neither path is the hole in the other's policy).
 * `CityModelMesh` calls this, not `resolveEpsg`.
 */
export function resolveMetricEpsg(crs: string | number | undefined): number {
  const epsg = resolveEpsg(crs);
  assertMetricCrs(epsg);
  return epsg;
}

/**
 * One reusable source-CRS -> WGS84 converter. proj4's three-argument call
 * re-parses both CRS definitions on every invocation, so callers that project
 * more than one point build this once and reuse it.
 */
function wgs84Converter(epsg: number): {
  forward(coords: [number, number]): [number, number];
} {
  if (!ensureProjDef(epsg)) throw new CrsUnresolvedError(epsg);
  return proj4(`EPSG:${epsg}`, "WGS84") as {
    forward(coords: [number, number]): [number, number];
  };
}

export function originLleFromOffset(originOffset: Vec3, epsg: number): Lle {
  const [lng, lat] = wgs84Converter(epsg).forward([
    originOffset[0],
    originOffset[1],
  ]);
  return { lng, lat, height: originOffset[2] };
}

/**
 * Geodetic envelope of a source-CRS bbox, for fitAll/fitLayer.
 *
 * The four corners are enough for city-scale extents: within a single
 * projected CRS's area of use the reprojected edges bow by well under the
 * camera-fit padding. A continent-wide bbox would need densified edges.
 */
export function geodeticBoundsFromBBox(
  bbox: BBox3,
  epsg: number,
): GeodeticBounds {
  const convert = wgs84Converter(epsg);
  const corners: Array<[number, number]> = [
    [bbox[0], bbox[1]],
    [bbox[3], bbox[1]],
    [bbox[3], bbox[4]],
    [bbox[0], bbox[4]],
  ];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const corner of corners) {
    const [lng, lat] = convert.forward(corner);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return { west, south, east, north, minHeight: bbox[2], maxHeight: bbox[5] };
}

/**
 * The layer's ENU frame: the origin's geodetic position raised by the vertical
 * datum `heightOffset` (the geoid undulation from `geoidHeightAt`).
 *
 * **Invariant:** the same `heightOffset` MUST be passed to
 * `projectPositionsToEnu` for that layer's vertices. The offset then appears
 * on both sides of the ENU subtraction and cancels, so local coordinates stay
 * small and a vertex at the origin's own height lands at ENU z = 0. Offsetting
 * only the vertices floats the mesh `heightOffset` metres up; offsetting only
 * the frame sinks it by the same amount. Building the frame through this
 * function (rather than calling `makeEnuFrame` with a hand-added height) is
 * what makes that pairing explicit at the call site.
 */
export function makePlacementFrame(
  originLle: Lle,
  heightOffset: number,
): EnuFrame {
  return makeEnuFrame(
    originLle.lng,
    originLle.lat,
    originLle.height + heightOffset,
  );
}

/**
 * ENU(metres) -> ECEF placement matrix. Passed to the engine as a mesh's
 * top-level `matrixWorld`: Navara copies it and disables auto-update, so mesh
 * world space is ECEF while the vertices stay small and local.
 */
export function placementMatrixFromFrame(frame: EnuFrame): Matrix4 {
  // Matrix4.elements and EnuFrame.matrix are both column-major, and
  // `fromArray` copies element-wise out of any ArrayLike — so the Float64Array
  // is read directly and the Matrix4 does not alias the frame.
  return new Matrix4().fromArray(frame.matrix);
}

/** ENU(metres) -> ECEF placement matrix for a layer origin. */
export function placementMatrixFromLle(lle: Lle): Matrix4 {
  return placementMatrixFromFrame(makeEnuFrame(lle.lng, lle.lat, lle.height));
}

/**
 * Everything a placed mesh needs, produced in one call so the three parts
 * cannot drift apart.
 */
export interface Placement {
  /** The ENU frame the vertices are projected into. */
  readonly frame: EnuFrame;
  /** That same frame as an ENU->ECEF matrix, for the mesh's `matrixWorld`. */
  readonly matrixWorld: Matrix4;
  /** The offset baked into `frame`, to hand to `projectPositionsToEnu`. */
  readonly heightOffset: number;
}

/**
 * Build a layer's (or cell's) placement bundle.
 *
 * `makePlacementFrame` already documents the frame+offset invariant, but a
 * caller still had to remember to derive the matrix from the SAME frame and to
 * pass the SAME offset on to `projectPositionsToEnu` — three values wired by
 * hand at every call site. This returns all three together, so the only way to
 * mis-wire them is to ignore the bundle. `CityModelMesh` (Task B6) and the
 * streaming cell path (Tasks C5/C8) both consume it.
 */
export function buildPlacement(
  originLle: Lle,
  heightOffset: number,
): Placement {
  const frame = makePlacementFrame(originLle, heightOffset);
  return { frame, matrixWorld: placementMatrixFromFrame(frame), heightOffset };
}
