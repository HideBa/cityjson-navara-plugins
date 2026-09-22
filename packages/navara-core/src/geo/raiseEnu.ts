/**
 * Re-place already-projected local-ENU positions after a change of the
 * vertical-datum offset, without going back to source coordinates.
 *
 * `projectPositionsToEnu` adds `heightOffset` to every vertex's geodetic
 * height and the frame origin carries the same offset. Changing it by `dh`
 * therefore moves, in ECEF:
 *  - the frame origin by `dh · up₀` (its rotation depends only on the origin's
 *    lng/lat, so it is unchanged), and
 *  - each vertex by `dh · n` along ITS OWN ellipsoid normal `n`
 *    (d ECEF / d height is exactly the unit normal).
 * In the frame that is `p' = p + dh · (Rᵀ·n − ẑ)`: not zero — the normals fan
 * out, so moving only the frame is ~N·d/R off (6 cm at 10 km for Tokyo's
 * N ≈ 37 m) — but no proj4 call and no re-triangulation.
 *
 * `n` is the geodetic normal: the ellipsoid gradient at the vertex's foot
 * point, found without trigonometry (see the loop). Positions are read and
 * re-stored as Float32, so a raise lands within two Float32 roundings of a
 * fresh projection (≈1 mm at 10 km, ≈1e-7 m at 1 m).
 */

import type { EnuFrame } from "./enuFrame";

const A = 6378137.0;
const F = 1 / 298.257223563;
const B = A * (1 - F);
const INV_A2 = 1 / (A * A);
const INV_B2 = 1 / (B * B);

/**
 * In place: `positions` are local ENU metres in `frame`, which was built with
 * the CURRENT height offset; afterwards they are the positions a projection
 * at `current + deltaHeight` into the correspondingly raised frame produces.
 */
export function raisePositionsInEnu(
  positions: Float32Array,
  frame: EnuFrame,
  deltaHeight: number,
): Float32Array {
  if (deltaHeight === 0) return positions;
  const m = frame.matrix;
  // Columns: east (0..2), north (4..6), up (8..10), origin (12..14).
  const ex = m[0]!, ey = m[1]!, ez = m[2]!;
  const nx = m[4]!, ny = m[5]!, nz = m[6]!;
  const ux = m[8]!, uy = m[9]!, uz = m[10]!;
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  for (let i = 0; i < positions.length; i += 3) {
    const e = positions[i]!;
    const n = positions[i + 1]!;
    const u = positions[i + 2]!;
    const X = tx + ex * e + nx * n + ux * u;
    const Y = ty + ey * e + ny * n + uy * u;
    const Z = tz + ez * e + nz * n + uz * u;
    // The geodetic normal is the ellipsoid gradient at the FOOT point, not at
    // the vertex (at 100 m up they differ by ~e²·h/a rad — µm after scaling
    // by dh, which is many Float32 steps near the origin; Codex review). So:
    // gradient at the vertex -> height from the ellipsoid equation
    // (f ≈ 2·h·|g|) -> step down to the foot -> gradient there. The residual
    // angle is second order (~h·1e-7/a), far below Float32 anywhere.
    // sqrt, not Math.hypot: hypot's overflow guard is ~5x slower in V8, and
    // these magnitudes (~1e-7) cannot overflow.
    const px = X * INV_A2;
    const py = Y * INV_A2;
    const pz = Z * INV_B2;
    const pLen = Math.sqrt(px * px + py * py + pz * pz);
    const h = (X * px + Y * py + Z * pz - 1) / (2 * pLen);
    const k = h / pLen;
    const gx = (X - k * px) * INV_A2;
    const gy = (Y - k * py) * INV_A2;
    const gz = (Z - k * pz) * INV_B2;
    const s = deltaHeight / Math.sqrt(gx * gx + gy * gy + gz * gz);
    // dh·(Rᵀn − ẑ): the up component subtracts the origin's own rise.
    positions[i] = e + s * (ex * gx + ey * gy + ez * gz);
    positions[i + 1] = n + s * (nx * gx + ny * gy + nz * gz);
    positions[i + 2] =
      u + (s * (ux * gx + uy * gy + uz * gz) - deltaHeight);
  }
  return positions;
}
