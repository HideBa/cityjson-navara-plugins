/**
 * The ONE seam that says what a stream's coordinates ARE: its source CRS, and
 * the space its index is expressed in.
 *
 * Two spaces, chosen by the caller:
 *
 * - `"projected"` — the original: EPSG:6697 (PLATEAU: JGD2011 geographic,
 *   gravity-related heights in metres) goes into the WGS84 UTM zone of a centre
 *   chosen ONCE per open, so every batch a stream yields shares one metric
 *   frame. This is what the resident (non-streamed) path still does.
 * - `"bucket"` — what the STREAMED path uses: EPSG:6697 goes into navara-core's
 *   pinned local metric frame about that same centre, by arithmetic, with no
 *   proj4 at all. The frame is an INDEX space, not geometry (see
 *   `localMetricFrame.ts`): rings stay geographic and the worker converts each
 *   cell into its own ENU frame. No EPSG code names such a frame, so the target
 *   reports `epsg: null` and carries the frame's serialisable descriptor.
 *
 * In both spaces:
 *
 * - A metre-based EPSG passes through unchanged (`"bucket"` changes NOTHING for
 *   a projected source — same identity target, same numbers).
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

import type {
  BBox3,
  CityObject,
  LocalMetricFrameDescriptor,
  Vec3,
} from "@cityjson/navara-core";
import {
  NonMetricCrsError,
  assertMetricCrs,
  makeLocalMetricFrame,
} from "@cityjson/navara-core";
import proj4 from "proj4";
import { CityParquetError } from "./footer";

/** PLATEAU's compound geographic CRS (JGD2011 + JGD2011 height). */
const JGD2011_GEOGRAPHIC_3D = 6697;

/** proj4's spelling of JGD2011 geographic, as `normalizeCityParquetCrs` uses. */
const JGD2011_LONGLAT = "+proj=longlat +ellps=GRS80 +no_defs";

/** Which space a geographic source's coordinates are taken into. */
export type CoordinateSpace =
  /** A WGS84 UTM zone, through proj4 (the resident path's answer). */
  | "projected"
  /** navara-core's pinned local metric frame, by arithmetic (the stream's). */
  | "bucket";

export interface CoordinateTarget {
  /** The EPSG code the source coordinates are in. */
  readonly sourceEpsg: number;
  /** The metric EPSG code `toTarget` produces (equal to `sourceEpsg` for a
   *  pass-through), or `null` when it produces BUCKET metres — no EPSG code
   *  names a local metric frame. */
  readonly epsg: number | null;
  /** The bucket frame `toTarget` maps into, as its `structuredClone`-able
   *  descriptor; `null` exactly when {@link epsg} is set. Non-null means the
   *  coordinates it produces are an INDEX, never geometry. */
  readonly frame: LocalMetricFrameDescriptor | null;
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
 * Throws unless (lon, lat) is a longitude/latitude pair at all. The bucket
 * frame has no zones, so it is defined wherever the globe is (its own
 * near-pole refusal lives in `makeLocalMetricFrame`) — but a value that is not
 * a coordinate must still not become a silent origin.
 */
function validateGeographic(lon: number, lat: number): void {
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lon < -180 ||
    lon > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    throw new CityParquetError(
      "Cannot place EPSG:6697 CityParquet coordinates: expected a longitude/latitude pair.",
    );
  }
}

/**
 * The target for `sourceEpsg` in `space`. For EPSG:6697 both spaces are built
 * about `lngLatCentre` — there is no metric answer without one, so a `null`
 * centre is refused like any other non-metric CRS. A metric `sourceEpsg`
 * ignores `space` entirely: it is already the answer.
 */
export function coordinateTargetFor(
  sourceEpsg: number,
  lngLatCentre: readonly [number, number] | null,
  space: CoordinateSpace = "projected",
): CoordinateTarget {
  if (sourceEpsg === JGD2011_GEOGRAPHIC_3D) {
    if (lngLatCentre === null)
      throw new NonMetricCrsError(sourceEpsg, "degree");
    const [lon, lat] = lngLatCentre;
    if (space === "bucket") {
      validateGeographic(lon, lat);
      const frame = makeLocalMetricFrame(lon, lat);
      return {
        sourceEpsg,
        epsg: null,
        frame: frame.descriptor,
        // Two multiplications and two subtractions, and the SAME ones every
        // other user of this frame performs.
        toTarget: (x, y) => frame.toMetric(x, y),
      };
    }
    validateLonLat(lon, lat);
    const zone = Math.min(60, Math.floor((lon + 180) / 6) + 1);
    const epsg = (lat >= 0 ? 32600 : 32700) + zone;
    // WGS84 UTM definitions are built into proj4; the converter is built once
    // and reused per vertex (building it is the expensive part).
    const converter = proj4(JGD2011_LONGLAT, `EPSG:${epsg}`);
    return {
      sourceEpsg,
      epsg,
      frame: null,
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
  return {
    sourceEpsg,
    epsg: sourceEpsg,
    frame: null,
    toTarget: (x, y) => [x, y],
  };
}

/** Whether `target` changes coordinates at all. */
export function isIdentityTarget(target: CoordinateTarget): boolean {
  return target.epsg === target.sourceEpsg;
}

/**
 * Whether `target` maps into a bucket frame rather than a metric CRS. Its
 * output is an INDEX: a caller that places geometry must convert the source
 * coordinates itself (per cell, into that cell's ENU frame), which is why the
 * stream reader leaves rings alone for such a target.
 */
export function isBucketTarget(target: CoordinateTarget): boolean {
  return target.frame !== null;
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
 *
 * REFUSES a bucket target: its output is an INDEX, and writing it into rings
 * would place geometry tens of metres out with nothing downstream able to tell.
 * `isIdentityTarget` cannot catch that — for a bucket target it is false
 * (`epsg: null` !== `sourceEpsg: 6697`), so this function would run. Rings of a
 * bucket-space stream are converted per CELL, into that cell's own ENU frame
 * (`geodeticRingsToEnu`), by the worker.
 */
export function projectCityObjects(
  objects: Record<string, CityObject>,
  target: CoordinateTarget,
): void {
  if (isBucketTarget(target)) {
    throw new CityParquetError(
      "Cannot project CityParquet geometry into a bucket frame: bucket metres are an index, not geometry. Convert each cell's rings into that cell's ENU frame instead.",
    );
  }
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
