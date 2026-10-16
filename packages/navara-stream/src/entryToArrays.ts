/**
 * CellEntry (worker wire shape) -> CityMeshArrays (mesh-primitive shape).
 *
 * Everything is handed through BY REFERENCE, so a commit never duplicates a
 * cell's geometry. Nothing downstream writes into these arrays: a cell's
 * colours, highlight and image mask live in its style texture
 * (`SlotStyle`), which copies what it is given.
 *
 * `slotColors` is the BASE palette; `syncCellMeshes` writes the cell's rule
 * colours over it straight after the mesh is created, so a freshly arrived
 * cell renders already rule-coloured instead of flashing semantic colours
 * for one frame.
 */
import type { CityMeshArrays } from "@cityjson/navara-core";
import type { CellEntry } from "./streamLayer";

export function entryToArrays(entry: CellEntry): CityMeshArrays {
  const g = entry.geometry;
  return {
    positions: g.positions,
    normals: g.normals,
    indices: g.indices,
    objectKeys: g.objectKeys,
    objectTypes: g.objectTypes,
    triangleCount: g.triangleCount,
    // Texture theme only.
    uvs: g.uvs,
    textureGroups: g.textureGroups,
    slots: g.slots,
    slotObjects: g.slotObjects,
    slotSurfaces: g.slotSurfaces,
    slotTextures: g.slotTextures,
    slotColors: g.baseColors,
  };
}
