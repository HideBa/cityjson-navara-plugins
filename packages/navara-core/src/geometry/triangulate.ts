/**
 * One polygon surface (exterior ring plus holes) to triangles, in the
 * coordinates its rings are in: orient the exterior against the object's box,
 * project onto the surface's plane, rewind holes against the exterior, and
 * ear-cut. Shared by `buildCityMeshArrays` and the cell bake.
 *
 * `three` is used only for its pure-math polygon helpers (`ShapeUtils`,
 * `Vector2`) — no renderer, no GPU resources.
 */

import { ShapeUtils, Vector2 } from "three";
import type { BBox3, UV, Vec3 } from "../citymodel/types";

export interface SurfaceTriangulation {
  readonly vertices: ReadonlyArray<Vec3>;
  readonly triangles: ReadonlyArray<readonly [number, number, number]>;
  /** Paired with `vertices`, present when the surface was textured. */
  readonly uvs: ReadonlyArray<UV> | null;
}

/**
 * `uvRings`, when given, pairs with `rings` one UV per vertex; the returned
 * `uvs` pair with `vertices` the same way. Every ring reversal below —
 * the exterior's orientation flip and a hole's winding fix — is applied to
 * the UV ring by the SAME decision, so a texture never mirrors on a face
 * whose vertices were reordered. A UV ring that does not match its vertex
 * ring in length is dropped (the surface renders untextured).
 */
export function triangulateSurface(
  rings: ReadonlyArray<ReadonlyArray<Vec3>>,
  objectBBox: BBox3 | null,
  uvRings: ReadonlyArray<ReadonlyArray<UV>> | null = null,
): SurfaceTriangulation | null {
  if (rings.length === 0) return null;

  let uvs: ReadonlyArray<ReadonlyArray<UV>> | null =
    uvRings !== null &&
    uvRings.length === rings.length &&
    uvRings.every((uvRing, i) => uvRing.length === rings[i]!.length)
      ? uvRings
      : null;

  const exteriorRaw = rings[0];
  const exteriorRing = orientExteriorRing(exteriorRaw, objectBBox);
  if (!exteriorRing || exteriorRing.length < 3) return null;
  const exteriorReversed = exteriorRing !== exteriorRaw;
  const exteriorUvs = uvs
    ? exteriorReversed
      ? [...uvs[0]!].reverse()
      : uvs[0]!
    : null;

  const normal = computeNewellNormal(exteriorRing);
  const normalLength = Math.hypot(normal[0], normal[1], normal[2]);
  if (normalLength === 0) return null;

  const basis = buildProjectionBasis(exteriorRing, [
    normal[0] / normalLength,
    normal[1] / normalLength,
    normal[2] / normalLength,
  ]);
  if (!basis) return null;

  const projectedContour = projectRingTo2D(exteriorRing, basis);
  const contourClockwise = ShapeUtils.isClockWise([...projectedContour]);

  const holeIndices: number[] = [];
  for (let i = 1; i < rings.length; i++) {
    if (rings[i]!.length >= 3) holeIndices.push(i);
  }
  const holeRings = holeIndices.map((i) => [...rings[i]!]);
  const holeUvs: UV[][] | null = uvs
    ? holeIndices.map((i) => [...uvs![i]!])
    : null;
  const projectedHoles = holeRings.map((ring, h) => {
    const projectedHole = projectRingTo2D(ring, basis);
    const holeClockwise = ShapeUtils.isClockWise([...projectedHole]);
    if (holeClockwise !== contourClockwise) return projectedHole;
    // The hole is rewound for the triangulator, and `triangulateShape`
    // returns indices into the concatenated contour + holes it was GIVEN —
    // so the 3D ring and its UVs are reversed alongside the 2D projection,
    // or every triangle touching the hole would read vertex n-1-k for k.
    // (Before 2026-09-03 only the projection was reversed; courtyard
    // buildings rendered with triangles spanning the hole.)
    if (holeUvs) holeUvs[h] = [...holeUvs[h]!].reverse();
    holeRings[h] = [...ring].reverse();
    return [...projectedHole].reverse();
  });

  const vertices = [exteriorRing, ...holeRings].flat();
  if (exteriorUvs && holeUvs) {
    uvs = [exteriorUvs, ...holeUvs];
  } else {
    uvs = null;
  }
  const triangles = ShapeUtils.triangulateShape(
    [...projectedContour],
    projectedHoles.map((hole) => [...hole]),
  ).map(
    (triangle) =>
      [triangle[0]!, triangle[1]!, triangle[2]!] as const satisfies readonly [
        number,
        number,
        number,
      ],
  );

  return { vertices, triangles, uvs: uvs ? uvs.flat() : null };
}

/**
 * How far off its own plane the bbox centre must sit before it counts as an
 * inside/outside reference, as a fraction of the object's bbox diagonal.
 *
 * The heuristic below reverses a face whose normal points AT the object's bbox
 * centre. That reads "the centre is inside, the normal must point away from
 * it" — which only says anything when the centre is off the face's plane. For
 * an object that IS one planar face (an LoD-filtered roof-only bake, a bare
 * LoD 0 footprint) the centre lies IN that plane, and all that survives is
 * numerical residue whose sign is arbitrary. Measured: an upward-wound flat
 * roof baked alone from a geographic source came out with normal z = -1 where
 * the same roof with its ground surface present came out +1.
 *
 * This is a BACKSTOP, not the reference. The reference an object is supposed to
 * be judged against is its own FILE ROW box — the whole building, including the
 * surfaces a LoD filter dropped before the bake — which is what
 * `projectCityObjects` seeds on the projected path and what `geodeticRingsToEnu`
 * seeds from `fileExtents` on the streamed geographic one. That box carries a
 * precondition of its own: it is a reference only while it puts the face clearly
 * on ONE side of its centre.
 *
 * The floor below covers one shape and one only: an object that is ONE planar
 * face. It does NOT cover two or more faces in the same near-plane, which hand
 * each other a reference far above the floor — a two-part LoD 0 footprint whose
 * parts differ in height by more than 2.5e-4 of the box diagonal (2.2 cm over
 * 40 m) still has its upper part inverted. That happens in three ways, none of
 * them only the null-bbox path: no box at all (a CityParquet child row whose
 * bbox columns are null), a VALID but z-degenerate or near-flat box (a table
 * whose only geometry is LoD 0 footprints has one legitimately, and
 * `invalidBBoxRows` stays 0), or a box far TALLER than the geometry the read kept
 * (a roof at 8 m inside a 0..40 m row box inverts, at exactly `boxHeight / 2`).
 * All three are pinned in `tests/geo/geodeticRingsToEnu.test.ts`, and none is
 * milestone-introduced: the projected path seeds from the same box. Widening the
 * fix means judging the box's degeneracy rather than one face's offset within it,
 * and closing the class means a real inside/outside test (signed volume, or
 * consistency across a closed shell) — the follow-up in `docs/roadmap.md`.
 *
 * 2.5e-4 sits between the two populations with about an order of magnitude of
 * margin on each side, measured on the streamed geographic path:
 *
 * - noise: |toFace . n| / diagonal is 1.5e-6 for a 110 m roof at a cell origin
 *   and 2.0e-5 for the same roof ~700 m out (already past any real cell plus
 *   family overhang) — the residue of a constant geodetic height sagging away
 *   from the cell's tangent plane. For a symmetric ring it collapses to pure
 *   rounding, 2e-12.
 * - real references: 1.0e-1 for a 30 m building, 1.0e-2 for a 3 m storey, and
 *   3.4e-3 for a deliberately pathological 1 m-tall slab 150 m across.
 *
 * Erring high is the safe direction, in the sense of DETERMINISTIC and
 * SPEC-CONFORMANT rather than of correct: refusing a flip leaves the file's own
 * winding, which CityJSON specifies as counter-clockwise seen from outside — and
 * real CityJSON does get that wrong on the faces this heuristic exists for
 * (`docs/architecture-notes.md:21`). A refused flip is therefore the file's
 * answer, right or wrong, not a correction of it. The city material is
 * double-sided either way; what a wrong normal costs is the normal G-buffer.
 */
const ORIENTATION_REFERENCE_TOLERANCE = 2.5e-4;

function orientExteriorRing(
  ring: ReadonlyArray<Vec3> | undefined,
  objectBBox: BBox3 | null,
): ReadonlyArray<Vec3> | undefined {
  if (!ring || ring.length < 3 || !objectBBox) return ring;

  const normal = computeNewellNormal(ring);
  const normalLengthSq =
    normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2];
  if (normalLengthSq === 0) return ring;

  const faceCenter = computeRingCenter(ring);
  const objectCenter = [
    (objectBBox[0] + objectBBox[3]) / 2,
    (objectBBox[1] + objectBBox[4]) / 2,
    (objectBBox[2] + objectBBox[5]) / 2,
  ] as const;
  const toFace = [
    faceCenter[0] - objectCenter[0],
    faceCenter[1] - objectCenter[1],
    faceCenter[2] - objectCenter[2],
  ] as const;
  const dot =
    normal[0] * toFace[0] + normal[1] * toFace[1] + normal[2] * toFace[2];

  // `normal` is Newell's UNnormalised vector (its length is twice the face
  // area), so the tolerance is scaled by it as well as by the object's size —
  // otherwise the same shape would be judged differently at a different area.
  const diagonal = Math.hypot(
    objectBBox[3] - objectBBox[0],
    objectBBox[4] - objectBBox[1],
    objectBBox[5] - objectBBox[2],
  );
  const floor =
    ORIENTATION_REFERENCE_TOLERANCE * diagonal * Math.sqrt(normalLengthSq);

  return dot < -floor ? [...ring].reverse() : ring;
}

function computeRingCenter(ring: ReadonlyArray<Vec3>): Vec3 {
  let sx = 0;
  let sy = 0;
  let sz = 0;

  for (const v of ring) {
    sx += v[0];
    sy += v[1];
    sz += v[2];
  }

  return [sx / ring.length, sy / ring.length, sz / ring.length];
}

// Newell's method is stable for arbitrary planar polygon winding.
function computeNewellNormal(ring: ReadonlyArray<Vec3>): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;

  for (let i = 0; i < ring.length; i++) {
    const current = ring[i]!;
    const next = ring[(i + 1) % ring.length]!;
    nx += (current[1] - next[1]) * (current[2] + next[2]);
    ny += (current[2] - next[2]) * (current[0] + next[0]);
    nz += (current[0] - next[0]) * (current[1] + next[1]);
  }

  return [nx, ny, nz];
}

interface ProjectionBasis {
  readonly origin: Vec3;
  readonly tangent: Vec3;
  readonly bitangent: Vec3;
}

function buildProjectionBasis(
  ring: ReadonlyArray<Vec3>,
  normal: Vec3,
): ProjectionBasis | null {
  const origin = ring[0]!;
  let tangent: Vec3 | null = null;

  for (let i = 1; i < ring.length; i++) {
    const edge = subtractVec3(ring[i]!, origin);
    const length = Math.hypot(edge[0], edge[1], edge[2]);
    if (length > 0) {
      tangent = [edge[0] / length, edge[1] / length, edge[2] / length];
      break;
    }
  }

  if (!tangent) return null;

  const bitangentRaw = crossVec3(normal, tangent);
  const bitangentLength = Math.hypot(
    bitangentRaw[0],
    bitangentRaw[1],
    bitangentRaw[2],
  );
  if (bitangentLength === 0) return null;

  const bitangent: Vec3 = [
    bitangentRaw[0] / bitangentLength,
    bitangentRaw[1] / bitangentLength,
    bitangentRaw[2] / bitangentLength,
  ];
  const tangentOrthoRaw = crossVec3(bitangent, normal);
  const tangentOrthoLength = Math.hypot(
    tangentOrthoRaw[0],
    tangentOrthoRaw[1],
    tangentOrthoRaw[2],
  );
  if (tangentOrthoLength === 0) return null;

  return {
    origin,
    tangent: [
      tangentOrthoRaw[0] / tangentOrthoLength,
      tangentOrthoRaw[1] / tangentOrthoLength,
      tangentOrthoRaw[2] / tangentOrthoLength,
    ],
    bitangent,
  };
}

function projectRingTo2D(
  ring: ReadonlyArray<Vec3>,
  basis: ProjectionBasis,
): Vector2[] {
  return ring.map((vertex) => {
    const offset = subtractVec3(vertex, basis.origin);
    return new Vector2(
      dotVec3(offset, basis.tangent),
      dotVec3(offset, basis.bitangent),
    );
  });
}

function subtractVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dotVec3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
