/**
 * Pure geometry computations for roof surface analysis.
 *
 * All functions operate on CityJSON coordinates:
 *   X = easting, Y = northing, Z = height
 *   "Up" vector is (0, 0, 1).
 *
 * No Three.js dependency — these are pure domain functions.
 */

import type { Surface, Vec3 } from "../citymodel/types";
import type { RoofMetrics } from "./types";

// ---------------------------------------------------------------------------
// Surface normal via Newell's method
// ---------------------------------------------------------------------------

/**
 * Compute the (unnormalized) surface normal of a 3D polygon using
 * Newell's method: sum of cross products of consecutive edge pairs.
 * The magnitude of the result equals twice the polygon area.
 */
function newellNormal(ring: ReadonlyArray<Vec3>): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;

  for (let i = 0; i < ring.length; i++) {
    const curr = ring[i]!;
    const next = ring[(i + 1) % ring.length]!;

    nx += (curr[1] - next[1]) * (curr[2] + next[2]);
    ny += (curr[2] - next[2]) * (curr[0] + next[0]);
    nz += (curr[0] - next[0]) * (curr[1] + next[1]);
  }

  return [nx, ny, nz];
}

function magnitude(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the unit surface normal of a 3D polygon in CityJSON Z-up space.
 */
export function computeSurfaceNormal(ring: ReadonlyArray<Vec3>): Vec3 {
  if (ring.length < 3) return [0, 0, 1];
  const n = newellNormal(ring);
  const mag = magnitude(n);
  if (mag === 0) return [0, 0, 1];
  return [n[0] / mag, n[1] / mag, n[2] / mag];
}

/**
 * Compute the area of a 3D polygon.
 * Uses Newell's method — half the magnitude of the summed cross products.
 */
export function computeArea(ring: ReadonlyArray<Vec3>): number {
  if (ring.length < 3) return 0;
  return magnitude(newellNormal(ring)) / 2;
}

/**
 * Compute the inclination (tilt) of a surface from horizontal.
 * Returns degrees: 0° = flat horizontal, 90° = vertical wall.
 */
export function computeInclination(ring: ReadonlyArray<Vec3>): number {
  if (ring.length < 3) return 0;

  const normal = newellNormal(ring);
  const mag = magnitude(normal);
  if (mag === 0) return 0;

  // acos(|nz| / mag) gives 0° for flat roof (normal == up), 90° for vertical wall
  const cosAngle = Math.min(1, Math.max(-1, Math.abs(normal[2]) / mag));
  return Math.acos(cosAngle) * (180 / Math.PI);
}

/**
 * Below this inclination a surface has NO ASPECT, and {@link computeAzimuth}
 * answers `null` rather than a bearing.
 *
 * It is a convention, not a precision claim. These functions read z as up and
 * x/y as east/north, so they measure a surface against whatever frame it
 * arrived in — and a level frame is tangent to the ellipsoid at exactly ONE
 * point. A surface of constant geodetic height therefore leans away from its
 * frame's origin by d/R: 0.0032° at 360 m, 0.0036° at a 400 m stream cell's
 * corner. Reading a compass bearing off that tilt turned the same roof into
 * 225° in one cell and 245° in another, and the milestone review measured a
 * 183° flip on a real one. The frame is an implementation detail; a roof's
 * orientation must not be.
 *
 * 0.1° sits between the two populations with well over an order of magnitude
 * of margin each way: about 30x the worst tangent-plane tilt a stream cell can
 * impose, and about 6x below the 0.57° of a 1-in-100 drainage fall — the
 * shallowest slope anything built has on purpose. The app's own existing
 * conventions agree from the other side: `aggregate.ts` and `computeStats.ts`
 * have always excluded surfaces under 1° from an azimuth average, and the
 * processing tool's flat-roof slider defaults to 5°.
 *
 * NOTE this does not save the STATIC path, whose frame spans the whole model:
 * at 15 km a flat roof's apparent inclination is 0.135°, past this threshold,
 * so it still gets a bearing. Anchoring static metrics per object is the
 * deferred milestone recorded in `docs/plans/2026-09-23-geographic-to-enu.md`.
 */
export const FLAT_INCLINATION_DEG = 0.1;

/** sin of the threshold: |horizontal| / |normal| is exactly sin(inclination). */
const FLAT_SIN = Math.sin((FLAT_INCLINATION_DEG * Math.PI) / 180);

/**
 * Compute the compass azimuth a surface faces.
 * Returns degrees: 0°=North, 90°=East, 180°=South, 270°=West.
 *
 * `null` when the surface has no aspect: a degenerate ring, or an inclination
 * below {@link FLAT_INCLINATION_DEG}. Null rather than 0, because 0 is due
 * north and a consumer has to be able to tell "faces north" from "faces
 * nowhere" — the old 0 quietly counted flat roofs as northerly.
 */
export function computeAzimuth(ring: ReadonlyArray<Vec3>): number | null {
  if (ring.length < 3) return null;

  const normal = newellNormal(ring);
  const mag = magnitude(normal);
  if (mag === 0) return null;

  // Ensure normal points outward (upward Z component).
  // CW-wound polygons produce a downward normal — flip the projection.
  const sign = normal[2] < 0 ? -1 : 1;
  const hx = sign * normal[0]; // easting component
  const hy = sign * normal[1]; // northing component
  const hMag = Math.sqrt(hx * hx + hy * hy);

  // Flat enough that the tilt is as likely the frame's as the roof's.
  if (hMag < FLAT_SIN * mag) return null;

  // atan2(easting, northing) gives geographic azimuth (0=N, 90=E)
  let azimuth = Math.atan2(hx, hy) * (180 / Math.PI);

  // Normalize to [0, 360)
  if (azimuth < 0) azimuth += 360;

  return azimuth;
}

/**
 * Compute the minimum elevation (Z coordinate) of a polygon ring.
 */
export function computeElevation(ring: ReadonlyArray<Vec3>): number {
  if (ring.length === 0) return 0;
  let min = ring[0]![2];
  for (let i = 1; i < ring.length; i++) {
    if (ring[i]![2] < min) min = ring[i]![2];
  }
  return min;
}

/**
 * Compute all roof metrics for a surface from its exterior ring.
 */
export function computeRoofMetrics(surface: Surface): RoofMetrics {
  const ring = surface.rings[0];
  if (!ring || ring.length < 3) {
    return { areaSqM: 0, inclinationDeg: 0, azimuthDeg: null, elevationM: 0 };
  }

  return {
    areaSqM: computeArea(ring),
    inclinationDeg: computeInclination(ring),
    azimuthDeg: computeAzimuth(ring),
    elevationM: computeElevation(ring),
  };
}
