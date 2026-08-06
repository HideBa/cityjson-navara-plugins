/**
 * Structural edges of a city mesh: the line segments a hidden-line or
 * cartoon-ink look draws, extracted from the same non-indexed triangle soup the
 * renderer already holds.
 *
 * Not `material.wireframe`: that draws EVERY triangle edge, so a triangulated
 * roof reads as a fan of diagonals. An edge is emitted only when it is
 *
 * - a BOUNDARY edge, used by exactly one triangle (a free border, a hole rim,
 *   the rim of an open shell), or
 * - a CREASE edge, where two adjacent faces fold by more than the threshold.
 *
 * The soup is expected post-ENU-projection, so the segments come out in the
 * same render space as the mesh's own positions and need no second transform.
 *
 * Engine-free and O(triangles): one pass, one Map keyed by the edge's quantized
 * endpoint pair.
 */

/** Default fold angle, in degrees, above which a shared edge is a crease.
 *  25° keeps building corners and roof ridges while dropping the near-planar
 *  seams a triangulator leaves inside one polygon. */
export const DEFAULT_EDGE_ANGLE_DEG = 25;

/** Endpoint quantization: 0.1 mm. Two triangles that name the same corner with
 *  float32 coordinates rarely name it bit-identically, and an unmerged edge
 *  would be counted as two boundary edges and drawn twice. */
const QUANT = 1e4;

/** Below this cross-product length a triangle has no usable normal (coincident
 *  or collinear vertices). Absolute, not relative: positions are ENU metres,
 *  and a genuine sliver of 0.1 mm x 0.1 mm still measures 1e-8 here. */
const DEGENERATE_CROSS = 1e-12;

/** Coplanarity tolerance in COSINE space. Two exactly coplanar faces come back
 *  with a dot product of 1 - O(1e-8) rather than 1, and `acos` is at its worst
 *  conditioning there — so a bare `angle > threshold` would promote float noise
 *  to a crease at low thresholds and draw every triangulation seam. Subtracting
 *  it moves the effective threshold by ~1e-6 rad, which is nothing. */
const COS_EPS = 1e-6;

interface EdgeRecord {
  /** The first triangle's own (unquantized) endpoints, in the key's order, so
   *  the drawn segment lands exactly on the geometry. */
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly n0x: number;
  readonly n0y: number;
  readonly n0z: number;
  n1x: number;
  n1y: number;
  n1z: number;
  faces: number;
  crease: boolean;
  /** Normals from the THIRD adjacent face on, flat. Non-manifold edges are rare
   *  in real data but do occur (T-junctions), so the allocation is paid only
   *  where it happens. */
  extra: number[] | null;
}

const quantize = (v: number) => Math.round(v * QUANT);

/**
 * Line-segment endpoints for the structural edges of `positions`.
 *
 * @param positions non-indexed triangle soup, 9 floats per triangle.
 * @param angleThresholdDeg fold angle above which a shared edge is a crease.
 * @returns 6 floats per segment (x1,y1,z1, x2,y2,z2).
 */
export function buildCityEdgeSegments(
  positions: Float32Array,
  angleThresholdDeg: number = DEFAULT_EDGE_ANGLE_DEG,
): Float32Array {
  const triangleCount = Math.floor(positions.length / 9);
  if (triangleCount === 0) return new Float32Array(0);

  const cosThreshold =
    Math.cos((Math.min(Math.max(angleThresholdDeg, 0), 180) * Math.PI) / 180) -
    COS_EPS;
  const edges = new Map<string, EdgeRecord>();

  for (let t = 0; t < triangleCount; t++) {
    const i = t * 9;
    const ax = positions[i]!;
    const ay = positions[i + 1]!;
    const az = positions[i + 2]!;
    const bx = positions[i + 3]!;
    const by = positions[i + 4]!;
    const bz = positions[i + 5]!;
    const cx = positions[i + 6]!;
    const cy = positions[i + 7]!;
    const cz = positions[i + 8]!;

    // (b-a) x (c-a): the face normal, unnormalized. Its length is twice the
    // triangle's area, which is also the degeneracy test.
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    // A zero-area triangle has no orientation to compare against, and its three
    // "edges" are two coincident points and a doubled segment. It contributes
    // nothing — including no boundary edges.
    if (len <= DEGENERATE_CROSS) continue;
    nx /= len;
    ny /= len;
    nz /= len;

    addEdge(edges, cosThreshold, ax, ay, az, bx, by, bz, nx, ny, nz);
    addEdge(edges, cosThreshold, bx, by, bz, cx, cy, cz, nx, ny, nz);
    addEdge(edges, cosThreshold, cx, cy, cz, ax, ay, az, nx, ny, nz);
  }

  const kept: EdgeRecord[] = [];
  for (const edge of edges.values()) {
    if (edge.faces === 1 || edge.crease) kept.push(edge);
  }

  const out = new Float32Array(kept.length * 6);
  for (let k = 0; k < kept.length; k++) {
    const e = kept[k]!;
    const o = k * 6;
    out[o] = e.ax;
    out[o + 1] = e.ay;
    out[o + 2] = e.az;
    out[o + 3] = e.bx;
    out[o + 4] = e.by;
    out[o + 5] = e.bz;
  }
  return out;
}

/**
 * Record one directed triangle edge against its undirected identity.
 *
 * The key sorts the two quantized endpoints, so the same edge traversed in
 * opposite directions by two adjacent triangles lands on one record — which is
 * the whole point: a shared edge that failed to merge would look like two
 * boundary edges and always be drawn.
 */
function addEdge(
  edges: Map<string, EdgeRecord>,
  cosThreshold: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  nx: number,
  ny: number,
  nz: number,
): void {
  const qax = quantize(ax);
  const qay = quantize(ay);
  const qaz = quantize(az);
  const qbx = quantize(bx);
  const qby = quantize(by);
  const qbz = quantize(bz);
  const aFirst =
    qax < qbx ||
    (qax === qbx && (qay < qby || (qay === qby && qaz <= qbz)));
  const key = aFirst
    ? `${qax},${qay},${qaz}|${qbx},${qby},${qbz}`
    : `${qbx},${qby},${qbz}|${qax},${qay},${qaz}`;

  const existing = edges.get(key);
  if (!existing) {
    edges.set(
      key,
      aFirst
        ? {
            ax, ay, az, bx, by, bz,
            n0x: nx, n0y: ny, n0z: nz,
            n1x: 0, n1y: 0, n1z: 0,
            faces: 1,
            crease: false,
            extra: null,
          }
        : {
            ax: bx, ay: by, az: bz, bx: ax, by: ay, bz: az,
            n0x: nx, n0y: ny, n0z: nz,
            n1x: 0, n1y: 0, n1z: 0,
            faces: 1,
            crease: false,
            extra: null,
          },
    );
    return;
  }

  // A crease is decided pairwise and latched: with more than two adjacent
  // faces (a T-junction), ANY folded pair makes the edge structural, and one
  // coplanar pair among them must not un-decide it.
  const folds = (px: number, py: number, pz: number) =>
    nx * px + ny * py + nz * pz < cosThreshold;
  if (folds(existing.n0x, existing.n0y, existing.n0z)) existing.crease = true;
  if (existing.faces >= 2) {
    if (folds(existing.n1x, existing.n1y, existing.n1z)) existing.crease = true;
    const extra = existing.extra;
    if (extra) {
      for (let i = 0; i < extra.length; i += 3) {
        if (folds(extra[i]!, extra[i + 1]!, extra[i + 2]!)) {
          existing.crease = true;
        }
      }
    }
    (existing.extra ??= []).push(nx, ny, nz);
  } else {
    existing.n1x = nx;
    existing.n1y = ny;
    existing.n1z = nz;
  }
  existing.faces++;
}
