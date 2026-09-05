/**
 * The package's public handle contract (spec §3, concretized by the Shared
 * Interface Contract). Types only — no runtime code, and nothing engine-shaped,
 * so both the engine-free registry and the thin plugin binding can import it.
 */
import type {
  AppearanceTheme,
  SurfaceStyleEvaluator,
} from "@cityjson/navara-core";
import type { GeodeticBounds } from "./enuPlacement";
import type { TextureSource } from "./texturedMaterials";
import type { EcefRay, RaycastHit, SurfaceRef } from "./pickTypes";
import type { PickedFeatureLike, ScreenPoint, Selection } from "./selection";
import type { ThemeStyle } from "./themeStyle";

export type { GeodeticBounds, Lle, Placement } from "./enuPlacement";
export type { ThemeEdgeStyle, ThemeStyle } from "./themeStyle";
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
  /** First-level object types to build WITHOUT geometry — hiding "Building"
   *  also hides its BuildingParts (`toplevelCityObjectType`). Omitted or empty
   *  builds everything. */
  readonly hiddenTypes?: ReadonlyArray<string>;
  /**
   * Vertical-datum correction in metres. When omitted, the registry samples it
   * asynchronously with `geoidHeightAt(originLng, originLat)` and applies it
   * via `setHeightOffset()` once it lands (Global Constraints -> Vertical
   * datum). An explicit value — including `0` — skips sampling entirely.
   */
  readonly heightOffset?: number;
  /**
   * Which of the model's appearance themes to draw — a texture theme (images
   * + UVs) or a material theme (diffuse colours); `null`/omitted draws the
   * semantic colours. Changed afterwards through `setAppearance`.
   */
  readonly appearance?: AppearanceTheme | null;
  /**
   * The DATASET's URL, which relative texture image paths resolve against
   * (`appearances/x.jpg` next to `rotterdam.jsonl`). `null` for a layer that
   * came from a local file: its relative images cannot be fetched and those
   * surfaces render untextured; absolute image URLs still load.
   */
  readonly textureBaseUrl?: string | null;
  /** Image-loading seam; defaults to three's `TextureLoader`. */
  readonly textureSource?: TextureSource;
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
  /** Rebuilds geometry without the named first-level types (hiding "Building"
   *  hides its BuildingParts too); `[]` clears the filter. Geometry, not
   *  styling — a hidden object stops occluding and stops picking. */
  setHiddenTypes(types: ReadonlyArray<string>): void;
  /** Rebuilds geometry containing only these objects; `null` clears the
   *  filter, an EMPTY set draws nothing. ANDed with {@link setHiddenTypes}. */
  setVisibleObjectIds(ids: ReadonlySet<string> | null): void;
  /** Per-surface rule colors; `null` restores the semantic base colors. */
  setStyle(evaluator: SurfaceStyleEvaluator | null): void;
  /**
   * Scene-theme presentation: a fill multiplier over the vertex colours plus
   * optional structural edge lines. Orthogonal to {@link setStyle} — a theme
   * writes no vertex colours, so rules, highlights and picking are unaffected,
   * and `DEFAULT_THEME_STYLE` restores the photoreal look exactly.
   *
   * Not an `AddCityModelOptions` field on purpose: the app pushes the active
   * style right after the layer is added, and a one-frame default is invisible
   * during load.
   */
  setThemeStyle(style: ThemeStyle): void;
  /** Rebuilds geometry drawn with `theme` (or plain colours for `null`) —
   *  the same seam as `setLod`. Textures load progressively: a surface keeps
   *  its colour until its image is ready. */
  setAppearance(theme: AppearanceTheme | null): void;
  setHighlight(sel: readonly Selection[], hovered?: Selection): void;
  /** Always returns a `SurfaceSelection`; the app narrows it per `PickMode`. */
  resolvePick(pick: PickedFeatureLike | ScreenPoint): Selection | null;
  getBoundsGeodetic(): GeodeticBounds;
  triangleCount(): number;
  /**
   * The vertical-datum offset in metres CURRENTLY baked into this layer's
   * placement — 0 until the async geoid sample lands, then the sampled
   * undulation (or an explicit `heightOffset`, immediately).
   *
   * A method, not a readonly field, precisely because the value changes when
   * the sample resolves: a snapshotted property would freeze at 0 and quietly
   * de-correct every reading taken afterwards.
   *
   * Published because it is the only way back from an ELLIPSOIDAL height to
   * the ORTHOMETRIC z the source file contained: `orthometric = geodetic -
   * heightOffset`. The host's cursor readout needs exactly that (Task B15);
   * without it a Delft model reads ~43 m high — the mirror image of the bug
   * the offset exists to fix.
   */
  heightOffset(): number;
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
