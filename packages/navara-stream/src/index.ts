/**
 * @cityjson/navara-stream — camera-driven streaming of city models into
 * Navara, independent of the file format.
 *
 * This barrel is engine-free and Node-importable: everything exported here is
 * pure TypeScript over plain data (tile arithmetic, cache budgets, hysteresis,
 * feature bucketing, worker message shapes) plus `WorkerClient`, which wraps a
 * `Worker` it is handed, and `StreamLayerRegistry`, whose engine seams are all
 * injected.
 *
 * Three entry points:
 *  - `.` (this barrel): the main-thread stream machinery.
 *  - `./worker`: what a format's worker entry needs — `installStreamWorker`,
 *    the `StreamSourceAdapter` contract and the wire protocol — and nothing
 *    that would drag the main-thread graph into a worker chunk.
 *  - `./plugin`: the engine-bound half, `CityStreamPlugin` and the
 *    `getPickRay` binding, which import `@navaramap/*` and therefore cannot
 *    load under Node.
 *
 * Formats live in their own packages (`@cityjson/navara-flatcitybuf`,
 * `@cityjson/navara-cityparquet`): each ships a source adapter, a worker entry
 * that installs the core over it, and a factory that starts that worker.
 */
export * from "./constants";
export * from "./tileGrid";
export * from "./cellCache";
export * from "./levelPolicy";
export * from "./throttleGates";
export * from "./bucketFeatures";
export * from "./objectRecords";
export * from "./workerProtocol";
export * from "./workerClient";
export type {
  AdmissionCode,
  AdmissionError,
  OpenedSource,
  OpenRequest,
  StreamHeader,
  StreamSourceAdapter,
} from "./streamSourceAdapter";
export * from "./viewportFootprint";
export * from "./queryRegion";
export * from "./streamLayer";
export * from "./streamRegistry";
export * from "./residentModel";
export * from "./commitPlanner";
export * from "./settleController";
export * from "./cellMeshes";
export * from "./cellMeshFactory";
export * from "./entryToArrays";
export * from "./layerTextures";
// The ray *adapter* is engine-free and belongs here; the binding that supplies
// Navara's real `getPickRay` (`./engineRays`) does NOT, and is re-exported from
// the `./plugin` entry point instead.
export * from "./navaraRays";

// Re-exported rather than redeclared: `StreamLayerHandle.setThemeStyle` takes
// exactly the type `CityModelHandle.setThemeStyle` does, and an app holding
// both kinds of layer must be able to push ONE style object to both. The
// definition lives in `@cityjson/navara-cityjson/themeStyle`, which takes
// `three` but never `@navaramap/*`, so this barrel stays Node-importable.
export type { ThemeEdgeStyle, ThemeStyle } from "@cityjson/navara-cityjson";
export { DEFAULT_THEME_STYLE } from "@cityjson/navara-cityjson";
