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
import type { BBox3, CityObject, Vec3 } from "../citymodel/types";
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
 * A geodetic box's eight corners in `frame`'s ENU metres, re-boxed — `null` for
 * no box, and for one holding a value the frame cannot place. All eight, and not
 * two: the conversion is not linear, and the box is a reference for a winding
 * decision, so under-bounding it is the one thing it must not do.
 *
 * The heights take `heightOffset` exactly as a vertex does. Without that a box
 * seeded from a file whose z is orthometric sits a whole geoid undulation — 37 m
 * at Nagoya — below the geometry it is supposed to bound, and every ground
 * polygon then reads as ABOVE the object's centre.
 *
 * A non-finite corner drops the whole box rather than throwing: the box is a
 * reference, the RINGS are the coordinate gate, and a bad extent should cost a
 * winding hint, not a cell. No CityParquet row reaches that branch — `readBBox`
 * refuses a non-finite bbox column before the adapter ever builds an extent — so
 * it is this module's gate on any OTHER caller's map, and it is load-bearing:
 * `extend` compares with `<`/`>`, which are false against NaN, so a NaN seed
 * would swallow every ring that follows and publish an all-NaN bbox, which
 * disables the winding decision silently and travels on into the object record.
 * Both halves are pinned in `tests/geo/geodeticRingsToEnu.test.ts`.
 */
function enuBoxOfGeodeticBox(
  bbox: BBox3 | undefined,
  frame: EnuFrame,
  heightOffset: number,
): MutableBBox | null {
  if (!bbox) return null;
  let box: MutableBBox | null = null;
  for (const lng of [bbox[0], bbox[3]]) {
    for (const lat of [bbox[1], bbox[4]]) {
      for (const z of [bbox[2], bbox[5]]) {
        const h = z + heightOffset;
        if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(h)) {
          return null;
        }
        box = extend(box, geodeticToEnu(lng, lat, h, frame));
      }
    }
  }
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
 * The bbox is re-boxed in the same space, because it is not decoration:
 * `buildCityMeshArrays` orients an exterior ring against the object's bbox
 * CENTRE, so a bbox left in the source's (or an index's) space flips roughly
 * half the surfaces.
 *
 * `fileExtents`, when given, is that reference: per object id, the object's
 * FULL extent in geodetic lon/lat/h as the SOURCE FILE's own row box states it
 * — including the surfaces a LoD filter removed before the bake. It seeds the
 * box, which the converted rings then extend, exactly as `projectCityObjects`
 * seeds from `projectBBox(object.bbox)` on the projected path. It has to be the
 * file's extent and not the rings', because the rings alone are no
 * inside/outside reference for the object: a CityParquet read filters geometry
 * columns by LoD, so at LoD 0 the object arriving here is its footprint and
 * nothing else, and a box drawn tight around two footprint polygons a few
 * centimetres apart in height sits BETWEEN them and inverts the upper one (the
 * fix round's N1, measured at every step from 5 cm up). The file's row box is
 * the whole building, so both polygons read as below its centre and both keep
 * the downward normal CityJSON gives a GroundSurface.
 *
 * It is the CALLER that says which space the incoming boxes are in, and it says
 * it by converting them to lon/lat first: this function never reads
 * `object.bbox`. The stream worker's own index boxes are BUCKET metres, which
 * look exactly like a plausible lon/lat pair, so a silent fallback to
 * `object.bbox` would be wrong for one with nothing able to tell.
 *
 * An id with no entry (a CityParquet child row whose bbox columns are null) —
 * or a whole call with no map — keeps the TIGHT box of its own rings, and
 * `orientExteriorRing`'s magnitude floor is then the only protection: it holds
 * for a single planar face and for a step below 2.5e-4 of the box diagonal, and
 * not above that. An object with neither rings nor an extent comes out with
 * `bbox: null`.
 *
 * A PRESENT extent is not automatically a reference either, and the residue is
 * not only the null path: the seed helps exactly as far as the box puts a face
 * clearly on ONE side of its centre. Two shapes are on the other side of that,
 * both measured and pinned in `tests/geo/geodeticRingsToEnu.test.ts`:
 *
 * - a z-DEGENERATE or near-flat extent, which is valid data — `readBBox`
 *   accepts `zmin == zmax` and `familyIndex` accepts `minZ <= maxZ`, so the row
 *   decodes, indexes and places with `invalidBBoxRows` at 0. The real shape is a
 *   table whose only geometry is LoD 0 footprints: `zmin..zmax` IS the
 *   footprint's own step, so the row box equals the tight box and the inversion
 *   above returns on entirely correct data, with nothing reporting that the
 *   reference carried no information.
 * - an extent much TALLER than the geometry the read kept, where a face lands on
 *   the far side of the box's centre: a roof at 8 m inside a 0..40 m row box
 *   inverts, flipping at exactly `boxHeight / 2`. A child row carrying its
 *   parent's extent, a tower's LoD dropped for a low block's LoD 0, or a
 *   basement extent under a ground face all reach it.
 *
 * Neither is milestone-introduced — `projectCityObjects` seeds from the same box
 * on the projected path — so they are the bbox-centre heuristic's own limit, and
 * closing them needs a real inside/outside test (signed volume, or consistency
 * across a closed shell) rather than a box centre. That is the follow-up in
 * `docs/roadmap.md`.
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
  fileExtents?: ReadonlyMap<string, BBox3>,
): void {
  for (const id of Object.keys(objects)) {
    const object = objects[id]!;
    let box: MutableBBox | null = enuBoxOfGeodeticBox(
      fileExtents?.get(id),
      frame,
      heightOffset,
    );
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
