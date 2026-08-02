/**
 * Picking indices: the mapping from the per-vertex `objectIndex` /
 * `surfaceIndex` attributes emitted by `buildCityMeshArrays` back to city
 * object IDs and surface positions. Renderer-agnostic — a Navara descriptor,
 * a raycast, or a GPU pick buffer all resolve through the same two types.
 */

export interface PickingIndex {
  /** ID of the layer this mesh belongs to. */
  readonly layerId: string;
  /** Ordered list of CityObject IDs, one per unique object index. */
  readonly objectKeys: ReadonlyArray<string>;
}

export interface PickResult {
  readonly layerId: string;
  readonly objectId: string;
  readonly surfaceIndex: number;
}
