/**
 * Computed geometric metrics for a single roof surface.
 * Derived from Surface.rings polygon geometry.
 */

export interface RoofMetrics {
  /** Polygon area in model units squared (typically m²). */
  readonly areaSqM: number;
  /** Inclination from horizontal in degrees. 0=flat roof, 90=vertical wall. */
  readonly inclinationDeg: number;
  /**
   * Compass bearing the surface faces in degrees. 0=N, 90=E, 180=S, 270=W.
   *
   * `null` when the surface has NO ASPECT — a degenerate ring, or an
   * inclination below `FLAT_INCLINATION_DEG`. A consumer must not read that as
   * north: below that tilt the bearing would be the frame's, not the roof's
   * (see `computeAzimuth`).
   */
  readonly azimuthDeg: number | null;
  /** Minimum elevation (Z coordinate) of the surface in model units. */
  readonly elevationM: number;
}
