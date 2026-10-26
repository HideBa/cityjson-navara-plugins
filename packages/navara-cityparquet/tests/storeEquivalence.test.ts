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
  const box: [number, number, number, number] = [
    extent[0],
    extent[1],
    extent[3],
    extent[4],
  ];
  const fetch = (
    id: number,
    lod: string | null,
    at: number = level,
    cells: string[] = keysCovering(grid, box, at),
  ): WorkerRequest => ({
    type: "fetch",
    id,
    bbox: box,
    level: at,
    cells,
    lod,
    rules: [],
    rulesEnabled: false,
  });
  /** The four children of every cell covering the extent at `at`. */
  const children = (at: number) =>
    keysCovering(grid, box, at).flatMap((key) => {
      const [l, c, r] = key.split("/").map(Number) as [number, number, number];
      return [0, 1].flatMap((dc) =>
        [0, 1].map((dr) => `${l + 1}/${2 * c + dc}/${2 * r + dr}`),
      );
    });
  return { posted, send, fetch, reads, level, children };
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

/** A cell message with order-free fields: per object, the multiset of its
 *  triangles (each vertex's position, normal and base colour), so cells
 *  whose objects came from reads in another order compare equal. */
function canonical(cells: Iterable<Extract<WorkerResponse, { type: "cell" }>>) {
  const out = new Map<string, unknown>();
  for (const c of cells) {
    const g = c.geometry;
    const tris = new Map<string, string[]>();
    for (let t = 0; t < g.triangleCount; t++) {
      const verts: string[] = [];
      let obj = "";
      for (let k = 0; k < 3; k++) {
        const v = g.indices[t * 3 + k]!;
        const slot = g.slots[v]!;
        obj = g.objectKeys[g.slotObjects[slot]!]!;
        verts.push(
          [
            ...g.positions.subarray(v * 3, v * 3 + 3),
            ...g.normals.subarray(v * 3, v * 3 + 3),
            ...g.baseColors.subarray(slot * 3, slot * 3 + 3),
          ].join(","),
        );
      }
      const list = tris.get(obj) ?? [];
      list.push(verts.sort().join("|"));
      tris.set(obj, list);
    }
    out.set(c.key, {
      objects: [...c.objects].sort((a, b) => a.id.localeCompare(b.id)),
      triangles: [...tris].map(([id, l]) => [id, l.sort()]).sort(),
      retainedBytes: c.retainedBytes,
      lodsSeen: [...c.lodsSeen].sort(),
      surfaceAttrKeys: [...c.surfaceAttrKeys].sort(),
      frame: c.frame,
      appearanceThemes: c.appearanceThemes,
      objectTypes: [...g.objectTypes].sort(),
    });
  }
  return out;
}

describe.each(["two-buildings-cityparquet", "plateau-6697-cityparquet"])(
  "the feature store across levels over %s",
  (dir) => {
    it("bakes a finer level from a coarser read exactly as a fresh read", async () => {
      const held = await worker(dir);
      await held.send(held.fetch(1, "2.2", held.level - 1));
      await held.send(held.fetch(2, "2.2", held.level + 1));
      expect(held.reads).toEqual(["2.2"]);

      const fresh = await worker(dir);
      await fresh.send(fresh.fetch(2, "2.2", fresh.level + 1));
      const f = cellsOf(fresh.posted, 2);
      expect(f.size).toBeGreaterThan(0);
      expect(cellsOf(held.posted, 2)).toEqual(f);
    });

    it("bakes a coarser level from finer reads with the same objects", async () => {
      const held = await worker(dir);
      // One level coarser than the cover, read through all its children.
      const coarse = held.level - 1;
      await held.send(held.fetch(1, "2.2", coarse + 1, held.children(coarse)));
      await held.send(held.fetch(2, "2.2", coarse));
      expect(held.reads).toEqual(["2.2"]);

      const fresh = await worker(dir);
      await fresh.send(fresh.fetch(2, "2.2", coarse));
      const f = cellsOf(fresh.posted, 2);
      expect(f.size).toBeGreaterThan(0);
      expect(canonical(cellsOf(held.posted, 2).values())).toEqual(
        canonical(f.values()),
      );
    });
  },
);
