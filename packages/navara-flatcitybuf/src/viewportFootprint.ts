/**
 * The ground area the camera can see, as a source-CRS AABB.
 *
 * Ported from the app's `src/features/streaming/viewportFootprint.ts`. Three
 * things changed, all of them the engine-coupled parts: the rays arrive as
 * ECEF pick rays (Navara's `getPickRay`, bound in `engineRays`) instead of
 * four unprojected NDC corners of a Three `PerspectiveCamera`; the ground
 * plane is the layer's ENU tangent plane through its frame origin instead of
 * a horizontal Three Y-plane (so `groundY` disappears — the frame's height
 * carries it); and the CRS step is `ecefToGeodetic` + a projection inverse
 * instead of `sceneToSource`. The T_MAX_M clamp, the EPS band, the
 * MAX_FOOTPRINT_SPAN_M rejection and the overflow-safe centre are unchanged.
 *
 * A tilted camera's far corners run toward the horizon, so each corner ray is
 * clamped to T_MAX_M. The camera's far plane is 50-200 km and is NOT a fetch
 * radius.
 *
 * Engine-free by construction (see the NODE_IMPORT_SAFE = false rule): the
 * rays are injected, so this module never imports `@navaramap/*`.
 */
import {
  ecefToEnu,
  ecefToGeodetic,
  enuToEcef,
  type EnuFrame,
} from "@cityjson/navara-core";
import { MAX_FOOTPRINT_SPAN_M, T_MAX_M } from "./constants";

/**
 * Exported so tests can assert a fixture's up-component actually falls inside
 * the EPS-excluded band, rather than hardcoding a copy that could drift.
 */
export const EPS = 1e-6;

/** A pick ray in ECEF metres. Structurally compatible with a Three `Ray`. */
export interface Ray {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

export interface Footprint {
  readonly bbox: [number, number, number, number];
  readonly span: number;
  readonly centre: [number, number];
}

export interface FootprintDeps {
  /** The four viewport corner rays, in ECEF. */
  readonly cornerRays: readonly [Ray, Ray, Ray, Ray];
  /** The layer's ENU frame; its z = 0 plane is the ground plane. */
  readonly frame: EnuFrame;
  /** Geodetic -> source CRS. Returns null when the point is unprojectable. */
  readonly toSourceXY: (
    lngDeg: number,
    latDeg: number,
  ) => readonly [number, number] | null;
}

/**
 * Rotate an ECEF direction into ENU.
 *
 * The frame's rotation block is orthonormal, so its inverse is its transpose;
 * applying it directly (rather than differencing two `ecefToEnu` points) keeps
 * the unit direction exact instead of recovering it from the cancellation of
 * two ~6.4e6 m coordinates, whose ~1e-9 residual is only three orders of
 * magnitude away from the EPS band this module branches on.
 */
function ecefDirToEnu(
  frame: EnuFrame,
  d: readonly [number, number, number],
): [number, number, number] {
  const m = frame.matrix;
  return [
    m[0]! * d[0] + m[1]! * d[1] + m[2]! * d[2],
    m[4]! * d[0] + m[5]! * d[1] + m[6]! * d[2],
    m[8]! * d[0] + m[9]! * d[1] + m[10]! * d[2],
  ];
}

export function viewportFootprint(deps: FootprintDeps): Footprint | null {
  const pts: Array<[number, number]> = [];

  for (const r of deps.cornerRays) {
    // Work in ENU: the ground plane is z = 0 there, so the intersection is
    // the same one-line test the Three version ran against its Y plane.
    const eye = ecefToEnu(deps.frame, r.origin);
    const raw = ecefDirToEnu(deps.frame, r.direction);
    // t is in metres, which only holds for a unit direction. `getPickRay`
    // returns a normalised Three Ray, but normalise anyway so a caller that
    // hands over an unnormalised direction gets the documented clamp rather
    // than a silently scaled one.
    const len = Math.hypot(raw[0], raw[1], raw[2]);
    if (len === 0 || !Number.isFinite(len)) return null;
    const dir: [number, number, number] = [
      raw[0] / len,
      raw[1] / len,
      raw[2] / len,
    ];

    let t = T_MAX_M;
    // Only intersect when the ray actually travels toward the plane.
    if (dir[2] < -EPS || (dir[2] > EPS && eye[2] < 0)) {
      const tHit = -eye[2] / dir[2];
      if (tHit > 0 && tHit <= T_MAX_M) t = tHit;
    }
    const hitEcef = enuToEcef(deps.frame, [
      eye[0] + dir[0] * t,
      eye[1] + dir[1] * t,
      eye[2] + dir[2] * t,
    ]);
    const g = ecefToGeodetic(hitEcef);
    const src = deps.toSourceXY(g.lngDeg, g.latDeg);
    if (!src || !Number.isFinite(src[0]) || !Number.isFinite(src[1])) {
      return null;
    }
    pts.push([src[0], src[1]]);
  }

  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const bbox: [number, number, number, number] = [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  ];
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
  if (!Number.isFinite(span) || span > MAX_FOOTPRINT_SPAN_M) return null;

  return {
    bbox,
    span,
    // Overflow-safe midpoint: (a + b) / 2 can overflow to Infinity when a and
    // b are large same-sign finite values, even though the true midpoint is
    // representable.
    centre: [
      bbox[0] + (bbox[2] - bbox[0]) / 2,
      bbox[1] + (bbox[3] - bbox[1]) / 2,
    ],
  };
}
