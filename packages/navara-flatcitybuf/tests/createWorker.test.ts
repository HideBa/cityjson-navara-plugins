/**
 * The worker factory the host hands `CityStreamPlugin`: a module worker over
 * this package's own entry, which installs the stream core over its adapter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlatCityBufWorker } from "../src/createWorker";

class FakeWorker {
  constructor(
    public url: string | URL,
    public options?: WorkerOptions,
  ) {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createFlatCityBufWorker", () => {
  it("starts a module worker on this package's worker entry", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const worker = createFlatCityBufWorker() as unknown as FakeWorker;
    expect(String(worker.url)).toMatch(/\/fcb\.worker\.ts$/);
    expect(worker.options).toEqual({ type: "module" });
  });
});
