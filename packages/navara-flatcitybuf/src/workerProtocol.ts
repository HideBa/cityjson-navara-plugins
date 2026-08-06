import type { BBox3, RoofMetrics, Rule } from "@cityjson/navara-core";
import type { CellKey } from "./tileGrid";

export interface CellGeometry {
  readonly positions: Float32Array; // 3 per vertex
  readonly normals: Float32Array; // 3 per vertex
  readonly baseColors: Float32Array; // 3 per vertex
  readonly ruleColors: Float32Array | null;
  readonly objectIndices: Uint32Array; // 1 per vertex
  readonly surfaceIndices: Uint32Array; // 1 per vertex
  readonly objectKeys: string[];
  readonly triangleCount: number;
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
  readonly roofMetrics: ReadonlyArray<RoofMetrics>;
  readonly footprintAreaSqM: number;
  readonly volumeCuM: number | null;
  readonly parents: ReadonlyArray<string>;
  readonly children: ReadonlyArray<string>;
}

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
}

export type WorkerRequest =
  | ({ type: "open"; id: number; url: string } & OpenExtras)
  | ({ type: "open"; id: number; blob: Blob } & OpenExtras)
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
}
