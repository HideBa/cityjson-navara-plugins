import type {
  AppearanceTheme,
  BBox3,
  CityTexture,
  LocalMetricFrameDescriptor,
  RoofMetrics,
  Rule,
  SurfacePalette,
  TextureGroup,
} from "@cityjson/navara-core";
import type { CellKey } from "./tileGrid";

/** One image a cell's groups reference, by the LAYER-wide texture index the
 *  worker's appearance merger assigned (stable for the life of the open). */
export interface CellTexture {
  readonly index: number;
  readonly texture: CityTexture;
}

export interface CellGeometry {
  readonly positions: Float32Array; // 3 per vertex
  readonly normals: Float32Array; // 3 per vertex
  readonly baseColors: Float32Array; // 3 per vertex
  readonly ruleColors: Float32Array | null;
  readonly objectIndices: Uint32Array; // 1 per vertex
  readonly surfaceIndices: Uint32Array; // 1 per vertex
  readonly objectKeys: string[];
  readonly triangleCount: number;
  /** Under a texture theme only: 2 per vertex, and one vertex range per
   *  image (`buildCityMeshArrays`); `null`/absent otherwise. */
  readonly uvs?: Float32Array | null;
  readonly textureGroups?: ReadonlyArray<TextureGroup> | null;
  /** The definitions behind `textureGroups`' indices. Absent/empty when
   *  untextured. */
  readonly textures?: ReadonlyArray<CellTexture>;
}

/**
 * A resident roof surface's metrics plus the LoD of the surface itself.
 *
 * `toObjectRecords` runs on the whole cell model, so an object with geometry at
 * several LoDs contributes roof surfaces at all of them;
 * `ResidentObjectRecord.lod` is the OBJECT's LoD and cannot tell them apart. A
 * widening of `RoofMetrics`, so every existing reader keeps working untouched.
 */
export interface ResidentRoofMetrics extends RoofMetrics {
  readonly lod: string | null;
}

/** A streaming layer's object payload. NOT a CityObject — CityObject.surfaces
 *  is non-optional, and rings are fetched on demand instead (see 'surfaces'). */
export interface ResidentObjectRecord {
  readonly id: string;
  readonly objectType: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly bbox: BBox3;
  readonly lod: string | null;
  readonly surfaceCount: number;
  readonly roofMetrics: ReadonlyArray<ResidentRoofMetrics>;
  /**
   * Distinct non-null `Surface.lod` values over ALL of this object's surfaces,
   * whatever their semantic type, in the order first seen.
   *
   * The main thread's spec §7 contributor rule asks "does this feature's part
   * have GEOMETRY at the chosen LoD" — a wall-only part counts. `roofMetrics`
   * cannot answer that and `surfaceCount` has no LoD breakdown, so the answer
   * is carried explicitly. Short: a handful of labels per record.
   */
  readonly geometryLods: ReadonlyArray<string>;
  readonly footprintAreaSqM: number;
  readonly volumeCuM: number | null;
  readonly parents: ReadonlyArray<string>;
  readonly children: ReadonlyArray<string>;
}

/** Which worker entry a stream runs in: each format has its own worker chunk,
 *  both speaking this protocol. */
export type WorkerFormat = "flatcitybuf" | "cityparquet";

/**
 * What a stream reads from: one remote file, one local file, or a set of
 * either (a dataset split across files). Structured-cloneable, so it travels
 * to the worker as is. The FlatCityBuf worker admits exactly one source.
 */
export type StreamSource =
  | { readonly url: string }
  | { readonly blob: Blob }
  | { readonly urls: ReadonlyArray<string> }
  | { readonly blobs: ReadonlyArray<Blob> };

/**
 * Metres added to every vertex's geodetic height, and to each cell's ENU frame
 * origin: the geoid undulation at the layer (CityJSON z is orthometric, the
 * ENU frame sits on the WGS84 ellipsoid — see Global Constraints -> Vertical
 * datum). The PLUGIN resolves it (`geoidHeightAt`, or the caller's explicit
 * override) before sending `open`, so the worker can bake every cell in the
 * right frame from the very first fetch and never has to perform a network
 * request of its own. Omitted means 0, i.e. "treat z as ellipsoidal".
 */
interface OpenExtras {
  readonly heightOffset?: number;
  /** The host's surface palette overrides (CSS hex, structured-cloneable),
   *  baked into every cell's base colours. Omitted means core's defaults. */
  readonly surfaceColors?: SurfacePalette;
  /** Names the source across opens (the registry sends the layer id). Two
   *  opens that both carry one are the same source exactly when the keys are
   *  equal — the only way to recognise a Blob again, since postMessage
   *  structured-clones it into a new object on every request. Without a key
   *  the worker compares the sources themselves. */
  readonly sourceKey?: string;
}

export type WorkerRequest =
  | ({ type: "open"; id: number; source: StreamSource } & OpenExtras)
  | { type: "probe"; id: number; bbox: [number, number, number, number] }
  | {
      type: "fetch";
      id: number;
      bbox: [number, number, number, number];
      level: number;
      cells: CellKey[];
      lod: string | null;
      /** First-level object types whose geometry this fetch must NOT bake —
       *  hiding "Building" also hides its BuildingParts. The cell's own model
       *  and its `objects` records stay unfiltered. */
      hiddenTypes: ReadonlyArray<string>;
      rules: ReadonlyArray<Rule>;
      rulesEnabled: boolean;
      /** Which appearance theme to bake (texture: UVs + groups; material:
       *  diffuse base colours); `null`/omitted for the plain colours. */
      appearance?: AppearanceTheme | null;
    }
  | {
      type: "recolor";
      id: number;
      cells: CellKey[];
      rules: ReadonlyArray<Rule>;
      rulesEnabled: boolean;
    }
  | { type: "surfaces"; id: number; objectId: string }
  | { type: "evict"; id: number; cells: CellKey[] }
  | { type: "cancel"; id: number }
  | { type: "close"; id: number };

export type WorkerResponse =
  | { type: "opened"; id: number; header: unknown; admission: unknown }
  | { type: "probed"; id: number; count: number }
  | {
      type: "cell";
      id: number;
      key: CellKey;
      geometry: CellGeometry;
      objects: ResidentObjectRecord[];
      surfaceAttrKeys: string[];
      lodsSeen: string[];
      /** The BUCKET frame this cell's record bboxes are in, and the frame the
       *  main thread rebuilds the cell's own ENU placement from (cell centre
       *  -> lng/lat -> `makeEnuFrame`). `null` for a source whose index is a
       *  metric CRS, where the layer's EPSG answers both. It duplicates the
       *  header's descriptor deliberately: a cell is adopted on its own, and a
       *  placement looked up elsewhere is a placement that can disagree. */
      frame?: LocalMetricFrameDescriptor | null;
      /** Every appearance theme the worker has seen so far across the open
       *  file — learned like the LoD ladder, offered to the user as it grows. */
      appearanceThemes?: AppearanceTheme[];
      /** What the WORKER retains for this cell (its decoded `CityModel` plus
       *  the arrays it copied), estimated structurally — never what the
       *  transferred geometry costs, which with every type hidden is zero
       *  while the worker still holds the rows. The main thread adds it to
       *  the geometry bytes it meters, so residency is bounded by what is
       *  really held on both sides (Codex milestone review, Critical). */
      retainedBytes: number;
    }
  | { type: "recolored"; id: number; key: CellKey; ruleColors: Float32Array }
  | { type: "surfaceData"; id: number; objectId: string; surfaces: unknown[] }
  | { type: "done"; id: number }
  | {
      type: "error";
      id: number;
      message: string;
      code?: string;
      aborted: boolean;
    };

/**
 * A zero-triangle `CellGeometry`. Used by `useTileStreaming.ts` to mark a
 * requested cell that the worker's `fetch` genuinely queried and found
 * nothing in (as opposed to one that was never requested at all) — the
 * worker only ever emits a `'cell'` message for a POPULATED bucket
 * (`fcb.worker.ts`'s `fetch` handler), so a sparse cell's absence from the
 * response stream is otherwise indistinguishable from "not yet fetched,"
 * which is exactly what let a sparse viewport bypass hysteresis forever
 * (B5 in the 2026-07-28 final review). Trivially satisfies
 * `assertCellGeometry`'s invariants (every length is `0 === triangleCount*3*n`).
 */
export function emptyCellGeometry(): CellGeometry {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    baseColors: new Float32Array(0),
    ruleColors: null,
    objectIndices: new Uint32Array(0),
    surfaceIndices: new Uint32Array(0),
    objectKeys: [],
    triangleCount: 0,
    uvs: null,
    textureGroups: null,
    textures: [],
  };
}

/** Throws if a received cell violates the length invariants. */
export function assertCellGeometry(g: CellGeometry): void {
  const v = g.triangleCount * 3;
  const check = (name: string, len: number, want: number) => {
    if (len !== want) {
      throw new Error(`cell geometry ${name}: expected ${want}, got ${len}`);
    }
  };
  check("positions", g.positions.length, v * 3);
  check("normals", g.normals.length, v * 3);
  check("baseColors", g.baseColors.length, v * 3);
  check("objectIndices", g.objectIndices.length, v);
  check("surfaceIndices", g.surfaceIndices.length, v);
  if (g.ruleColors !== null) check("ruleColors", g.ruleColors.length, v * 3);
  if (g.uvs) check("uvs", g.uvs.length, v * 2);
  if (g.textureGroups) {
    let covered = 0;
    for (const group of g.textureGroups) {
      if (group.start !== covered) {
        throw new Error(
          `cell geometry textureGroups: group starts at ${group.start}, expected ${covered}`,
        );
      }
      covered += group.count;
    }
    check("textureGroups coverage", covered, v);
  }
}
