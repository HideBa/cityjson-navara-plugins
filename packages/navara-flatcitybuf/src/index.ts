/**
 * @cityjson/navara-flatcitybuf — Navara plugin for camera-driven FlatCityBuf
 * streaming.
 *
 * This barrel is engine-free and Node-importable: everything exported here is
 * pure TypeScript over plain data (tile arithmetic, cache budgets, hysteresis,
 * feature bucketing, worker message shapes, FCB header admission) plus
 * `WorkerClient`, which only touches the DOM `Worker` constructor from inside
 * its own constructor. The engine-bound half (the `@navaramap/*` imports)
 * lands in a later M7.5 task behind its own entry point, exactly as
 * `@cityjson/navara-cityjson/plugin` does — see Task B1's
 * NODE_IMPORT_SAFE = false verdict.
 *
 * `./fcb.worker.ts` is deliberately NOT re-exported: it is a worker entry
 * point whose module scope installs an `onmessage` handler, and it is reached
 * only through `WorkerClient`'s `new Worker(new URL(...))`.
 */
import { NAVARA_CORE_VERSION } from "@cityjson/navara-core";

export const FLATCITYBUF_PLUGIN_PLACEHOLDER = `@cityjson/navara-flatcitybuf (core ${NAVARA_CORE_VERSION})`;

export * from "./constants";
export * from "./tileGrid";
export * from "./cellCache";
export * from "./levelPolicy";
export * from "./throttleGates";
export * from "./bucketFeatures";
export * from "./objectRecords";
export * from "./workerProtocol";
export * from "./workerClient";
export * from "./fcbSource";
export * from "./viewportFootprint";
export * from "./streamLayer";
export * from "./residentModel";
export * from "./commitPlanner";
export * from "./settleController";
export * from "./cellMeshes";
// The ray *adapter* is engine-free and belongs here; the binding that supplies
// Navara's real `getPickRay` (`./engineRays`) does NOT, and is re-exported from
// the `./plugin` entry point instead (Task C11).
export * from "./navaraRays";
