/**
 * `CityMeshArrays` -> `BufferGeometry`. The only Three.js-specific step of the
 * geometry pipeline; everything upstream of it (triangulation, normals, colors,
 * picking indices) is worker-safe and lives in `@cityjson/navara-core`.
 *
 * Every attribute intentionally *wraps* the caller's typed array rather than
 * copying it:
 *
 * - `color` is mutated in place by highlight/style layering, which then flips
 *   `needsUpdate` — exactly as the pre-Navara renderer did. A copy here would
 *   silently detach recolouring from the GPU buffer.
 * - `position` is rewritten in place by `projectPositionsToEnu` when a layer's
 *   ENU frame or height offset is resolved, so it must alias too.
 * - `objectIndex` / `surfaceIndex` are the picking side-channel: the CPU
 *   raycast path (`PICK_PATH = "own-raycast"`) reads them straight off the
 *   attribute, so they stay un-normalized `Uint32Array`s carrying raw ids
 *   rather than 0..1 floats.
 *
 * Consequence for callers: the `CityMeshArrays` handed to this function is
 * owned by the geometry afterwards. Do not reuse it for a second geometry, and
 * do not assume `disposeGeometry` frees the CPU buffers (it only releases GPU
 * resources; the typed arrays die with their last JS reference).
 *
 * Material note: the Task B1 spike measured `MRT_VERTEX_COLORS_OK = true` — a
 * plain built-in material with `vertexColors: true` renders correctly through
 * Navara's MRT pass, so the `color` attribute needs no shader patching and
 * this builder emits nothing MRT-specific. Both mesh classes draw with
 * `createCityMaterial` (a lit Lambert, see `cityMaterial.ts`); the `normal`
 * attribute is load-bearing twice over — the lighting equation reads it, and
 * the MRT pass writes it to the normal G-buffer for the effects that read one.
 */

import type { CityMeshArrays } from "@cityjson/navara-core";
import { BufferAttribute, BufferGeometry } from "three";

/**
 * Wrap `arrays` in a non-indexed `BufferGeometry` with the five attributes the
 * CityJSON render/pick path expects: `position`(3), `normal`(3), `color`(3),
 * `objectIndex`(1), `surfaceIndex`(1). The bounding sphere is computed eagerly
 * because Navara frustum-culls meshes on the first frame after `addMesh`.
 */
export function geometryFromMeshArrays(arrays: CityMeshArrays): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(arrays.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(arrays.normals, 3));
  geometry.setAttribute("color", new BufferAttribute(arrays.colors, 3));
  geometry.setAttribute(
    "objectIndex",
    new BufferAttribute(arrays.objectIndices, 1),
  );
  geometry.setAttribute(
    "surfaceIndex",
    new BufferAttribute(arrays.surfaceIndices, 1),
  );
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
