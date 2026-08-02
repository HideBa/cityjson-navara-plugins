/**
 * Structural copies of the app's selection domain types — the plugin must not
 * depend on the app. Kept identical to the app's
 * `src/domain/selection/types.ts` (minus `ToolMode`, which is a UI concern the
 * plugin never sees).
 *
 * Engine-free: no `@navaramap/*` imports (see the global engine-binding rule),
 * so unit tests can import this module directly.
 */

export type PickMode = "object" | "surface";

export interface ObjectSelection {
  readonly kind: "object";
  readonly layerId: string;
  readonly objectId: string;
}

export interface SurfaceSelection {
  readonly kind: "surface";
  readonly layerId: string;
  readonly objectId: string;
  readonly surfaceIndex: number;
}

export type Selection = ObjectSelection | SurfaceSelection;

/** A point in CSS pixels relative to the canvas' top-left corner. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The subset of an engine pick result this plugin relies on. Declared
 * structurally (rather than importing the engine's own type) so every module
 * that routes picks stays engine-free.
 */
export interface PickedFeatureLike {
  readonly batchId?: number;
  readonly layerId?: string;
  /** Free-form on the engine side. The keys this plan relies on are stamped
   *  by our own descriptors (Task B7): `layerId` on every mesh, and `cellKey`
   *  on streaming cell meshes only. They are declared here so the pick routing
   *  (Task B15) and the cell lookup (Task C10b) type-check without a cast. */
  readonly properties?: Readonly<
    Record<string, unknown> & {
      readonly layerId?: string;
      readonly cellKey?: string;
      readonly objectIndex?: number;
      readonly surfaceIndex?: number;
    }
  >;
}
