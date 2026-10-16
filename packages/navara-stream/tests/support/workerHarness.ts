/**
 * A stream worker core driven in-process: `installStreamWorker` over a fake
 * worker scope whose `postMessage` is backed by `structuredClone(msg,
 * {transfer})`, so transferred buffers really detach, exactly as in the
 * browser. Shared by this package's core tests and every format package's
 * adapter-conformance test.
 */
import { expect } from "vitest";
import type { BBox3 } from "@cityjson/navara-core";
import { installStreamWorker } from "../../src/streamWorkerCore";
import { keysCovering, makeGrid } from "../../src/tileGrid";
import type {
  OpenedSource,
  StreamSourceAdapter,
} from "../../src/streamSourceAdapter";
import {
  assertCellGeometry,
  type WorkerRequest,
  type WorkerResponse,
} from "../../src/workerProtocol";

export function harness(
  adapter: StreamSourceAdapter,
  options?: { retainedByteBudget?: number },
) {
  const posted: WorkerResponse[] = [];
  const ctx = {
    postMessage(m: WorkerResponse, t?: Transferable[]) {
      posted.push(structuredClone(m, { transfer: t ?? [] }));
    },
    onmessage: null as ((ev: MessageEvent<WorkerRequest>) => void) | null,
  };
  installStreamWorker(ctx, adapter, options);
  const send = async (data: WorkerRequest): Promise<void> => {
    if (!ctx.onmessage) throw new Error("core did not install onmessage");
    await (ctx.onmessage({ data } as MessageEvent<WorkerRequest>) as unknown);
  };
  return { posted, send };
}

export const ofType =
  <T extends WorkerResponse["type"]>(type: T) =>
  (m: WorkerResponse): m is Extract<WorkerResponse, { type: T }> =>
    m.type === type;

export const errorOf =
  (id: number) =>
  (m: WorkerResponse): m is Extract<WorkerResponse, { type: "error" }> =>
    m.type === "error" && m.id === id;

/** The extent an admitted `opened` carried (the wire types it `unknown`). */
export function openedExtent(posted: WorkerResponse[]): BBox3 {
  const opened = posted.find(ofType("opened"))!;
  return (opened.header as OpenedSource["header"]).extent!;
}

export function fetchAt(
  id: number,
  level: number,
  cells: string[],
  bbox: [number, number, number, number],
): WorkerRequest {
  return {
    type: "fetch",
    id,
    bbox,
    level,
    cells,
    lod: null,
    rules: [],
    rulesEnabled: false,
  };
}

/**
 * One scenario, every adapter: open, fetch every cell covering the extent at
 * one level, and check the posted cells are well-formed and together hold
 * every object in the source — exactly once.
 */
export async function fetchConformance(
  adapter: StreamSourceAdapter,
  source: WorkerRequest & { type: "open" },
  level: number,
  expectedIds: ReadonlyArray<string>,
): Promise<void> {
  const { posted, send } = harness(adapter);
  await send(source);
  const opened = posted.find(ofType("opened"))!;
  expect(opened.admission).toBeNull();
  const extent = openedExtent(posted);
  const grid = makeGrid(extent);
  const box: [number, number, number, number] = [
    extent[0],
    extent[1],
    extent[3],
    extent[4],
  ];
  const cells = keysCovering(grid, box, level);
  await send(fetchAt(1, level, cells, box));

  const posts = posted.filter(ofType("cell"));
  expect(posts.length).toBeGreaterThan(0);
  const ids: string[] = [];
  for (const c of posts) {
    expect(cells).toContain(c.key);
    assertCellGeometry(c.geometry);
    expect(c.geometry.triangleCount).toBeGreaterThan(0);
    ids.push(...c.objects.map((o) => o.id));
  }
  expect(ids.sort()).toEqual([...expectedIds].sort());
  expect(posted.at(-1)).toEqual({ type: "done", id: 1 });
}
