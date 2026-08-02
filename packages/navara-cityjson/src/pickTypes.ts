/**
 * The shapes a pick travels in, shared by the static layer path
 * (`CityModelMesh`, Task B6) and the streaming per-cell path
 * (`CityMeshHandle`, Tasks B7/C8) so a pick resolves identically on both.
 *
 * Declared structurally, with no `@navaramap/*` and no Three.js types, so the
 * modules that route picks stay engine-free and Node-testable: the engine's
 * `getPickRay` returns a three `Ray`, which satisfies {@link EcefRay}
 * structurally, and callers never need to convert.
 */

/** One "which surface is this" answer, in mesh-local index space. */
export interface SurfaceRef {
  readonly objectIndex: number;
  readonly surfaceIndex: number;
}

/**
 * ...plus how far along the ray it was hit, so a caller raycasting many meshes
 * (a streaming layer's resident cells) can pick the nearest.
 */
export interface RaycastHit extends SurfaceRef {
  readonly distance: number;
}

/** A ray in ECEF metres — the space every mesh's `matrixWorld` maps into. */
export interface EcefRay {
  readonly origin: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly direction: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
}
