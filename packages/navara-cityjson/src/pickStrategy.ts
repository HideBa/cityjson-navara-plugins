/**
 * How a city-model mesh resolves a screen pick into a surface.
 *
 * - "pickable-wrapper": Navara's GPU pick pipeline resolves the triangle and
 *   the `pick` event carries a `batchId` we map back through
 *   `CityModelMesh.batchIdMap()`.
 * - "own-raycast": we take `getPickRay(view, x, y)` and raycast the mesh
 *   ourselves, reading `objectIndex`/`surfaceIndex` off the hit face.
 *
 * Both branches ship and both are unit-tested; this value decides which one
 * runs. Its value is transcribed from the Task B1 spike's `PICK_PATH` verdict
 * (docs/superpowers/research/2026-08-01-navara-spike-findings.md) — update the
 * constant below to match that document, and nothing else changes.
 */
export type PickStrategy = "pickable-wrapper" | "own-raycast";

/**
 * Set from Task B1's PICK_PATH verdict: `"own-raycast"`.
 *
 * The spike found `PickableMeshWrapper` carries ONE uniform batch id per mesh,
 * so it cannot distinguish surfaces within a city model — the wrapper branch
 * still exists (and `batchIdMap()` still publishes the table it would need) for
 * the day the engine gains per-triangle ids, but it is not the default and no
 * per-surface pick can currently be resolved through it.
 */
export const DEFAULT_PICK_STRATEGY: PickStrategy = "own-raycast";
