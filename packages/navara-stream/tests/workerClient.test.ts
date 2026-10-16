import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  assertCellGeometry,
  type CellGeometry,
  type WorkerRequest,
  type WorkerResponse,
} from "../src/workerProtocol";
import { WorkerClient } from "../src/workerClient";

/**
 * Fixture: two triangles, three slots (the third unused by any vertex is
 * allowed; a slot no vertex names is just never drawn). Every array has its
 * own length-driving expression, and each has a dedicated "rejects a short X"
 * test below, so a copy-paste bug reading one array's length under another's
 * label desyncs at least one of them.
 */
function geom(
  triangleCount: number,
  bad?: Partial<CellGeometry>,
): CellGeometry {
  const v = triangleCount * 3;
  const slots = 3;
  return {
    positions: new Float32Array(v * 3).fill(1),
    normals: new Float32Array(v * 3).fill(2),
    slots: new Uint32Array(v).map((_, i) => (i < 3 ? 0 : 1)),
    slotObjects: new Uint32Array(slots).fill(1),
    slotSurfaces: new Uint32Array(slots).fill(20),
    slotTextures: new Int32Array(slots).fill(-1),
    baseColors: new Float32Array(slots * 3).fill(3),
    ruleColors: null,
    objectKeys: ["obj-a", "obj-b"],
    triangleCount,
    ...bad,
  };
}

describe("assertCellGeometry", () => {
  it("accepts a consistent payload with no rule colors", () => {
    expect(() => assertCellGeometry(geom(2))).not.toThrow();
  });

  it("accepts a consistent payload with correctly-sized rule colors", () => {
    expect(() =>
      assertCellGeometry(geom(2, { ruleColors: new Float32Array(9).fill(9) })),
    ).not.toThrow();
  });

  it("rejects a short positions array", () => {
    expect(() =>
      assertCellGeometry(geom(2, { positions: new Float32Array(3).fill(1) })),
    ).toThrow(/positions/);
  });

  it("rejects a short normals array", () => {
    expect(() =>
      assertCellGeometry(geom(2, { normals: new Float32Array(3).fill(2) })),
    ).toThrow(/normals/);
  });

  it("rejects a short slots array — the picking failure mode", () => {
    expect(() =>
      assertCellGeometry(geom(2, { slots: new Uint32Array(1) })),
    ).toThrow(/slots/);
  });

  it("rejects a vertex naming a slot that does not exist", () => {
    expect(() =>
      assertCellGeometry(geom(2, { slots: new Uint32Array(6).fill(3) })),
    ).toThrow(/names slot 3/);
  });

  it("rejects a short baseColors array", () => {
    expect(() =>
      assertCellGeometry(geom(2, { baseColors: new Float32Array(3).fill(3) })),
    ).toThrow(/baseColors/);
  });

  it("rejects a short slotSurfaces array", () => {
    expect(() =>
      assertCellGeometry(geom(2, { slotSurfaces: new Uint32Array(1) })),
    ).toThrow(/slotSurfaces/);
  });

  it("rejects a short slotTextures array", () => {
    expect(() =>
      assertCellGeometry(geom(2, { slotTextures: new Int32Array(1) })),
    ).toThrow(/slotTextures/);
  });

  it("rejects short rule colors when present", () => {
    expect(() =>
      assertCellGeometry(geom(2, { ruleColors: new Float32Array(3).fill(9) })),
    ).toThrow(/ruleColors/);
  });
});

/**
 * A minimal in-memory stand-in for the DOM Worker, since jsdom (this
 * project's vitest environment) does not implement Worker at all —
 * `new Worker(...)` throws ReferenceError there. This fake captures
 * postMessage calls and lets tests fire onmessage directly to simulate
 * responses arriving from the real worker thread.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(
    public url: string | URL,
    public options?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }
}

beforeEach(() => {
  FakeWorker.instances.length = 0;
  vi.stubGlobal("Worker", FakeWorker);
});

function currentWorker(): FakeWorker {
  const w = FakeWorker.instances.at(-1);
  if (!w) throw new Error("no FakeWorker constructed");
  return w;
}

/** Reads the id the client assigned to its Nth postMessage call. */
function sentId(worker: FakeWorker, callIndex = 0): number {
  const call = worker.postMessage.mock.calls[callIndex] as
    | [WorkerRequest, Transferable[]?]
    | undefined;
  if (!call) throw new Error(`no postMessage call at index ${callIndex}`);
  return call[0].id;
}

/** A client over a fresh fake worker, which {@link currentWorker} returns. */
function newClient(): WorkerClient {
  return new WorkerClient(new FakeWorker("fake://worker") as unknown as Worker);
}

describe("WorkerClient", () => {
  it("drives the worker it is handed", () => {
    const worker = new FakeWorker("fake://worker");
    const client = new WorkerClient(worker as unknown as Worker);
    client.notify({ type: "cancel" });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it("send() resolves the promise matching the dispatched id", async () => {
    const client = newClient();
    const worker = currentWorker();
    const promise = client.send({ type: "probe", bbox: [0, 0, 1, 1] });
    const id = sentId(worker);
    worker.onmessage?.({
      data: { type: "probed", id, count: 42 },
    } as unknown as MessageEvent<WorkerResponse>);
    await expect(promise).resolves.toEqual({ type: "probed", id, count: 42 });
  });

  it("routes concurrent send() responses to the correct caller regardless of arrival order", async () => {
    const client = newClient();
    const worker = currentWorker();
    const p1 = client.send({ type: "probe", bbox: [0, 0, 1, 1] });
    const p2 = client.send({ type: "probe", bbox: [1, 1, 2, 2] });
    const id1 = sentId(worker, 0);
    const id2 = sentId(worker, 1);
    // Fire the second request's response first.
    worker.onmessage?.({
      data: { type: "probed", id: id2, count: 2 },
    } as unknown as MessageEvent<WorkerResponse>);
    worker.onmessage?.({
      data: { type: "probed", id: id1, count: 1 },
    } as unknown as MessageEvent<WorkerResponse>);
    await expect(p1).resolves.toEqual({ type: "probed", id: id1, count: 1 });
    await expect(p2).resolves.toEqual({ type: "probed", id: id2, count: 2 });
  });

  it("sendStreaming() delivers every cell before resolving on done — not just the first", async () => {
    const client = newClient();
    const worker = currentWorker();
    const received: WorkerResponse[] = [];
    const done = client.sendStreaming(
      {
        type: "fetch",
        bbox: [0, 0, 1, 1],
        level: 0,
        cells: ["0/0/0", "0/1/0"],
        lod: null,
        hiddenTypes: [],
        rules: [],
        rulesEnabled: false,
      },
      (r) => received.push(r),
    );
    const id = sentId(worker);
    const geometry = geom(1);
    worker.onmessage?.({
      data: {
        type: "cell",
        id,
        key: "0/0/0",
        geometry,
        objects: [],
        surfaceAttrKeys: [],
        lodsSeen: [],
      },
    } as unknown as MessageEvent<WorkerResponse>);
    worker.onmessage?.({
      data: {
        type: "cell",
        id,
        key: "0/1/0",
        geometry,
        objects: [],
        surfaceAttrKeys: [],
        lodsSeen: [],
      },
    } as unknown as MessageEvent<WorkerResponse>);
    worker.onmessage?.({
      data: { type: "done", id },
    } as unknown as MessageEvent<WorkerResponse>);
    await done;
    expect(received.map((r) => r.type)).toEqual(["cell", "cell", "done"]);
  });

  it("sendStreaming() resolves on an error response too, not only on done", async () => {
    const client = newClient();
    const worker = currentWorker();
    const received: WorkerResponse[] = [];
    const done = client.sendStreaming({ type: "evict", cells: [] }, (r) =>
      received.push(r),
    );
    const id = sentId(worker);
    worker.onmessage?.({
      data: { type: "error", id, message: "boom", aborted: false },
    } as unknown as MessageEvent<WorkerResponse>);
    await done;
    expect(received.map((r) => r.type)).toEqual(["error"]);
  });

  it("validates each streamed cell's geometry on receipt and throws on a malformed one", () => {
    const client = newClient();
    const worker = currentWorker();
    // Not awaited: this test asserts the *synchronous* throw on receipt of a
    // malformed cell, which happens before the streaming promise ever
    // settles (it settles only on 'done'/'error', neither of which is sent).
    void client.sendStreaming(
      {
        type: "fetch",
        bbox: [0, 0, 1, 1],
        level: 0,
        cells: ["0/0/0"],
        lod: null,
        hiddenTypes: [],
        rules: [],
        rulesEnabled: false,
      },
      () => {},
    );
    const id = sentId(worker);
    const badGeometry = geom(1, { normals: new Float32Array(3).fill(2) });
    expect(() =>
      worker.onmessage?.({
        data: {
          type: "cell",
          id,
          key: "0/0/0",
          geometry: badGeometry,
          objects: [],
          surfaceAttrKeys: [],
          lodsSeen: [],
        },
      } as unknown as MessageEvent<WorkerResponse>),
    ).toThrow(/normals/);
  });

  it("newEpoch()/isCurrent() track the most recently started epoch", () => {
    const client = newClient();
    const e1 = client.newEpoch();
    expect(client.isCurrent(e1)).toBe(true);
    const e2 = client.newEpoch();
    expect(client.isCurrent(e1)).toBe(false);
    expect(client.isCurrent(e2)).toBe(true);
  });

  it("terminate() tears down the underlying worker and REJECTS pending calls, rather than leaking them", async () => {
    const client = newClient();
    const worker = currentWorker();
    const promise = client.send({ type: "probe", bbox: [0, 0, 1, 1] });
    const id = sentId(worker);
    client.terminate();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(promise).rejects.toThrow(/terminated/i);
    // The pending callback was dropped by terminate(), so firing the
    // now-orphaned id afterward must not throw and must not resolve/re-settle
    // the (already-rejected) promise.
    expect(() =>
      worker.onmessage?.({
        data: { type: "probed", id, count: 1 },
      } as unknown as MessageEvent<WorkerResponse>),
    ).not.toThrow();
  });

  it("notify() posts the message but returns void — nothing for a caller to await, unlike send()", () => {
    const client = newClient();
    const worker = currentWorker();
    const result = client.notify({ type: "cancel" });
    expect(result).toBeUndefined();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(sentId(worker)).toBeTypeOf("number");
  });

  it("notify() registers no pending entry — terminate() afterwards has nothing to reject", async () => {
    const client = newClient();
    client.notify({ type: "cancel" });
    client.notify({ type: "evict", cells: ["0/0/0"] });
    client.notify({ type: "close" });
    // If notify() were implemented as a thin, un-awaited wrapper around
    // send() (e.g. `notify(msg) { void this.send(msg); }`) instead of
    // genuinely registering nothing, each call above would still create a
    // Promise via send()'s `pending.set(id, {resolve, reject})`. Nobody
    // holds a reference to that promise to .catch() it, so terminate()'s
    // own `reject(err)` loop over `this.pending` would reject it anyway —
    // and an unhandled rejection on an uncaught promise is exactly what
    // vitest fails the test run on. Reaching the assertion below, with the
    // event loop given a turn to surface any such rejection, is itself part
    // of the proof (this is the regression test for B3, 2026-07-28 final
    // review: "every interaction burst adds a permanent pending entry").
    client.terminate();
    await new Promise((r) => setTimeout(r, 0));
    expect(true).toBe(true);
  });

  it("terminate() rejects an in-flight sendStreaming() promise too", async () => {
    const client = newClient();
    const received: WorkerResponse[] = [];
    const done = client.sendStreaming({ type: "evict", cells: [] }, (r) =>
      received.push(r),
    );
    client.terminate();
    await expect(done).rejects.toThrow(/terminated/i);
    // No 'cell'/'done' ever arrived, so onMessage must never have fired.
    expect(received).toEqual([]);
  });
});
