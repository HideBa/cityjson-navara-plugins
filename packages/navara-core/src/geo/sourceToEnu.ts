/**
 * Exact source-CRS -> local-ENU vertex placement.
 *
 * `buildCityMeshArrays` emits vertices as *source-CRS deltas* from a chosen
 * origin (the model's bbox centre, or a streaming cell's centre). Those
 * deltas are NOT ENU metres: a projected CRS carries a point scale factor
 * and a grid convergence angle, so treating "x=east, y=north" as an identity
 * mapping mis-places and mis-rotates everything more than a few hundred
 * metres from the origin. Against photorealistic terrain that is visible.
 *
 * So each vertex is transformed exactly:
 *
 *     source (x, y, z)
 *       -> proj4(EPSG:n -> WGS84)          = (lng, lat)
 *       -> height = z + heightOffset
 *       -> geodeticToEcef                  = ECEF metres
 *       -> inverse of the frame's ENU matrix = local ENU metres
 *
 * The cost is one proj4 call per vertex, paid once per geometry build (a LoD
 * change, or a worker decoding a cell) — never per frame. In the FlatCityBuf
 * pipeline it runs inside the worker.
 */
import proj4 from "proj4";
import { ensureProjDef } from "../citymodel/crsProjDefs";
import { geodeticToEcef, type EnuFrame } from "./enuFrame";

export interface SourceToEnuOptions {
  /** Source CRS of the incoming x/y. Must already be proj4-registrable. */
  readonly epsg: number;
  /** Destination frame; its origin height already includes `heightOffset`. */
  readonly frame: EnuFrame;
  /** Metres added to every vertex's geodetic height: the geoid undulation
   *  at the layer/cell origin, from `geoidHeightAt()` (see Global
   *  Constraints -> Vertical datum). 0 means "treat z as ellipsoidal". */
  readonly heightOffset: number;
}

export interface ProjectPositionsOptions extends SourceToEnuOptions {
  /** The source-CRS origin the positions buffer is relative to. */
  readonly originOffset: readonly [number, number, number];
}

export function sourceToEnuPoint(
  x: number,
  y: number,
  z: number,
  opts: SourceToEnuOptions,
): [number, number, number] {
  ensureProjDef(opts.epsg);
  const [lng, lat] = proj4(`EPSG:${opts.epsg}`, "WGS84", [x, y]) as [
    number,
    number,
  ];
  const p = geodeticToEcef(lng, lat, z + opts.heightOffset);
  const m = opts.frame.matrix;
  const dx = p[0] - m[12]!;
  const dy = p[1] - m[13]!;
  const dz = p[2] - m[14]!;
  // The rotation block is orthonormal, so its inverse is its transpose.
  return [
    m[0]! * dx + m[1]! * dy + m[2]! * dz,
    m[4]! * dx + m[5]! * dy + m[6]! * dz,
    m[8]! * dx + m[9]! * dy + m[10]! * dz,
  ];
}

/**
 * In-place rewrite of a `CityMeshArrays.positions` buffer: origin-relative
 * source deltas in, local ENU metres out. Float64 is used throughout the
 * computation; only the final store is Float32, which is safe because the
 * result is small (metres from a nearby origin), unlike the ECEF value.
 */
export function projectPositionsToEnu(
  positions: Float32Array,
  opts: ProjectPositionsOptions,
): Float32Array {
  const [ox, oy, oz] = opts.originOffset;
  for (let i = 0; i < positions.length; i += 3) {
    const enu = sourceToEnuPoint(
      positions[i]! + ox,
      positions[i + 1]! + oy,
      positions[i + 2]! + oz,
      opts,
    );
    positions[i] = enu[0];
    positions[i + 1] = enu[1];
    positions[i + 2] = enu[2];
  }
  return positions;
}
