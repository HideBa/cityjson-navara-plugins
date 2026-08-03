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
import type { EnuFrame, Rule, Surface } from "@cityjson/navara-core";
// `paintLayers` is a VALUE import, deliberately: the highlight layering a
// streaming cell gets must be byte-for-byte the one a static layer gets, and a
// second copy here would drift. `@cityjson/navara-cityjson`'s barrel is
// engine-free and Node-importable (its own doc comment; the `@navaramap/*`
// modules live behind the separate `/plugin` entry point), so this does not
// break the engine-binding rule.
import { paintLayers } from "@cityjson/navara-cityjson";
import type {
  EcefRay,
  GeodeticBounds,
  PickedFeatureLike,
  RaycastHit,
  ScreenPoint,
  Selection,
} from "@cityjson/navara-cityjson";
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
import { toRay, type PickRaySource } from "./navaraRays";
import { viewportFootprint, type Ray } from "./viewportFootprint";
import { createResidentModelMemo, type ResidentModel } from "./residentModel";
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
  /**
   * Called when {@link FcbStreamLayerHandle.setLod} actually changes the LoD
   * selection. A LoD change must refetch even for a viewport that has not
   * moved — hysteresis would otherwise skip the commit and leave the old LoD
   * resident indefinitely — and this handle deliberately does not own the
   * camera, so the driver (Task C13) supplies the forced-commit hook (B1).
   */
  readonly onLodChanged?: () => void;
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
 * Everything else is the parity surface: `setRules`/`setLod`/`setVisible`
 * drive what the next commit fetches and how it is coloured, and
 * `setHighlight`/`resolvePick`/`getBoundsGeodetic`/`triangleCount` make the
 * layer a full participant in the app's picking, highlighting, fit and
 * triangle readout — the four members `InteractionHandle` (Task C13) shares
 * with a static `CityModelHandle`. Only STYLING differs between the two:
 * rules are baked in the worker here, never evaluated on the main thread
 * (shared contract -> Streaming styling).
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

  private _visible = true;
  private _rules: ReadonlyArray<Rule> = [];
  private _rulesEnabled = false;
  private _lodMode: "auto" | "manual" = "auto";
  private _selectedLod: string | null = null;

  /** Highlight state, held rather than fire-and-forget: cells arrive
   *  asynchronously, so a cell that lands while an object is selected has to
   *  be able to look up what to paint. Already filtered to this layer. */
  private _selections: ReadonlyArray<Selection> = [];
  private _hovered: Selection | null = null;

  /** Set by {@link delete}. Every await in `commit` re-checks it, so a fetch
   *  that resolves after the layer was removed can never admit cells into a
   *  cache nobody owns, build meshes into a view it was detached from, or
   *  report an error for a layer that no longer exists (the old driver's
   *  `if (!latest) return` / catch guard, useTileStreaming.ts). */
  private _deleted = false;
  /** One console warning per layer, however many unresolvable engine picks
   *  arrive (see {@link warnUnresolvablePick}). */
  private warnedUnresolvablePick = false;

  private readonly residentModel = createResidentModelMemo();

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
    if (this._deleted) return;
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
        if (this.isStale(epoch)) return;
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
      // The swap deadline exists to bound how long a level change can leave
      // the user staring at the OLD level, and its failure mode is "keep what
      // you had". The FIRST commit of a layer is also a swap by construction
      // (`prevLevel` is null, so `levelChanged` is true) but has nothing to
      // keep — timing it out just hands back an empty layer, and there is no
      // previous level to roll back to. That is what the M7.5 browser smoke
      // hit: the auto-fit frames the whole file, the initial cover is the
      // whole file, and on a slow host 1.5 s is not enough, so a `.fcb` opened
      // as the first layer rendered nothing at all. Race only when there is
      // something to fall back to.
      const canRollBack = this._level !== null;
      const outcome =
        plan.isSwap && canRollBack
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

      if (this.isStale(epoch)) return;

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
      // A layer removed mid-commit is the expected source of this rejection
      // (`delete()` -> `terminate()` rejects everything in flight); there is
      // nobody left to show an error to, and emitting one would resurrect a
      // status for a layer that no longer exists.
      if (this._deleted) return;
      this.emitStatus(
        "error",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** "This commit's result must be thrown away": a newer commit (or an
   *  `abortInFlight`) bumped the epoch, or the layer was deleted while this
   *  one was awaiting the worker. */
  private isStale(epoch: number): boolean {
    return this._deleted || !this.options.client.isCurrent(epoch);
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
    if (stale.length > 0) void this.recolorCells(stale);
    // Only when something is actually highlighted. With no selection every
    // cell `syncCellMeshes` just built already carries exactly what
    // `paintCell` would write, so this would be a full colour copy per
    // resident cell on every settle for no visible change. The CLEAR path
    // (`setHighlight([])`) calls `applyHighlight` unconditionally, so a
    // cleared selection still repaints.
    if (this._selections.length > 0 || this._hovered) this.applyHighlight();
  }

  /**
   * Rebake rule colours in the worker and install them on the resident cells.
   *
   * This is `recolorStreamingCells` (`src/scene/CitySceneR3F.tsx:1539-1611`)
   * moved into the class, with the store lookups replaced by `this` and the
   * bare `current.ruleColors = msg.ruleColors` field write replaced by a real
   * repaint of the cell (see {@link paintCell}) — nothing downstream re-reads
   * `ruleColors` on our behalf any more.
   *
   * `onlyKeys`, when given, restricts the request to those cells instead of
   * every resident one: the B2 hand-off from {@link syncMeshes}, which flags
   * exactly the cells that landed carrying colours baked from rules the user
   * has since edited. Requesting every cell there would re-bake the (already
   * correct) rest on every single settle.
   *
   * Never rejects: a layer removed mid-request terminates its `WorkerClient`,
   * which rejects everything in flight, and there is then nothing left to
   * recolor.
   */
  private async recolorCells(onlyKeys?: ReadonlyArray<CellKey>): Promise<void> {
    if (this._deleted) return;
    if (onlyKeys && onlyKeys.length === 0) return;

    // Snapshot the CellMesh OBJECTS this request is for, not just their keys.
    // A level/LoD swap can replace the cell at the SAME key with differently
    // sized geometry — driven purely by camera movement, entirely independent
    // of this round trip — while the request is in flight. Applying a response
    // computed for the OLD geometry to the NEW cell would misapply colours at
    // best and, since `setColors` writes into a fixed-length live attribute,
    // silently truncate or throw at worst. Object identity is what lets the
    // response handler tell "still the cell I asked about" from "rebuilt since"
    // — the same technique `syncCellMeshes` uses via `CellMesh.sourceEntry`.
    const targets = new Map<CellKey, CellMesh>();
    for (const key of onlyKeys ?? this.cells.keys()) {
      const cell = this.cells.get(key);
      if (cell) targets.set(key, cell);
    }
    if (targets.size === 0) return;

    // Read once, so every cell of this request is baked from the same rules
    // even if the user edits another one mid-flight (the same snapshot
    // discipline `commit` applies to a fetch).
    const rules = this._rules;
    const rulesEnabled = this._rulesEnabled;

    try {
      await this.options.client.sendStreaming(
        { type: "recolor", cells: [...targets.keys()], rules, rulesEnabled },
        (msg: WorkerResponse) => {
          if (msg.type !== "recolored") return;
          const target = targets.get(msg.key);
          const current = this.cells.get(msg.key);
          // `current` missing: evicted since the snapshot (the same race
          // fcb.worker.ts's own recolor handler skips rather than errors on).
          // `current !== target`: rebuilt under the same key by a swap. Either
          // way this response is for geometry that no longer exists.
          if (!target || current !== target) return;
          current.ruleColors = msg.ruleColors;
          // Not a bare `setColors(msg.ruleColors)`: an active highlight has to
          // survive a recolor, and `paintCell` layers it back over the new
          // rule colours in the same pass.
          this.paintCell(current);
        },
      );
    } catch {
      // Layer removed / worker terminated mid-request.
    }
  }

  // ---------------------------------------------------------------------
  // State setters (Task C10b).
  // ---------------------------------------------------------------------

  /**
   * The streaming counterpart to a static layer's `setStyle`: rules travel to
   * the worker as data and are baked there, so a streaming layer never sees a
   * `SurfaceStyleEvaluator` (shared contract -> Streaming styling).
   *
   * A no-op set is dropped rather than sent — the app re-pushes layer state on
   * every sync, and each round trip re-bakes every resident cell.
   */
  setRules(rules: ReadonlyArray<Rule>, enabled: boolean): void {
    if (
      this._rulesEnabled === enabled &&
      JSON.stringify(this._rules) === JSON.stringify(rules)
    ) {
      return;
    }
    this._rules = rules;
    this._rulesEnabled = enabled;
    void this.recolorCells();
  }

  /**
   * Which LoD the next fetch asks for. Forces a commit through
   * `onLodChanged`: `planCommit` treats a LoD change as a swap, but only ever
   * runs when the driver commits, and a LoD change alone does not move the
   * camera — without the hook, an unmoved viewport would keep the old LoD
   * resident until the user happened to pan (B1).
   */
  setLod(mode: "auto" | "manual", lod: string | null): void {
    if (this._lodMode === mode && this._selectedLod === lod) return;
    this._lodMode = mode;
    this._selectedLod = lod;
    this.options.onLodChanged?.();
  }

  get lodMode(): "auto" | "manual" {
    return this._lodMode;
  }
  get selectedLod(): string | null {
    return this._selectedLod;
  }
  get visible(): boolean {
    return this._visible;
  }

  /** Fans out to every resident cell AND is remembered, because
   *  `syncCellMeshes` applies it to each cell it builds later — a layer hidden
   *  mid-pan must not have its next cells arrive visible. */
  setVisible(v: boolean): void {
    this._visible = v;
    for (const cell of this.cells.values()) cell.handle.setVisible(v);
  }

  /**
   * Full ring geometry for one object, on demand.
   *
   * `ResidentObjectRecord` deliberately excludes `Surface.rings`
   * (workerProtocol.ts), so the consumers that need them — rooftop solar
   * scoring, the Surfaces tab — fetch them for the one selected object rather
   * than every cell shipping every ring. Rejects (rather than resolving empty)
   * when the object is not resident in any cached cell, so the caller can tell
   * "no rings" from "wrong object".
   */
  async fetchSurfaces(objectId: string): Promise<readonly Surface[]> {
    if (this._deleted) {
      throw new Error(
        `FcbStreamLayerHandle("${this.id}"): fetchSurfaces after delete()`,
      );
    }
    const r = await this.options.client.send({ type: "surfaces", objectId });
    if (r.type === "surfaceData") {
      // The wire type is `unknown[]` because postMessage carries no static
      // type; fcb.worker.ts builds it from `obj.surfaces`, so this cast
      // documents that contract rather than asserting something unverified.
      return r.surfaces as Surface[];
    }
    throw new Error(
      r.type === "error"
        ? r.message
        : `unexpected worker response for 'surfaces': ${r.type}`,
    );
  }

  /** The resident cells merged into one flat model, memoised on `version`
   *  (Task C9) so repeated reads at the same commit are a comparison, not a
   *  rebuild. */
  getResidentModel(): ResidentModel {
    return this.residentModel(this.cache, this._version);
  }

  /**
   * Tear the layer down: stop the worker, drop every mesh.
   *
   * `terminate()` REJECTS every promise still awaiting a response instead of
   * leaving it hanging, so a `commit` racing this removal gets a real
   * rejection — caught there, and silenced by the `_deleted` flag this sets,
   * which every post-await guard in `commit` re-checks so a fetch that
   * resolves after this point can never admit cells or build meshes.
   * Idempotent.
   */
  delete(): void {
    if (this._deleted) return;
    this._deleted = true;
    // Best effort: `terminate()` on the next line usually kills the thread
    // before it processes this. It costs one postMessage and it is the only
    // thing that releases the reader cleanly if the worker does get to it.
    this.options.client.notify({ type: "close" });
    this.options.client.terminate();
    for (const cell of this.cells.values()) cell.handle.delete();
    this.cells.clear();
  }

  // ---------------------------------------------------------------------
  // Interaction parity (Task C10b). A streaming layer is a full participant
  // in picking, highlighting, fit and the triangle readout; only STYLING
  // differs from a static layer (shared contract -> Streaming styling).
  // ---------------------------------------------------------------------

  /** Sum over resident cells. `syncLayers` never puts a streaming layer in the
   *  app's `live` map, so this is the ONLY source of a streaming layer's
   *  triangle count — Task B10's `totalTriangles` reads it through the
   *  `InteractionHandle` registry (Task C13). */
  triangleCount(): number {
    let total = 0;
    for (const cell of this.cells.values())
      total += cell.handle.triangleCount();
    return total;
  }

  /**
   * Metres of geoid undulation baked into this layer's placement.
   *
   * Every cell's ENU frame is built with it (`heightOffsetM`, Task C5), so the
   * cursor readout has to subtract it again to report the z the source file
   * actually contains: `orthometric = ellipsoidal - heightOffset` (Global
   * Constraints -> Vertical datum). Without it the status bar reads ~43 m high
   * over a NAP model — the exact error the offset exists to remove, in the
   * other direction.
   */
  heightOffset(): number {
    return this.options.heightOffsetM;
  }

  /**
   * The layer's geodetic extent, from the FCB header's source-CRS extent.
   *
   * Available from the moment the layer is open — NOT gated on the first
   * commit. That gate used to exist ("don't frame a layer that has not proven
   * it has data") and it deadlocked the only workspace that needs it: cells
   * become resident only when the camera is already close enough for the cover
   * to fit the budget, so in an FCB-only workspace "Fit all" was a no-op and
   * the data was unreachable — the browser smoke in Task C14 could not get to
   * Delft at all. The header extent is known and trustworthy at open time (a
   * file without one never passes admission), so reporting it is what makes
   * "fly to this layer" the way IN rather than a reward for already being
   * there.
   *
   * Null only for a DELETED layer (its meshes are gone and it must drop out of
   * any fit union) or a header with no extent at all — the latter is defence,
   * not a supported path.
   *
   * The whole header extent, not the resident cells' union: the resident set
   * is a function of where the camera happens to be, so framing it would make
   * `fitLayer` a no-op that re-frames what you are already looking at.
   */
  getBoundsGeodetic(): GeodeticBounds | null {
    if (this._deleted) return null;
    const extent = this.header.extent;
    if (!extent) return null;
    const [minX, minY, minZ, maxX, maxY, maxZ] = extent;
    const corners: Array<readonly [number, number]> = [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ];
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    // All four corners, not just two: a projected CRS' graticule is not
    // axis-aligned in lng/lat, so the extreme lng can sit on either of two
    // corners depending on which side of the central meridian the file is.
    for (const [x, y] of corners) {
      const [lng, lat] = this.options.toLngLat(x, y);
      west = Math.min(west, lng);
      east = Math.max(east, lng);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    return {
      west,
      south,
      east,
      north,
      minHeight: minZ + this.options.heightOffsetM,
      maxHeight: maxZ + this.options.heightOffsetM,
    };
  }

  /**
   * Pick across resident cells.
   *
   * Mirrors `CityModelRegistry.resolvePick` (Task B7): a picked feature that
   * already carries our indices resolves directly; a screen point is raycast
   * against every resident cell and the NEAREST hit wins. The ray comes from
   * the INJECTED `pickRays` source (Task C4), never from `@navaramap/*`.
   */
  resolvePick(pick: ScreenPoint | PickedFeatureLike): Selection | null {
    if (!isScreenPoint(pick)) {
      const props = pick.properties;
      // A feature routed here that says it belongs elsewhere is not ours to
      // answer for (Task B15 routes by `layerId`; this is the backstop). The
      // id can ride on either the envelope or the properties bag, so both are
      // checked — an ABSENT id is not a mismatch, since the spike measured the
      // engine reporting `layerId: undefined` / `properties: null`.
      const claimed = pick.layerId ?? props?.layerId;
      if (typeof claimed === "string" && claimed !== this.id) return null;
      // There is deliberately NO `batchId` branch, exactly as on the static
      // path (`CityModelRegistry.resolvePick`, Task B7): the spike measured
      // `PickableMeshWrapper` allocating ONE uniform batch id for the whole
      // mesh (both triangles of the probe returned 4666372, with
      // `properties: null`), so a batch id is not a triangle index and
      // `batchIdMap()[batchId]` could only ever be a coincidence. A caller
      // that already knows the indices — a replayed pick, a test, a future
      // engine that reports them — is answered from `properties`.
      const objectIndex = props?.objectIndex;
      const surfaceIndex = props?.surfaceIndex;
      if (typeof objectIndex !== "number" || typeof surfaceIndex !== "number") {
        // The engine-pick signature: no indices to resolve with, and under
        // `pickable-wrapper` there never will be any.
        this.warnUnresolvablePick();
        return null;
      }
      const cellKey = props?.cellKey;
      const cell =
        typeof cellKey === "string" ? this.cells.get(cellKey) : undefined;
      // Not a warning: a replayed pick naming a cell that has since been
      // evicted (or never was resident here) is an ordinary race, not a
      // limitation of the pick path.
      if (!cell) return null;
      return this.selectionFor(cell, objectIndex, surfaceIndex);
    }

    const raw = this.options.pickRays?.getPickRay(pick.x, pick.y);
    if (raw === null || raw === undefined) return null;
    const ray = toRay(raw);
    const nearest = this.nearestCellHit({
      origin: { x: ray.origin[0], y: ray.origin[1], z: ray.origin[2] },
      direction: {
        x: ray.direction[0],
        y: ray.direction[1],
        z: ray.direction[2],
      },
    });
    if (!nearest) return null;
    return this.selectionFor(
      nearest.cell,
      nearest.hit.objectIndex,
      nearest.hit.surfaceIndex,
    );
  }

  /**
   * The raw form of {@link resolvePick}: distance included, so the APP's
   * cross-layer router can compare this layer's nearest hit against every other
   * layer's instead of taking whichever answers first
   * (`resolveNearestHit`, Task B15 — the fourth `InteractionHandle` member, and
   * the one the app actually calls on every mousemove).
   *
   * The hit carries its `cellKey`, which is what makes the round trip work: the
   * router hands the winning hit back through `resolvePick`, and an
   * `objectIndex` is meaningful only inside the cell it was measured in. A
   * static `CityModelHandle` needs no such field because it owns one mesh.
   */
  resolveRaycast(ray: EcefRay): RaycastHit | null {
    const nearest = this.nearestCellHit(ray);
    return nearest === null ? null : { ...nearest.hit, cellKey: nearest.key };
  }

  /**
   * NEAREST wins, not first. Resident cells overlap in screen space whenever
   * the ladder mixes levels or a tall building straddles a cell boundary, and
   * Map iteration order is insertion order — i.e. whichever cell happened to
   * commit first, which has nothing to do with what the user clicked. So every
   * candidate is raycast and the smallest distance taken.
   */
  private nearestCellHit(
    ray: EcefRay,
  ): { key: CellKey; cell: CellMesh; hit: RaycastHit } | null {
    let best: RaycastHit | null = null;
    let bestCell: CellMesh | null = null;
    let bestKey: CellKey | null = null;
    for (const [key, cell] of this.cells) {
      const hit = cell.handle.resolveRaycast(ray);
      if (!hit) continue;
      if (best === null || hit.distance < best.distance) {
        best = hit;
        bestCell = cell;
        bestKey = key;
      }
    }
    if (best === null || bestCell === null || bestKey === null) return null;
    return { key: bestKey, cell: bestCell, hit: best };
  }

  /**
   * Warn once that an engine pick event cannot be resolved to a surface.
   *
   * The streaming twin of `CityModelRegistry.warnUnresolvablePick` (Task B7),
   * and reachable for the same reason: under
   * `pickStrategy: "pickable-wrapper"` the engine's `PickedFeature` comes back
   * with `properties: null`, so it names neither the surface nor the resident
   * cell, and its `batchId` is per MESH rather than per triangle. The shipped
   * default is `"own-raycast"`, whose picks arrive as a `ScreenPoint` and
   * never reach here. Once per layer, because a pick event fires on every
   * click.
   */
  private warnUnresolvablePick(): void {
    if (this.warnedUnresolvablePick) return;
    this.warnedUnresolvablePick = true;
    console.warn(
      `[navara-flatcitybuf] layer "${this.id}": an engine pick event carried no surface indices, so it cannot be resolved — PickableMeshWrapper allocates one uniform batch id per mesh, not per triangle. Use the "own-raycast" strategy (the default) and route picks as screen points.`,
    );
  }

  /** Always a `SurfaceSelection`, exactly like the static path; the app
   *  narrows it to an object selection per `PickMode` (Task B12). */
  private selectionFor(
    cell: CellMesh,
    objectIndex: number,
    surfaceIndex: number,
  ): Selection | null {
    const objectId = cell.pickingIndex.objectKeys[objectIndex];
    if (objectId === undefined) return null;
    return { kind: "surface", layerId: this.id, objectId, surfaceIndex };
  }

  /**
   * Highlight over resident cells.
   *
   * Held as state, not fire-and-forget, because cells arrive asynchronously:
   * `syncMeshes` re-applies it after every commit so a cell that lands while
   * an object is selected renders highlighted immediately rather than on the
   * next user interaction.
   */
  setHighlight(sel: readonly Selection[], hovered?: Selection): void {
    this._selections = sel.filter((s) => s.layerId === this.id);
    this._hovered = hovered?.layerId === this.id ? hovered : null;
    this.applyHighlight();
  }

  private applyHighlight(): void {
    for (const cell of this.cells.values()) this.paintCell(cell);
  }

  /**
   * One cell's full colour stack: rule colours (or base colours) restored,
   * then hover and selection painted over them.
   *
   * `paintLayers` is Task B5's function, shared with the static layer path, so
   * the two cannot drift. It writes into `target` in place, which is why
   * `target` is a fresh buffer and never `cell.ruleColors`/`cell.baseColors`:
   * those two ARE the restore baseline (`entryToArrays` copies both branches
   * for the same reason).
   */
  private paintCell(cell: CellMesh): void {
    const source = cell.ruleColors ?? cell.baseColors;
    const painted = new Float32Array(source.length);
    paintLayers(
      painted,
      source,
      cell.sourceEntry.geometry.objectIndices,
      cell.sourceEntry.geometry.surfaceIndices,
      cell.pickingIndex.objectKeys,
      this._selections,
      this._hovered,
    );
    cell.handle.setColors(painted);
  }

  private emitStatus(status: StreamStatus, message: string | null): void {
    this._status = status;
    this._message = message;
    emit(this.statusListeners, status, message);
  }

  // --- test seams -----------------------------------------------------
  // Residency and the mesh mirror have no public reader (the resident MODEL
  // is the supported view of the former); these let the commit-loop
  // regressions assert on them without reaching into privates.

  /** @internal */
  cacheKeysForTest(): CellKey[] {
    return this.cache.keys();
  }
  /** @internal */
  cacheEntryForTest(key: CellKey): CellEntry | undefined {
    return this.cache.get(key);
  }
  /** @internal */
  cellsForTest(): ReadonlyMap<CellKey, CellMesh> {
    return this.cells;
  }
}

/** A `ScreenPoint` and a `PickedFeatureLike` are told apart structurally, the
 *  same way `CityModelRegistry` does it, so a pick resolves identically on the
 *  static and streaming paths. */
function isScreenPoint(
  pick: ScreenPoint | PickedFeatureLike,
): pick is ScreenPoint {
  return (
    typeof (pick as ScreenPoint).x === "number" &&
    typeof (pick as ScreenPoint).y === "number"
  );
}
