/**
 * The placeholder the CityParquet worker entry runs on: every open is refused
 * with "unsupported", so the registry surfaces the message and terminates the
 * worker instead of streaming nothing.
 */
import { describe, expect, it } from "vitest";
import { installStreamWorker } from "../src/streamWorkerCore";
import { createUnsupportedSourceAdapter } from "../src/unsupportedSourceAdapter";
import type { WorkerRequest, WorkerResponse } from "../src/workerProtocol";

describe("createUnsupportedSourceAdapter", () => {
  it("refuses every open with 'unsupported' and the given message", async () => {
    const posted: WorkerResponse[] = [];
    const ctx = {
      postMessage: (m: WorkerResponse) => posted.push(m),
      onmessage: null as ((ev: MessageEvent<WorkerRequest>) => void) | null,
    };
    installStreamWorker(ctx, createUnsupportedSourceAdapter("not yet"));
    const data: WorkerRequest = {
      type: "open",
      id: 7,
      source: { urls: ["a", "b"] },
    };
    await (ctx.onmessage!({ data } as MessageEvent<WorkerRequest>) as unknown);
    expect(posted).toEqual([
      {
        type: "opened",
        id: 7,
        header: {
          version: "",
          featuresCount: undefined,
          extent: undefined,
          referenceSystem: undefined,
          epsg: null,
        },
        admission: { code: "unsupported", message: "not yet" },
      },
    ]);
  });

  it("cannot probe: no file open", async () => {
    const adapter = createUnsupportedSourceAdapter("not yet");
    const signal = new AbortController().signal;
    expect(() => adapter.probe([0, 0, 1, 1], signal)).toThrow("no file open");
  });
});
