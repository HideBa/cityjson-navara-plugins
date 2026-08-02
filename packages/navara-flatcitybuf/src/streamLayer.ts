/**
 * One streaming layer: the resident-cell payload, and the handle that owns it.
 *
 * `FcbStreamLayerHandle` is the pre-migration driver
 * (`src/features/streaming/useTileStreaming.ts`'s `commitStreamingLayer`) with
 * every store lookup replaced by its own state. What used to be
 * `useStreamStore` writes — status, ladder, version — are events, so a UI can
 * subscribe without a commit ever touching a global store.
 *
 * Engine-free by construction (Task B1's `NODE_IMPORT_SAFE = false` verdict):
 * the mesh factory is INJECTED (`meshFactory`), so this module never imports
 * `addCityMeshArrays` and therefore never reaches `@navaramap/*`. Task C11's
 * plugin supplies the real factory, built on `entryToArrays`.
 */
import type { EnuFrame, Rule } from "@cityjson/navara-core";
import {
  emptyCellGeometry,
  type CellGeometry,
  type ResidentObjectRecord,
} from "./workerProtocol";
import type { WorkerResponse } from "./workerProtocol";
import type { WorkerClient } from "./workerClient";
import type { CellCache } from "./cellCache";
import type { CellKey, Grid } from "./tileGrid";
import type { FcbHeaderModel } from "./fcbSource";
import type { CommitView } from "./throttleGates";
import type { PickRaySource } from "./navaraRays";
import { viewportFootprint, type Ray } from "./viewportFootprint";
import { buildLadder, type LodSelection } from "./levelPolicy";
import { LEVEL_SWAP_TIMEOUT_MS } from "./constants";
import {
  cellStatsFromGeometry,
  commitNormal,
  commitSwap,
  ladderEquals,
  lodToWireLabel,
  planCommit,
  type FetchedCell,
} from "./commitPlanner";
import {
  syncCellMeshes,
  type CellMesh,
  type CellMeshFactory,
} from "./cellMeshes";

/**
 * What the main-thread cache holds per resident cell. Mirrors the worker's
 * `'cell'` response payload (see workerProtocol.ts) minus the envelope
 * fields (`type`/`id`/`key` — `key` is the cache's own map key, not part of
 * the value). This is what the scene layer builds `CellSceneState`
 * (mesh/pickingIndex/baseColors/ruleColors) from, and what the inspector/
 * table read object attributes from without re-fetching.
 */
export interface CellEntry {
  readonly geometry: CellGeometry;
  readonly objects: ReadonlyArray<ResidentObjectRecord>;
  readonly surfaceAttrKeys: ReadonlyArray<string>;
  readonly lodsSeen: ReadonlyArray<string>;
  /** The layer's `rulesEnabled`/`rules` at the moment THIS cell's fetch was
   *  dispatched (`commitStreamingLayer`) — exactly what `geometry.ruleColors`
   *  was computed from. A fetch can still be in flight when the user edits a
   *  rule; if it lands afterwards, the layer's CURRENT rules (by the time the
   *  scene installs this entry) may already differ from these. Comparing the
   *  two is how the scene's cell sync detects a newly-installed cell carrying
   *  stale colors and asks for an immediate recolor — otherwise nothing would
   *  ever revisit it: the "rules changed" effect only recolors cells that were
   *  ALREADY resident at the moment it ran, and a cell arriving later never
   *  triggers it again on its own (B2, 2026-07-28 final review). */
  readonly builtWithRulesEnabled: boolean;
  readonly builtWithRules: ReadonlyArray<Rule>;
}

export function emptyCellEntry(
  rulesEnabled: boolean,
  rules: ReadonlyArray<Rule>,
): CellEntry {
  return {
    geometry: emptyCellGeometry(),
    objects: [],
    surfaceAttrKeys: [],
    lodsSeen: [],
    builtWithRulesEnabled: rulesEnabled,
    builtWithRules: rules,
  };
}

// ---------------------------------------------------------------------
// The layer handle.
// ---------------------------------------------------------------------

export type StreamStatus =
  "idle" | "probing" | "fetching" | "too-far" | "error";

/** Every subscribe method returns its own unsubscribe. */
export interface StreamLayerEvents {
  onStatus(
    cb: (status: StreamStatus, message: string | null) => void,
  ): () => void;
  onCommit(cb: (version: number) => void): () => void;
  onLadder(cb: (ladder: ReadonlyArray<string>) => void): () => void;
}

export interface FcbStreamLayerHandleOptions {
  readonly id: string;
  readonly client: WorkerClient;
  readonly grid: Grid;
  readonly header: FcbHeaderModel;
  readonly cache: CellCache<CellEntry>;
  /** The layer's own ENU frame. Its z = 0 plane is the footprint's ground
   *  plane, and it is the anchor `fitLayer` flies to. */
  readonly frame: EnuFrame;
  /** Geodetic -> source CRS. `null` for an unprojectable point, which
   *  `viewportFootprint` turns into "no usable footprint". */
  readonly toSourceXY: (
    lng: number,
    lat: number,
  ) => readonly [number, number] | null;
  readonly toLngLat: (x: number, y: number) => readonly [number, number];
  /** Vertical-datum offset already applied by the worker (Task C5 Step 4b).
   *  Each cell's ENU frame must be rebuilt with the same value or every cell
   *  floats/sinks by it. */
  readonly heightOffsetM: number;
  /** Injected: builds one mesh per resident cell. Keeps this module free of
   *  @navaramap/* — Task C11's plugin supplies the real implementation. */
  readonly meshFactory: CellMeshFactory;
  /** Injected: screen point -> ECEF ray, for `resolvePick` (Tasks C4/C10b). */
  readonly pickRays: PickRaySource | null;
}

type Listener<T extends unknown[]> = (...args: T) => void;

/** Notifies a snapshot of the set, so a handler that unsubscribes (or
 *  subscribes) while being called cannot corrupt the iteration. */
function emit<T extends unknown[]>(
  listeners: ReadonlySet<Listener<T>>,
  ...args: T
): void {
  for (const cb of [...listeners]) cb(...args);
}

function subscribe<T extends unknown[]>(
  listeners: Set<Listener<T>>,
  cb: Listener<T>,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * One camera-driven FlatCityBuf layer.
 *
 * `commit(rays)` is the whole pipeline: footprint -> probe -> level/LoD ->
 * fetch -> cache commit -> mesh sync. It is driven by `settleController`
 * (Task C7) on `moveend`, never per frame; `abortInFlight()` is what that
 * controller calls on the first event of a gesture.
 *
 * Tasks C10b/C11 add the rest of the surface (`setVisible`/`setLod`/
 * `setRules`/`setHighlight`/`resolvePick`/`getBoundsGeodetic`/
 * `triangleCount`/`getResidentModel`/`fetchSurfaces`/`delete`). The state
 * those setters write is already held here, because the commit loop reads it.
 */
export class FcbStreamLayerHandle implements StreamLayerEvents {
  readonly id: string;
  readonly grid: Grid;
  readonly header: FcbHeaderModel;
  readonly frame: EnuFrame;

  private readonly options: FcbStreamLayerHandleOptions;
  private readonly cache: CellCache<CellEntry>;
  /** Mesh mirror of `cache`, keyed identically. Owned here (not by
   *  `syncCellMeshes`, which mutates it in place) so it survives commits. */
  private readonly cells = new Map<CellKey, CellMesh>();

  private _level: number | null = null;
  private _ladder: ReadonlyArray<string> = [];
  private _version = 0;
  private _status: StreamStatus = "idle";
  private _message: string | null = null;
  private _lastCommit: CommitView | null = null;
  /** "The LoD the currently resident cells were fetched under" — the driver's
   *  own bookkeeping for `planCommit`'s `lodChanged`, not published state. */
  private _lastLod: LodSelection | null = null;

  // Written by Task C10b's setters; read by the commit loop today.
  private _visible = true;
  private _rules: ReadonlyArray<Rule> = [];
  private _rulesEnabled = false;
  private _lodMode: "auto" | "manual" = "auto";
  private _selectedLod: string | null = null;

  /** Keys whose baked colours were stale on arrival (B2). Task C10b's
   *  `recolorCells` drains these; C10a only records them. */
  private pendingRecolor: CellKey[] = [];

  private readonly statusListeners = new Set<
    Listener<[StreamStatus, string | null]>
  >();
  private readonly commitListeners = new Set<Listener<[number]>>();
  private readonly ladderListeners = new Set<
    Listener<[ReadonlyArray<string>]>
  >();

  constructor(options: FcbStreamLayerHandleOptions) {
    this.options = options;
    this.id = options.id;
    this.grid = options.grid;
    this.header = options.header;
    this.frame = options.frame;
    this.cache = options.cache;
  }

  get level(): number | null {
    return this._level;
  }
  get ladder(): ReadonlyArray<string> {
    return this._ladder;
  }
  get version(): number {
    return this._version;
  }
  /** Last emitted status. Published as state as well as an event so a UI that
   *  mounts after a commit renders the current one instead of a stale "idle". */
  get status(): StreamStatus {
    return this._status;
  }
  get message(): string | null {
    return this._message;
  }

  onStatus(
    cb: (status: StreamStatus, message: string | null) => void,
  ): () => void {
    return subscribe(this.statusListeners, cb);
  }
  onCommit(cb: (version: number) => void): () => void {
    return subscribe(this.commitListeners, cb);
  }
  onLadder(cb: (ladder: ReadonlyArray<string>) => void): () => void {
    return subscribe(this.ladderListeners, cb);
  }

  /**
   * Abandon whatever this layer has in flight: bump the epoch so an
   * already-dispatched response can never be adopted, and tell the worker to
   * stop its range reads. Called by `settleController`'s `onFirstChange` at
   * the START of a gesture — the point of it is that the user is now looking
   * somewhere else, so finishing the old fetch is wasted work.
   *
   * `notify` is genuinely fire-and-forget (`workerClient.ts`): it registers no
   * pending entry, so there is nothing here for a `terminate()`-triggered
   * rejection to leak, and no `catch` is needed.
   */
  abortInFlight(): void {
    this.options.client.newEpoch();
    this.options.client.notify({ type: "cancel" });
  }

  /**
   * Runs the full footprint -> probe -> level -> fetch/evict/sync pipeline for
   * one settled commit.
   *
   * Bumps its own epoch at the start (in addition to the one `abortInFlight`
   * already bumped when the interaction began). The double bump is deliberate:
   * nothing captures `abortInFlight`'s epoch value, so re-bumping here is the
   * only way this call gets a value that is current as THIS commit starts, and
   * bumping twice is harmless — `isCurrent` only ever compares against "the
   * latest bump", it never counts them.
   *
   * Never rejects. Everything below awaits the `WorkerClient` at least once,
   * and `terminate()` REJECTS every promise it still has in flight rather than
   * leaving it hanging — a real race if the user pans right as a layer is
   * removed. Caught here so that race surfaces as an error status rather than
   * an unhandled rejection.
   */
  async commit(rays: readonly [Ray, Ray, Ray, Ray]): Promise<void> {
    const client = this.options.client;
    const epoch = client.newEpoch();

    try {
      const footprint = viewportFootprint({
        cornerRays: rays,
        frame: this.frame,
        toSourceXY: this.options.toSourceXY,
      });

      let probeCount: number | null = null;
      if (footprint !== null) {
        this.emitStatus("probing", null);
        const probeResp = await client.send({
          type: "probe",
          bbox: footprint.bbox,
        });
        if (!client.isCurrent(epoch)) return;
        if (probeResp.type !== "probed") {
          this.emitStatus(
            "error",
            probeResp.type === "error"
              ? probeResp.message
              : `unexpected probe response: ${probeResp.type}`,
          );
          return;
        }
        probeCount = probeResp.count;
      }

      const plan = planCommit({
        footprint,
        probeCount,
        grid: this.grid,
        cache: this.cache,
        prevLevel: this._level,
        prevCommit: this._lastCommit,
        prevLod: this._lastLod,
        ladder: this._ladder,
        lodMode: this._lodMode,
        selectedLod: this._selectedLod,
      });

      if (plan.kind === "too-far") {
        this.emitStatus("too-far", `Zoom in (${plan.reason})`);
        return;
      }
      if (plan.kind === "skip") {
        this.emitStatus("idle", null);
        return;
      }
      // Unreachable: plan.kind is "commit" only when footprint is non-null.
      if (footprint === null) return;

      this.emitStatus("fetching", null);
      const fetched = new Map<CellKey, FetchedCell>();
      let fetchError: string | null = null;
      // Snapshot of what THIS fetch asks the worker to bake into
      // `geometry.ruleColors`. Read once, so every cell of this commit is
      // stamped identically even if the user edits a rule mid-flight (see
      // `CellEntry`'s doc comment, B2).
      const rules = this._rules;
      const rulesEnabled = this._rulesEnabled;

      const fetchPromise = client
        .sendStreaming(
          {
            type: "fetch",
            bbox: footprint.bbox,
            level: plan.level,
            cells: [...plan.toFetch],
            lod: lodToWireLabel(plan.lod),
            rules,
            rulesEnabled,
          },
          (msg: WorkerResponse) => {
            if (msg.type === "cell") {
              fetched.set(msg.key, {
                entry: {
                  geometry: msg.geometry,
                  objects: msg.objects,
                  surfaceAttrKeys: msg.surfaceAttrKeys,
                  lodsSeen: msg.lodsSeen,
                  builtWithRulesEnabled: rulesEnabled,
                  builtWithRules: rules,
                },
                stats: cellStatsFromGeometry(msg.geometry),
              });
            } else if (msg.type === "error") {
              fetchError = msg.message;
            }
          },
        )
        .then(() => "done" as const);

      let swapTimer: ReturnType<typeof setTimeout> | null = null;
      const outcome = plan.isSwap
        ? await Promise.race([
            fetchPromise,
            new Promise<"timeout">((resolve) => {
              swapTimer = setTimeout(
                () => resolve("timeout"),
                LEVEL_SWAP_TIMEOUT_MS,
              );
            }),
          ])
        : await fetchPromise;
      // The fetch usually wins the race; clearing keeps the loser's timer from
      // holding the event loop (and a test process) open until it fires.
      if (swapTimer !== null) clearTimeout(swapTimer);

      if (!client.isCurrent(epoch)) return;

      if (outcome === "timeout") {
        client.notify({ type: "cancel" });
        if (fetched.size > 0) {
          // The worker may have gone on to fully decode and cache some of
          // these anyway, right as the deadline passed — `cancel` only helps
          // while it is still mid-flight. Either way THIS commit never adopts
          // them (we return without committing), so the worker must not keep
          // them either, or they become worker-only entries the main thread's
          // evict can never reach (B3).
          client.notify({ type: "evict", cells: [...fetched.keys()] });
        }
        this.emitStatus(
          "error",
          "Level swap timed out; kept the previous level",
        );
        return;
      }
      if (fetchError !== null) {
        this.emitStatus("error", fetchError);
        return;
      }

      // Every key this commit asked for that did NOT come back as a 'cell'
      // message was genuinely queried and found empty — the worker only emits
      // 'cell' for a POPULATED bucket (fcb.worker.ts). Backfilling a
      // zero-triangle entry is what makes it count as RESIDENT from now on;
      // without it, an empty cell is indistinguishable from "never fetched",
      // so `planCommit`'s `missing` filter treats it as a hole forever —
      // bypassing hysteresis and re-running full selection/decode on every
      // settle for any viewport with even one sparse cell (B5).
      for (const key of plan.toFetch) {
        if (!fetched.has(key)) {
          fetched.set(key, {
            entry: emptyCellEntry(rulesEnabled, rules),
            stats: { triangles: 0, bytes: 0 },
          });
        }
      }

      // Fold this commit's observed LoD labels into the persisted ladder
      // (B1). A UNION with the existing ladder (not a replacement) makes it a
      // monotonically growing record of every label ever seen for this layer,
      // never shrinking as cells are evicted.
      const observedLods: string[] = [];
      for (const { entry } of fetched.values()) {
        observedLods.push(...entry.lodsSeen);
      }
      if (observedLods.length > 0) {
        const newLadder = buildLadder([...this._ladder, ...observedLods]);
        if (!ladderEquals(newLadder, this._ladder)) {
          this._ladder = newLadder;
          emit(this.ladderListeners, newLadder);
        }
      }

      const evicted = plan.isSwap
        ? commitSwap(this.cache, plan.desired, fetched)
        : commitNormal(this.cache, plan.desired, fetched);

      if (evicted.length > 0) {
        client.notify({ type: "evict", cells: evicted });
      }

      this._lastLod = plan.lod;
      this._level = plan.level;
      this._lastCommit = plan.commitView;
      this.emitStatus("idle", null);
      if (fetched.size > 0 || evicted.length > 0) {
        this._version++;
        this.syncMeshes();
        emit(this.commitListeners, this._version);
      }
    } catch (err) {
      this.emitStatus(
        "error",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Mirror the cache into engine meshes: build one per newly resident cell,
   * drop the handle of every cell the cache no longer holds, and rebuild a
   * cell whose ENTRY changed under an unchanged key (B1).
   *
   * `syncCellMeshes` returns the keys it (re)built whose baked colours no
   * longer match the current rules — a fetch that was in flight when the user
   * edited a rule and landed carrying the OLD ones. Nothing else revisits
   * those: the "rules changed" path only recolors cells that were ALREADY
   * resident when it ran (B2).
   */
  private syncMeshes(): void {
    const stale = syncCellMeshes({
      cache: this.cache,
      cells: this.cells,
      grid: this.grid,
      toLngLat: this.options.toLngLat,
      factory: this.options.meshFactory,
      visible: this._visible,
      rules: this._rules,
      rulesEnabled: this._rulesEnabled,
      heightOffsetM: this.options.heightOffsetM,
      layerId: this.id,
    });
    if (stale.length > 0) this.recolorCells(stale);
  }

  /** Task C10b implements the round trip (worker `recolor` -> `setColors`).
   *  C10a only records the request, so the commit loop's B2 hand-off is wired
   *  and observable now rather than being added later. */
  private recolorCells(keys: ReadonlyArray<CellKey>): void {
    this.pendingRecolor.push(...keys);
  }

  private emitStatus(status: StreamStatus, message: string | null): void {
    this._status = status;
    this._message = message;
    emit(this.statusListeners, status, message);
  }

  // --- test seams -----------------------------------------------------
  // Residency and the mesh mirror are private state with no public reader
  // until Task C10b/C11 add one; these let the commit-loop regressions assert
  // on them without reaching into privates.

  /** @internal */
  cacheKeysForTest(): CellKey[] {
    return this.cache.keys();
  }
  /** @internal */
  cellsForTest(): ReadonlyMap<CellKey, CellMesh> {
    return this.cells;
  }
  /** @internal */
  pendingRecolorForTest(): ReadonlyArray<CellKey> {
    return this.pendingRecolor;
  }
}
