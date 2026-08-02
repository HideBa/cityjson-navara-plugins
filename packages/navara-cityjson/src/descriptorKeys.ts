/**
 * The two mesh-descriptor names this package registers with Navara.
 *
 * They live in their own (dependency-free) module because both the registry
 * and the streaming primitive need them, and neither should have to import the
 * other: `cityMesh.ts` is the low-level, per-cell path (Tasks C8/C10a) and must
 * stay importable without dragging the whole static-layer registry in.
 *
 * `cityModelRegistry.ts` re-exports both, which is the import path the rest of
 * the plan (and the package barrel) uses.
 */

/** Descriptor key for a whole static CityJSON layer (`CityModelMeshDesc`). */
export const CITY_MODEL_MESH_KEY = "cityModel";

/** Descriptor key for one arrays-backed mesh, i.e. one streaming cell
 *  (`CityMeshArraysDesc`). */
export const CITY_MESH_ARRAYS_KEY = "cityMeshArrays";
