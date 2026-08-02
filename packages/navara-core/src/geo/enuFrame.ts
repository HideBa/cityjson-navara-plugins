/**
 * WGS84 geodetic <-> ECEF <-> local ENU. Replaces the retired
 * `src/features/streaming/sceneTransform.ts`, whose `R·v = (v.x, v.z, −v.y)`
 * existed only because Three meshes were rotated −π/2 about X to fake Z-up.
 * Navara's ENU frame is already x=east, y=north, z=up, which is exactly
 * CityJSON's axis order — so the local->frame step is the identity and the
 * only transform left is the frame matrix itself.
 */
const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const B = A * (1 - F);
const EP2 = (A * A - B * B) / (B * B);

export interface EnuFrame {
  readonly lngDeg: number;
  readonly latDeg: number;
  readonly heightM: number;
  readonly originEcef: readonly [number, number, number];
  /** Column-major 4x4, ENU(metres) -> ECEF(metres). */
  readonly matrix: Float64Array;
}

export function geodeticToEcef(
  lngDeg: number,
  latDeg: number,
  heightM: number,
): [number, number, number] {
  const lam = (lngDeg * Math.PI) / 180;
  const phi = (latDeg * Math.PI) / 180;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const n = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  return [
    (n + heightM) * cosPhi * Math.cos(lam),
    (n + heightM) * cosPhi * Math.sin(lam),
    (n * (1 - E2) + heightM) * sinPhi,
  ];
}

/** Bowring's closed-form inverse: no iteration, sub-mm for terrestrial heights. */
export function ecefToGeodetic(p: readonly [number, number, number]): {
  lngDeg: number;
  latDeg: number;
  heightM: number;
} {
  const [x, y, z] = p;
  const r = Math.hypot(x, y);
  const theta = Math.atan2(z * A, r * B);
  const phi = Math.atan2(
    z + EP2 * B * Math.sin(theta) ** 3,
    r - E2 * A * Math.cos(theta) ** 3,
  );
  const sinPhi = Math.sin(phi);
  const n = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  return {
    lngDeg: (Math.atan2(y, x) * 180) / Math.PI,
    latDeg: (phi * 180) / Math.PI,
    heightM: r / Math.cos(phi) - n,
  };
}

export function makeEnuFrame(
  lngDeg: number,
  latDeg: number,
  heightM: number,
): EnuFrame {
  const originEcef = geodeticToEcef(lngDeg, latDeg, heightM);
  const lam = (lngDeg * Math.PI) / 180;
  const phi = (latDeg * Math.PI) / 180;
  const sl = Math.sin(lam);
  const cl = Math.cos(lam);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  // Columns: east, north, up, translation (column-major, Three-compatible).
  const matrix = new Float64Array([
    -sl,
    cl,
    0,
    0,
    -sp * cl,
    -sp * sl,
    cp,
    0,
    cp * cl,
    cp * sl,
    sp,
    0,
    originEcef[0],
    originEcef[1],
    originEcef[2],
    1,
  ]);
  return { lngDeg, latDeg, heightM, originEcef, matrix };
}

export function enuToEcef(
  frame: EnuFrame,
  v: readonly [number, number, number],
): [number, number, number] {
  const m = frame.matrix;
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]!,
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]!,
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]!,
  ];
}

export function ecefToEnu(
  frame: EnuFrame,
  p: readonly [number, number, number],
): [number, number, number] {
  const m = frame.matrix;
  const dx = p[0] - m[12]!;
  const dy = p[1] - m[13]!;
  const dz = p[2] - m[14]!;
  // The rotation block is orthonormal, so the inverse is its transpose.
  return [
    m[0]! * dx + m[1]! * dy + m[2]! * dz,
    m[4]! * dx + m[5]! * dy + m[6]! * dz,
    m[8]! * dx + m[9]! * dy + m[10]! * dz,
  ];
}
