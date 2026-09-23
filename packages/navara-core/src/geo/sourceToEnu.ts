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
import type { CityObject, Vec3 } from "../citymodel/types";
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

/**
 * Shared tail of every entry point here: lng/lat/height -> local ENU.
 *
 * Exported because a GEOGRAPHIC source (EPSG:6697) needs only this half: its
 * coordinates are already geodetic, so the proj4 step above it does not exist
 * and a vertex reaches its frame by arithmetic alone.
 */
export function geodeticToEnu(
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

// ---------------------------------------------------------------------------
// The geographic path: no projection at all
// ---------------------------------------------------------------------------

/**
 * The range a longitude/latitude pair must lie in. Wider than the UTM zones'
 * (`geographicToProjected.ts`'s `validateLonLat`) because an ENU frame has no
 * zones — it is defined wherever the globe is.
 *
 * The HEIGHT is gated too, for the same reason and not for its range: there is
 * no plausible bound on an ellipsoidal height, but a non-finite one makes
 * non-finite ECEF just as surely as a non-finite longitude does, and the
 * resulting vertex draws nothing while reporting nothing.
 */
function assertGeographic(
  lng: number,
  lat: number,
  height: number,
  objectId: string,
): void {
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    lng < -180 ||
    lng > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    throw new RangeError(
      `Cannot place object "${objectId}": expected a longitude/latitude pair, got longitude ${String(lng)}, latitude ${String(lat)}.`,
    );
  }
  if (!Number.isFinite(height)) {
    throw new RangeError(
      `Cannot place object "${objectId}": expected a finite height, got ${String(height)}.`,
    );
  }
}

type MutableBBox = [number, number, number, number, number, number];

function extend(
  box: MutableBBox | null,
  p: readonly [number, number, number],
): MutableBBox {
  if (box === null) return [p[0], p[1], p[2], p[0], p[1], p[2]];
  if (p[0] < box[0]) box[0] = p[0];
  if (p[1] < box[1]) box[1] = p[1];
  if (p[2] < box[2]) box[2] = p[2];
  if (p[0] > box[3]) box[3] = p[0];
  if (p[1] > box[4]) box[4] = p[1];
  if (p[2] > box[5]) box[5] = p[2];
  return box;
}

/**
 * In place over `objects`: every ring's lon/lat/h becomes local ENU metres in
 * `frame`, and every object's bbox is re-boxed in the SAME space.
 *
 * This is the streamed geographic path's ONE placement step. A geographic
 * source's coordinates are already geodetic, so there is no projection to
 * undo: `lon/lat/h -> ECEF -> frame` is arithmetic, and running it per CELL
 * (50-400 m) rather than per dataset keeps the frame level under every
 * analysis that reads z as up (see the milestone plan's Architecture).
 *
 * `heightOffset` is added to every vertex's geodetic height, exactly as
 * {@link projectPositionsToEnu} adds it — and `frame` must have been built
 * with the same offset in its origin, or the whole cell floats by it.
 *
 * The bbox is re-boxed FROM THE CONVERTED RINGS, because it is not decoration:
 * `buildCityMeshArrays` orients an exterior ring against the object's bbox
 * CENTRE, so a bbox left in the source's (or an index's) space flips roughly
 * half the surfaces. For the same reason the re-boxed value is TIGHT around
 * the rings actually present: where the old path handed `orientExteriorRing`
 * the file's own row box, a LoD-FILTERED bake here sees only the surviving
 * rings, so their centre — and with it a borderline surface's winding — can
 * come out the other way. Invisible with the city's double-sided material,
 * real for anything reading the normal G-buffer. An object with no rings
 * therefore comes out with
 * `bbox: null` — this function reads only rings, so it never has to trust, or
 * be told, which space the incoming bbox was in. (The stream worker hands the
 * adapter's BUCKET-space boxes straight to `toObjectRecords`, which is where a
 * geometryless family parent's box comes from; bucket metres look exactly like
 * a plausible lon/lat pair, so a fallback that converted the incoming box would
 * be silently wrong for one.)
 *
 * Objects are replaced, not mutated (a `CityObject` is immutable), so a caller
 * that must keep the geographic model passes a shallow copy of the record.
 *
 * Throws a `RangeError` naming the object for a vertex that is not a
 * longitude/latitude pair, or whose height is not finite. This is the read
 * path's only coordinate gate: the per-vertex check the projected path did in
 * proj4 is gone, and an unchecked NaN in ANY of the three components would
 * become NaN geometry — a cell that silently draws nothing.
 */
export function geodeticRingsToEnu(
  objects: Record<string, CityObject>,
  frame: EnuFrame,
  heightOffset = 0,
): void {
  for (const id of Object.keys(objects)) {
    const object = objects[id]!;
    let box: MutableBBox | null = null;
    const surfaces = object.surfaces.map((surface) => ({
      ...surface,
      rings: surface.rings.map((ring) =>
        ring.map((point): Vec3 => {
          const h = point[2] + heightOffset;
          assertGeographic(point[0], point[1], h, id);
          const enu = geodeticToEnu(point[0], point[1], h, frame);
          box = extend(box, enu);
          return enu;
        }),
      ),
    }));
    objects[id] = { ...object, surfaces, bbox: box };
  }
}
