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
  /**
   * Which of the answering handle's SUB-meshes the indices belong to, when it
   * has more than one — a FlatCityBuf layer's resident cell key.
   *
   * Opaque to everybody but the handle that produced it. A router that raycasts
   * many handles, takes the nearest hit and then asks the winner to interpret
   * it (`resolveNearestHit`, Task B15) must forward this verbatim, because
   * `objectIndex` is meaningful only inside the cell it was measured in — the
   * same reason the indices themselves are never handed to another layer.
   *
   * Absent for a single-mesh handle (`CityModelHandle`), which needs no
   * disambiguation.
   */
  readonly cellKey?: string;
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
