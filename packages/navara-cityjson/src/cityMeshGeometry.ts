/**
 * `CityMeshArrays` -> `BufferGeometry`. The only Three.js-specific step of the
 * geometry pipeline; everything upstream of it (triangulation, normals, slot
 * tables) is worker-safe and lives in `@cityjson/navara-core`.
 *
 * Every attribute intentionally *wraps* the caller's typed array rather than
 * copying it:
 *
 * - `position` is rewritten in place by `projectPositionsToEnu` when a layer's
 *   ENU frame or height offset is resolved, so it must alias.
 * - `citySlot` names each vertex's surface. The style texture is indexed by
 *   it, so colour, highlight and the texture mask never touch a vertex, and
 *   the CPU raycast reads it back through `arrays.slots`.
 *
 * Consequence for callers: the `CityMeshArrays` handed to this function is
 * owned by the geometry afterwards. Do not reuse it for a second geometry, and
 * do not assume `disposeGeometry` frees the CPU buffers (it only releases GPU
 * resources; the typed arrays die with their last JS reference).
 *
 * The `normal` attribute is load-bearing twice over: the lighting equation
 * reads it, and the MRT pass writes it to the normal G-buffer for the effects
 * that read one.
 */

import type { CityMeshArrays } from "@cityjson/navara-core";
import { BufferAttribute, BufferGeometry } from "three";

/**
 * Wrap `arrays` in a non-indexed `BufferGeometry` with the attributes the
 * city material reads: `position`(3), `normal`(3) and `citySlot`(1), plus
 * `uv`(2) under a texture theme. The bounding sphere is computed eagerly
 * because Navara frustum-culls meshes on the first frame after `addMesh`.
 */
export function geometryFromMeshArrays(arrays: CityMeshArrays): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(arrays.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(arrays.normals, 3));
  geometry.setAttribute("citySlot", new BufferAttribute(arrays.slots, 1));
  // Under a texture theme the build also carries per-vertex UVs and one
  // vertex range per image; each range becomes a draw group whose material
  // index is its position, matching `buildGroupMaterials`.
  if (arrays.uvs) {
    geometry.setAttribute("uv", new BufferAttribute(arrays.uvs, 2));
  }
  if (arrays.textureGroups) {
    arrays.textureGroups.forEach((group, i) =>
      geometry.addGroup(group.start, group.count, i),
    );
  }
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Release a geometry built by {@link geometryFromMeshArrays}. Named (rather
 * than calling `geometry.dispose()` at each call site) so layer teardown has a
 * single seam to extend if these geometries ever acquire extra GPU resources.
 */
export function disposeGeometry(geometry: BufferGeometry): void {
  geometry.dispose();
}
