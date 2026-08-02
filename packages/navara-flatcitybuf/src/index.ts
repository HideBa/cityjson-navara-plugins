/**
 * @cityjson/navara-flatcitybuf — Navara plugin for camera-driven FlatCityBuf
 * streaming.
 *
 * This barrel is engine-free and Node-importable: everything exported here is
 * pure TypeScript over plain data (tile arithmetic, cache budgets, hysteresis,
 * feature bucketing, worker message shapes). The engine-bound half (the
 * `@navaramap/*` imports and the FCB worker) lands in later M7.5 tasks behind
 * its own entry point, exactly as `@cityjson/navara-cityjson/plugin` does —
 * see Task B1's NODE_IMPORT_SAFE = false verdict.
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
