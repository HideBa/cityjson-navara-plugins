/**
 * The ONE seam that turns a stream's decoded source coordinates into its
 * metric CRS (roadmap task 6 replaces it with a direct geographic → ENU path).
 *
 * - EPSG:6697 (PLATEAU: JGD2011 geographic, gravity-related heights in metres)
 *   goes into the WGS84 UTM zone of a centre chosen ONCE per open, so every
 *   batch a stream yields shares one metric frame.
 * - A metre-based EPSG passes through unchanged.
 * - Anything else throws `NonMetricCrsError` (navara-core's units gate).
 *
 * The 6697 path reproduces the app's `normalizeCityParquetCrs` (resident
 * layers) exactly, so a streamed and a resident copy of the same file line up:
 * WKB stores x = longitude, y = latitude (not the EPSG authority's axis
 * order); the source definition is `+proj=longlat +ellps=GRS80` (JGD2011 →
 * WGS84 is the metre-level null datum approximation); the zone is
 * `min(60, floor((lon + 180) / 6) + 1)`, north or south by the centre's
 * latitude; z is left alone (the renderer applies its EGM2008 geoid
 * approximation). A geographic CRS other than 6697 is refused because its
 * vertical units/datum cannot be trusted.
 *
 * Engine-free: no `@navaramap/*` imports.
 */

import type { BBox3, CityObject, Vec3 } from "@cityjson/navara-core";
import { NonMetricCrsError, assertMetricCrs } from "@cityjson/navara-core";
import proj4 from "proj4";
import { CityParquetError } from "./footer";

/** PLATEAU's compound geographic CRS (JGD2011 + JGD2011 height). */
const JGD2011_GEOGRAPHIC_3D = 6697;

/** proj4's spelling of JGD2011 geographic, as `normalizeCityParquetCrs` uses. */
const JGD2011_LONGLAT = "+proj=longlat +ellps=GRS80 +no_defs";

export interface CoordinateTarget {
  /** The EPSG code the source coordinates are in. */
  readonly sourceEpsg: number;
  /** The metric EPSG code `toTarget` produces (equal to `sourceEpsg` for a
   *  pass-through). */
  readonly epsg: number;
  toTarget(x: number, y: number): [number, number];
}

/** Throws unless (lon, lat) lies in the range the UTM zones are defined on. */
function validateLonLat(lon: number, lat: number): void {
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lon < -180 ||
    lon > 180 ||
    lat < -80 ||
    lat > 84
  ) {
    throw new CityParquetError(
      "Cannot project EPSG:6697 CityParquet coordinates: expected longitude/latitude within the UTM latitude range.",
    );
  }
}

/**
 * The metric target for `sourceEpsg`. For EPSG:6697 the UTM zone comes from
 * `lngLatCentre` — there is no metric answer without one, so a `null` centre
 * is refused like any other non-metric CRS.
 */
export function coordinateTargetFor(
  sourceEpsg: number,
  lngLatCentre: readonly [number, number] | null,
): CoordinateTarget {
  if (sourceEpsg === JGD2011_GEOGRAPHIC_3D) {
    if (lngLatCentre === null)
      throw new NonMetricCrsError(sourceEpsg, "degree");
    const [lon, lat] = lngLatCentre;
    validateLonLat(lon, lat);
    const zone = Math.min(60, Math.floor((lon + 180) / 6) + 1);
    const epsg = (lat >= 0 ? 32600 : 32700) + zone;
    // WGS84 UTM definitions are built into proj4; the converter is built once
    // and reused per vertex (building it is the expensive part).
    const converter = proj4(JGD2011_LONGLAT, `EPSG:${epsg}`);
    return {
      sourceEpsg,
      epsg,
      toTarget(x, y) {
        validateLonLat(x, y);
        const [px, py] = converter.forward([x, y]);
        if (!Number.isFinite(px) || !Number.isFinite(py)) {
          throw new CityParquetError(
            "Cannot project this CityParquet geometry into a metric coordinate system.",
          );
        }
        return [px!, py!];
      },
    };
  }
  assertMetricCrs(sourceEpsg);
  return { sourceEpsg, epsg: sourceEpsg, toTarget: (x, y) => [x, y] };
}

/** Whether `target` changes coordinates at all. */
export function isIdentityTarget(target: CoordinateTarget): boolean {
  return target.epsg === target.sourceEpsg;
}

type MutableBBox = [number, number, number, number, number, number];

function extend(
  box: MutableBBox | null,
  x: number,
  y: number,
  z: number,
): MutableBBox {
  if (box === null) return [x, y, z, x, y, z];
  if (x < box[0]) box[0] = x;
  if (y < box[1]) box[1] = y;
  if (z < box[2]) box[2] = z;
  if (x > box[3]) box[3] = x;
  if (y > box[4]) box[4] = y;
  if (z > box[5]) box[5] = z;
  return box;
}

/**
 * A source bbox's four horizontal corners, projected and re-boxed: a
 * projected rectangle is not axis-aligned, so two corners would under-bound.
 */
export function projectBBox(bbox: BBox3, target: CoordinateTarget): BBox3 {
  let box: MutableBBox | null = null;
  for (const x of [bbox[0], bbox[3]]) {
    for (const y of [bbox[1], bbox[4]]) {
      const [px, py] = target.toTarget(x, y);
      box = extend(box, px, py, bbox[2]);
      box = extend(box, px, py, bbox[5]);
    }
  }
  return box!;
}

/**
 * Projects every object's rings and bbox into `target`, replacing the entries
 * of `objects` in place (the objects themselves are immutable). An object's
 * new bbox covers its projected source bbox (kept for geometryless parents)
 * and every projected vertex. An identity target changes nothing.
 */
export function projectCityObjects(
  objects: Record<string, CityObject>,
  target: CoordinateTarget,
): void {
  if (isIdentityTarget(target)) return;
  for (const id of Object.keys(objects)) {
    const object = objects[id]!;
    let box: MutableBBox | null = object.bbox
      ? ([...projectBBox(object.bbox, target)] as MutableBBox)
      : null;
    const surfaces = object.surfaces.map((surface) => ({
      ...surface,
      rings: surface.rings.map((ring) =>
        ring.map((point): Vec3 => {
          const [x, y] = target.toTarget(point[0], point[1]);
          box = extend(box, x, y, point[2]);
          return [x, y, point[2]];
        }),
      ),
    }));
    objects[id] = { ...object, surfaces, bbox: box };
  }
}
