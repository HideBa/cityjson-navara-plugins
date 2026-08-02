/**
 * The package's public handle contract (spec §3, concretized by the Shared
 * Interface Contract). Types only — no runtime code, and nothing engine-shaped,
 * so both the engine-free registry and the thin plugin binding can import it.
 */
import type { SurfaceStyleEvaluator } from "@cityjson/navara-core";
import type { GeodeticBounds } from "./enuPlacement";
import type { EcefRay, RaycastHit, SurfaceRef } from "./pickTypes";
import type { PickedFeatureLike, ScreenPoint, Selection } from "./selection";

export type { GeodeticBounds, Lle, Placement } from "./enuPlacement";
export type { EcefRay, RaycastHit, SurfaceRef } from "./pickTypes";
export type {
  ObjectSelection,
  PickedFeatureLike,
  PickMode,
  ScreenPoint,
  Selection,
  SurfaceSelection,
} from "./selection";

export interface AddCityModelOptions {
  readonly id: string;
  /** Overrides the model's own `metadata.referenceSystem`. */
  readonly crs?: string | number;
  /** LoD to render; `null`/omitted renders every LoD in the model. */
  readonly lod?: string | null;
  /**
   * Vertical-datum correction in metres. When omitted, the registry samples it
   * asynchronously with `geoidHeightAt(originLng, originLat)` and applies it
   * via `setHeightOffset()` once it lands (Global Constraints -> Vertical
   * datum). An explicit value — including `0` — skips sampling entirely.
   */
  readonly heightOffset?: number;
}

/**
 * One static CityJSON layer, as the host app holds it.
 *
 * The first eight members are spec §3 verbatim. The last two are the shared
 * `CityMeshHandle` members: a static layer and a streaming cell answer a pick
 * through the identical pair, so Task C10b's router does not branch on which
 * kind of handle it is holding.
 */
export interface CityModelHandle {
  readonly id: string;
  setVisible(v: boolean): void;
  /** Rebuilds geometry filtered by LoD; `null` clears the filter. */
  setLod(lod: string | null): void;
  /** Per-surface rule colors; `null` restores the semantic base colors. */
  setStyle(evaluator: SurfaceStyleEvaluator | null): void;
  setHighlight(sel: readonly Selection[], hovered?: Selection): void;
  /** Always returns a `SurfaceSelection`; the app narrows it per `PickMode`. */
  resolvePick(pick: PickedFeatureLike | ScreenPoint): Selection | null;
  getBoundsGeodetic(): GeodeticBounds;
  triangleCount(): number;
  delete(): void;
  /** Entry `t` is triangle `t`'s `SurfaceRef`. Reserved for a future engine
   *  with per-triangle batch ids; today's is per mesh, so no pick resolves
   *  through it (see `pickStrategy.ts`). */
  batchIdMap(): ReadonlyArray<SurfaceRef>;
  /** ECEF ray in, hit surface + ray distance out — the raw form, for callers
   *  that raycast several handles and keep the nearest hit. `resolvePick` is
   *  the same path already resolved to a `Selection`. */
  resolveRaycast(ray: EcefRay): RaycastHit | null;
}
