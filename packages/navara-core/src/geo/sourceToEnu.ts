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
 * The cost is one proj4 *projection* per vertex, paid once per geometry build
 * (a LoD change, or a worker decoding a cell) — never per frame. In the
 * FlatCityBuf pipeline it runs inside the worker.
 *
 * Note the difference between a projection and a *converter*: proj4's
 * three-argument call `proj4(from, to, coord)` re-parses both CRS definitions
 * and constructs two `Proj` objects on every call, which for a 100k-vertex
 * buffer dominates the run time: 950 ms per 100k vertices that way versus
 * 255 ms with one hoisted converter, of which ~230 ms is proj4's `forward`
 * itself — i.e. the hoisted loop is now converter-bound, with nothing left to
 * win short of a different projection library. `projectPositionsToEnu`
 * therefore builds the converter once and calls `converter.forward` per
 * vertex. That is bit-for-bit the same computation: proj4's three-argument
 * form is literally `transformer(fromProj, toProj, coord)`, exactly what
 * `forward` calls.
 */
import proj4 from "proj4";
import { ensureProjDef } from "../citymodel/crsProjDefs";
import { geodeticToEcef, type EnuFrame } from "./enuFrame";

/** Just the half of proj4's `Converter` this module uses. */
interface SourceToWgs84 {
  forward(coords: [number, number]): [number, number];
}

/**
 * One reusable source-CRS -> WGS84 converter. Hoist this out of any per-vertex
 * loop; constructing it is the expensive part, using it is not.
 */
function makeWgs84Converter(epsg: number): SourceToWgs84 {
  ensureProjDef(epsg);
  return proj4(`EPSG:${epsg}`, "WGS84") as SourceToWgs84;
}

/** Shared tail of both public entry points: lng/lat/height -> local ENU. */
function geodeticToEnu(
  lng: number,
  lat: number,
  height: number,
  frame: EnuFrame,
): [number, number, number] {
  const p = geodeticToEcef(lng, lat, height);
  const m = frame.matrix;
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

/**
 * Single-point convenience wrapper. It builds a converter per call, so it is
 * for one-off points (a layer origin, a probe) — bulk work goes through
 * {@link projectPositionsToEnu}.
 */
export function sourceToEnuPoint(
  x: number,
  y: number,
  z: number,
  opts: SourceToEnuOptions,
): [number, number, number] {
  const [lng, lat] = makeWgs84Converter(opts.epsg).forward([x, y]);
  return geodeticToEnu(lng, lat, z + opts.heightOffset, opts.frame);
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
  // Hoisted: see the module header. One converter for the whole buffer, not
  // one per vertex — same numbers, ~3.7x faster.
  const convert = makeWgs84Converter(opts.epsg);
  const { frame, heightOffset } = opts;
  for (let i = 0; i < positions.length; i += 3) {
    const [lng, lat] = convert.forward([
      positions[i]! + ox,
      positions[i + 1]! + oy,
    ]);
    const enu = geodeticToEnu(
      lng,
      lat,
      positions[i + 2]! + oz + heightOffset,
      frame,
    );
    positions[i] = enu[0];
    positions[i + 1] = enu[1];
    positions[i + 2] = enu[2];
  }
  return positions;
}
