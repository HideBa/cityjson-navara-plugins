/**
 * The worker factory the host hands `CityStreamPlugin`: a module worker over
 * this package's own entry, which installs the stream core over its adapter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCityParquetWorker } from "../src/createStreamWorker";

class FakeWorker {
  constructor(
    public url: string | URL,
    public options?: WorkerOptions,
  ) {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createCityParquetWorker", () => {
  it("starts a module worker on this package's worker entry", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const worker = createCityParquetWorker() as unknown as FakeWorker;
    expect(String(worker.url)).toMatch(/\/stream\.worker\.ts$/);
    expect(worker.options).toEqual({ type: "module" });
  });
});
