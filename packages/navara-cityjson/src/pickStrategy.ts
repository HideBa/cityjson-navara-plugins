/**
 * How a city-model mesh resolves a screen pick into a surface.
 *
 * - "pickable-wrapper": the mesh is registered with Navara's GPU pick pipeline
 *   so `pick` events fire for it. NOT IMPLEMENTED for per-surface resolution —
 *   the engine's batch id is per mesh, not per triangle (see below).
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
 * **Only `"own-raycast"` resolves a pick today.** The spike found
 * `PickableMeshWrapper` allocates ONE uniform batch id for a whole mesh (both
 * triangles of the probe came back as 4666372, with `properties: null`), so a
 * batch id is a *mesh* identity, not a triangle index, and no per-surface pick
 * can be recovered from it. Selecting `"pickable-wrapper"` therefore still
 * registers the mesh with the engine's pick pipeline — so a `pick` event fires
 * and a per-layer pick is possible — but `resolvePick` of that event returns
 * `null` with one warning. `batchIdMap()` remains published for the day the
 * engine gains per-triangle ids; nothing reads it to resolve a pick.
 */
export const DEFAULT_PICK_STRATEGY: PickStrategy = "own-raycast";
