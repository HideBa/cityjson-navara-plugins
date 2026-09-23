/**
 * The "bucket" frame: one closed-form local metric transform about a dataset
 * centre, pinned so that every user computes the same numbers.
 *
 *     x = (lambda - lambda0) * pi/180 * N(phi0) * cos(phi0)
 *     y = (phi    - phi0)    * pi/180 * M(phi0)
 *
 * with `N` the WGS84 prime-vertical radius and `M` the meridional radius of
 * curvature at the centre latitude `phi0`. The inverse is the algebraic
 * inverse — two divisions.
 *
 * ## This is an INDEX space, never geometry
 *
 * It exists so that the family index, the tile grid, the camera footprint and
 * a cell's centre can all be expressed in metres about one origin, cheaply and
 * without proj4. All it has to be is invertible and IDENTICAL for every user:
 * a box query and the cell it selects must agree, and that holds for any
 * consistent linear map.
 *
 * It is NOT ENU and must never be used to place a vertex. Its y = 0 line is a
 * parallel, not a geodesic, and it ignores the tangent plane's fall-away
 * entirely: 15 km east of the origin it disagrees with true ENU by 12.6 m
 * horizontally and 17.6 m vertically, and 15 km out on the diagonal by 28.2 m
 * horizontally (pinned in `localMetricFrame.test.ts`). Across one stream cell
 * (50-400 m) the same error is about 3 mm, which is why render geometry is
 * baked in the cell's own ENU frame (`makeEnuFrame`) and only the INDEX lives
 * here.
 *
 * ## The descriptor
 *
 * Functions cannot cross `postMessage`, so the frame's identity travels as a
 * plain, `structuredClone`-able, tagged descriptor holding just the origin;
 * each side rebuilds the transforms from it with this module's one formula.
 * The derived scales are deliberately NOT in the descriptor: a descriptor that
 * carried them could arrive disagreeing with its own origin.
 */
import { WGS84_A, WGS84_E2 } from "./enuFrame";

/** The wire form of a bucket frame: plain data, `structuredClone`-able. */
export interface LocalMetricFrameDescriptor {
  /** Tag, so a consumer can tell this apart from another frame kind. */
  readonly kind: "local-metric";
  /** Centre longitude in degrees (`lambda0`). */
  readonly lngDeg: number;
  /** Centre latitude in degrees (`phi0`). */
  readonly latDeg: number;
}

export interface LocalMetricFrame {
  /** Send THIS across a `postMessage` boundary, not the frame. */
  readonly descriptor: LocalMetricFrameDescriptor;
  /** `pi/180 * N(phi0) * cos(phi0)`: metres per degree of longitude. */
  readonly metresPerDegreeLng: number;
  /** `pi/180 * M(phi0)`: metres per degree of latitude. */
  readonly metresPerDegreeLat: number;
  /** Geographic degrees -> bucket metres, east/north from the centre. */
  toMetric(lngDeg: number, latDeg: number): [number, number];
  /** Bucket metres -> geographic degrees. The algebraic inverse. */
  toLngLat(x: number, y: number): [number, number];
}

const DEG = Math.PI / 180;

/**
 * Past +/-89.9 degrees `cos(phi0)` collapses and the longitude scale with it,
 * so the map stops being invertible in any useful sense. No city dataset lives
 * there, and a silently singular index would be far worse than a refusal.
 */
const MAX_ABS_LAT = 89.9;

function assertUsableCentre(lngDeg: number, latDeg: number): void {
  if (!Number.isFinite(lngDeg) || !Number.isFinite(latDeg)) {
    throw new RangeError(
      `A local metric frame needs a finite centre; got longitude ${String(lngDeg)}, latitude ${String(latDeg)}.`,
    );
  }
  if (Math.abs(latDeg) > MAX_ABS_LAT) {
    throw new RangeError(
      `A local metric frame is not invertible at latitude ${String(latDeg)}; it is defined within +/-${String(MAX_ABS_LAT)} degrees.`,
    );
  }
}

/**
 * The bucket frame about `(lngDeg, latDeg)`. Build it once per dataset and
 * share it (or its {@link LocalMetricFrame.descriptor}); it holds no state.
 */
export function makeLocalMetricFrame(
  lngDeg: number,
  latDeg: number,
): LocalMetricFrame {
  assertUsableCentre(lngDeg, latDeg);
  const phi0 = latDeg * DEG;
  const sinPhi = Math.sin(phi0);
  const w = 1 - WGS84_E2 * sinPhi * sinPhi;
  // Prime-vertical and meridional radii of curvature at phi0.
  const n = WGS84_A / Math.sqrt(w);
  const m = (WGS84_A * (1 - WGS84_E2)) / (w * Math.sqrt(w));
  const metresPerDegreeLng = DEG * n * Math.cos(phi0);
  const metresPerDegreeLat = DEG * m;
  return {
    descriptor: { kind: "local-metric", lngDeg, latDeg },
    metresPerDegreeLng,
    metresPerDegreeLat,
    toMetric(lng, lat) {
      return [
        (lng - lngDeg) * metresPerDegreeLng,
        (lat - latDeg) * metresPerDegreeLat,
      ];
    },
    toLngLat(x, y) {
      return [lngDeg + x / metresPerDegreeLng, latDeg + y / metresPerDegreeLat];
    },
  };
}

/**
 * Rebuilds the frame a descriptor names — the receiving end of a
 * `postMessage`. Same formula, same doubles, so the two sides bucket
 * identically.
 */
export function localMetricFrameFromDescriptor(
  descriptor: LocalMetricFrameDescriptor,
): LocalMetricFrame {
  return makeLocalMetricFrame(descriptor.lngDeg, descriptor.latDeg);
}
