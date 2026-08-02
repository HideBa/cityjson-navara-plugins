/**
 * `@cityjson/navara-cityjson/plugin` — the engine-bound entry point.
 *
 * Everything reachable from here imports `@navaramap/three`, which crashes at
 * module scope under Node (`os.cpus is not a function`; Task B1's
 * `NODE_IMPORT_SAFE = false`). It therefore lives behind its own subpath rather
 * than in the main barrel, so `@cityjson/navara-cityjson` stays importable from
 * Node — by unit tests, by workers, and by any tooling that only needs the
 * domain types, the registry or the mesh objects.
 *
 * Host apps (Task B8 onward) import the plugin from here:
 *
 * ```ts
 * import { CityJSONPlugin } from "@cityjson/navara-cityjson/plugin";
 * ```
 */
export { CityJSONPlugin } from "./CityJSONPlugin";
export type { CityJSONPluginOptions } from "./CityJSONPlugin";

export { CityModelMeshDesc } from "./CityModelMeshDesc";
export type {
  CityModelDescConfig,
  CityModelDescOptions,
} from "./CityModelMeshDesc";

export { CityMeshArraysDesc } from "./CityMeshArraysDesc";
export type { CityMeshArraysDescConfig } from "./CityMeshArraysDesc";

// Re-exported for convenience: a host wiring the plugin invariably needs the
// descriptor names and the handle types in the same breath, and these come from
// engine-free modules, so importing them here costs nothing extra.
export { CITY_MESH_ARRAYS_KEY, CITY_MODEL_MESH_KEY } from "./descriptorKeys";
export type { AddCityModelOptions, CityModelHandle } from "./types";
