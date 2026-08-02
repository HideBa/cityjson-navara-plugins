/**
 * CellEntry (worker wire shape) -> CityMeshArrays (mesh-primitive shape).
 *
 * The only real difference is colour: the worker ships `baseColors` (semantic
 * surface colours) plus an optional `ruleColors` it baked from the layer's
 * rules, while `addCityMeshArrays` takes one `colors` buffer. Rule colours win
 * when present — that is what makes a freshly arrived cell render already
 * rule-coloured instead of flashing semantic colours for one frame.
 *
 * `positions`, `normals`, the two index arrays and `objectKeys` are handed
 * through BY REFERENCE, so a commit never duplicates a cell's geometry.
 *
 * `colors` is the one exception, and it is copied on BOTH branches
 * (C8 carry-forward, extended here after checking the paint path):
 *
 *  - `geometryFromMeshArrays` deliberately *wraps* the colour array it is
 *    given rather than copying it (`cityMeshGeometry.ts`) — writing into the
 *    live attribute is what reaches the GPU.
 *  - `CityMeshArraysMesh.setColors` then writes INTO that live array
 *    (`attr.array.set(colors)`, `cityMesh.ts`), and `syncCellMeshes` calls it
 *    with `entry.geometry.ruleColors` immediately after `create`. Wrapping
 *    `baseColors` would therefore land rule colours in the cache entry's own
 *    base buffer, destroying the restore baseline `CellMesh.baseColors` is
 *    copied from one line later.
 *  - The `ruleColors` branch is the same hazard one layer further on:
 *    `CellMesh.ruleColors` holds the entry's buffer by reference and is the
 *    *source* Task C10b's highlight restores from, while `paintLayers`
 *    (`surfaceColorLayers.ts`) writes the highlight into the live *target*
 *    array in place. Alias the two and source === target: the restore becomes
 *    a self-copy no-op and a highlight can never be cleared.
 *
 * One `Float32Array.from` per newly resident cell is the same order of cost
 * `CellMesh.baseColors` already pays, and it is what makes both restore
 * baselines genuinely immutable — the contract every later recolor and
 * highlight is built on.
 */
import type { CityMeshArrays } from "@cityjson/navara-core";
import type { CellEntry } from "./streamLayer";

export function entryToArrays(entry: CellEntry): CityMeshArrays {
  const g = entry.geometry;
  return {
    positions: g.positions,
    normals: g.normals,
    colors: Float32Array.from(g.ruleColors ?? g.baseColors),
    objectIndices: g.objectIndices,
    surfaceIndices: g.surfaceIndices,
    objectKeys: g.objectKeys,
    triangleCount: g.triangleCount,
  };
}
