/**
 * The real {@link CellMeshFactory}: one engine mesh per resident cell.
 *
 * This is the seam `FcbStreamLayerHandle` was given so it could stay engine-
 * free (Task C10a), and it is deliberately NOT inside `FlatCityBufPlugin.ts`.
 * `addCityMeshArrays` imports `three` but never `@navaramap/*` — it takes the
 * view structurally (`CityMeshArraysViewLike`) — so keeping the factory here
 * means the stamping this whole path depends on is provable in Node against
 * the B2 fake view, instead of being visible only in a browser.
 *
 * What it stamps, and why each field is load-bearing:
 *
 * - `layerId` — Task B15's pick router finds the owning handle by it. Without
 *   it a streamed cell's `PickedFeature` belongs to nobody.
 * - `cellKey` — Task C10b's `resolvePick` finds the resident cell by it.
 * - `pickStrategy` — Task B1's PICK_PATH verdict, which decides whether the
 *   mesh publishes a `batchIdMap` at all.
 * - `id` — `${layerId}:${cellKey}`, unique per mesh across layers, so two
 *   layers streaming the same tile grid cannot collide in the engine's mesh
 *   registry.
 */
import {
  addCityMeshArrays,
  type CityMeshArraysViewLike,
  type CityMeshHandle,
  type PickStrategy,
} from "@cityjson/navara-cityjson";
import type { CellMeshFactory } from "./cellMeshes";
import { entryToArrays } from "./entryToArrays";
import type { CellEntry } from "./streamLayer";

export interface CellMeshFactoryDeps {
  readonly layerId: string;
  /**
   * The view to add meshes to, read per cell rather than captured: a plugin
   * has no view until `init()`, and a cell can only ever be built after that
   * — but the factory itself is created when the layer opens.
   */
  readonly getView: () => CityMeshArraysViewLike | null;
  readonly pickStrategy?: PickStrategy;
}

export function createCellMeshFactory(
  deps: CellMeshFactoryDeps,
): CellMeshFactory {
  return {
    create(key: string, entry: CellEntry, frame): CityMeshHandle {
      const view = deps.getView();
      if (!view) {
        throw new Error(
          `FlatCityBufPlugin: cell "${deps.layerId}:${key}" was built before view.init() — add the plugin with view.addPlugin(plugin) and await view.init() first.`,
        );
      }
      return addCityMeshArrays(view, {
        id: `${deps.layerId}:${key}`,
        // Both colour branches are COPIED here (`entryToArrays`): the engine
        // wraps the buffer it is given, and the cache entry's colours are the
        // restore baseline every later recolor and highlight reads from.
        arrays: entryToArrays(entry),
        frame,
        layerId: deps.layerId,
        cellKey: key,
        pickStrategy: deps.pickStrategy,
      });
    },
  };
}
