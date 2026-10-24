/**
 * The stream worker's feature store, through the real CityParquet adapter: a
 * cell baked from what an earlier, wider read held must be the cell a fresh
 * read at that LoD bakes — the whole `cell` message and the `surfaces`
 * reply — for a projected source and a geographic one.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installStreamWorker } from "@cityjson/navara-stream/worker";
import type {
  OpenedSource,
  StreamSourceAdapter,
  WorkerRequest,
  WorkerResponse,
} from "@cityjson/navara-stream/worker";
import { keysCovering, makeGrid } from "@cityjson/navara-stream";
import { createCityParquetSourceAdapter } from "../src/streamAdapter";

const fixture = (dir: string) =>
  fileURLToPath(new URL(`./fixtures/${dir}/building.parquet`, import.meta.url));

/** The adapter, counting its reads. */
function counted(): { adapter: StreamSourceAdapter; reads: (string | null)[] } {
  const inner = createCityParquetSourceAdapter();
  const reads: (string | null)[] = [];
  const adapter: StreamSourceAdapter = {
    ...inner,
    ownership: inner.ownership,
    open: (req) => inner.open(req),
    probe: (bbox, signal) => inner.probe(bbox, signal),
    select(bbox, opts) {
      reads.push(opts.lod);
      return inner.select(bbox, opts);
    },
    appearance: () => inner.appearance(),
    bakeLod: (lod, seen) => inner.bakeLod(lod, seen),
    heldCeiling: (lod) => inner.heldCeiling!(lod),
    close: () => inner.close(),
  };
  return { adapter, reads };
}

async function worker(dir: string) {
  const { adapter, reads } = counted();
  const posted: WorkerResponse[] = [];
  const ctx = {
    postMessage(m: WorkerResponse, t?: Transferable[]) {
      posted.push(structuredClone(m, { transfer: t ?? [] }));
    },
    onmessage: null as ((ev: MessageEvent<WorkerRequest>) => void) | null,
  };
  installStreamWorker(ctx, adapter);
  const send = async (data: WorkerRequest) => {
    await (ctx.onmessage!({ data } as MessageEvent<WorkerRequest>) as unknown);
  };
  const blob = new Blob([await readFile(fixture(dir))]);
  await send({ type: "open", id: 0, source: { blob } });
  const opened = posted.find((m) => m.type === "opened") as Extract<
    WorkerResponse,
    { type: "opened" }
  >;
  const extent = (opened.header as OpenedSource["header"]).extent!;
  const grid = makeGrid(extent);
  let level = 0;
  while (
    level < grid.maxLevel &&
    keysCovering(grid, [extent[0], extent[1], extent[3], extent[4]], level)
      .length < 4
  ) {
    level++;
  }
  const cells = keysCovering(
    grid,
    [extent[0], extent[1], extent[3], extent[4]],
    level,
  );
  const fetch = (id: number, lod: string | null): WorkerRequest => ({
    type: "fetch",
    id,
    bbox: [extent[0], extent[1], extent[3], extent[4]],
    level,
    cells,
    lod,
    rules: [],
    rulesEnabled: false,
  });
  return { posted, send, fetch, reads };
}

function cellsOf(posted: WorkerResponse[], id: number) {
  return new Map(
    posted
      .filter(
        (m): m is Extract<WorkerResponse, { type: "cell" }> =>
          m.type === "cell" && m.id === id,
      )
      .map((c) => [c.key, c]),
  );
}

describe.each(["two-buildings-cityparquet", "plateau-6697-cityparquet"])(
  "the feature store over %s",
  (dir) => {
    it.each([null, "2.2"])(
      "bakes LoD 0 from a read held at %s exactly as a fresh LoD 0 read does",
      async (wider) => {
        const held = await worker(dir);
        await held.send(held.fetch(1, wider));
        await held.send(held.fetch(2, "0.0"));
        expect(held.reads).toEqual([wider]);

        const fresh = await worker(dir);
        await fresh.send(fresh.fetch(2, "0.0"));
        expect(fresh.reads).toEqual(["0.0"]);

        const h = cellsOf(held.posted, 2);
        const f = cellsOf(fresh.posted, 2);
        expect([...h.keys()].sort()).toEqual([...f.keys()].sort());
        expect(f.size).toBeGreaterThan(0);
        for (const [key, cell] of f) expect(h.get(key)).toEqual(cell);

        const id = [...f.values()][0]!.objects[0]!.id;
        await held.send({ type: "surfaces", id: 3, objectId: id });
        await fresh.send({ type: "surfaces", id: 3, objectId: id });
        const reply = (posted: WorkerResponse[]) =>
          posted.find((m) => m.type === "surfaceData");
        expect(reply(held.posted)).toBeDefined();
        expect(reply(held.posted)).toEqual(reply(fresh.posted));
      },
    );
  },
);
