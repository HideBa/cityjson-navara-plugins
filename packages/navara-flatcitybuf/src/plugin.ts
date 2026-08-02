/**
 * `@cityjson/navara-flatcitybuf/plugin` — the engine-bound entry point.
 *
 * Everything reachable from here imports `@navaramap/three`, which crashes at
 * module scope under Node (`os.cpus is not a function`; Task B1's
 * `NODE_IMPORT_SAFE = false`). It therefore lives behind its own subpath rather
 * than in the main barrel, so `@cityjson/navara-flatcitybuf` stays importable
 * from Node — by unit tests, by the streaming worker, and by any tooling that
 * only needs the tile arithmetic, the wire protocol or the layer handle.
 *
 * Host apps (Task C13 onward) import the plugin from here:
 *
 * ```ts
 * import { FlatCityBufPlugin } from "@cityjson/navara-flatcitybuf/plugin";
 * ```
 */
export { FlatCityBufPlugin } from "./FlatCityBufPlugin";
export type { FlatCityBufPluginOptions } from "./FlatCityBufPlugin";

/**
 * The binding that supplies Navara's real `getPickRay`. Exported here (not
 * from the barrel) for the same reason the plugin is: it imports the engine.
 * A host that drives the streaming footprint itself — or that wants the same
 * ray source for its own hit testing — needs it; `viewRaySource`/`cornerRays`,
 * its engine-free half, stay on the main barrel.
 */
export { navaraViewRaySource } from "./engineRays";

// Re-exported for convenience: a host wiring the plugin invariably needs the
// open options and the handle type in the same breath, and both come from
// engine-free modules, so importing them here costs nothing extra.
export type { OpenStreamOptions, StreamLayerLike } from "./streamRegistry";
export type { FcbStreamLayerHandle } from "./streamLayer";
