/**
 * Range-read sources: a `Blob` and an HTTP URL as hyparquet `AsyncBuffer`s that
 * count the bytes they read and fetch every slice under a per-request signal.
 *
 * The parquet cases run against the multi-row-group fixtures, whose geometry
 * chunks span several pages: a read of a few rows inside one row group must be
 * able to skip the pages it does not need when the file has an offset index,
 * and must still return the right rows when it does not.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compressors } from "hyparquet-compressors";
import { describe, expect, it } from "vitest";
import {
  RangeNotSupportedError,
  asyncBufferFromBlob,
  asyncBufferFromHttp,
} from "../src/rangeSource";
import { DEFAULT_PARSERS } from "../src/vendor/hyparquet/convert.js";
import {
  parquetMetadataAsync,
  parquetReadObjects,
} from "../src/vendor/hyparquet/index.js";

const fixture = (dir: string) =>
  fileURLToPath(new URL(`./fixtures/${dir}/building.parquet`, import.meta.url));

/** Keeps WKB raw — see `RAW_WKB_PARSERS` in `tableReader.ts`. */
const RAW_WKB_PARSERS = {
  ...DEFAULT_PARSERS,
  geometryFromBytes: (bytes: Uint8Array | undefined) => bytes,
  geographyFromBytes: (bytes: Uint8Array | undefined) => bytes,
};

const COLUMNS = ["id", "geometry_lod2_2"];
/** Rows 18..20 — a PARTIAL range inside row group 2 (rows 16..23). */
const ROW_START = 18;
const ROW_END = 21;
const EXPECTED_IDS = [
  "NL.IMBAG.Pand.0001_6",
  "NL.IMBAG.Pand.0001-part1_6",
  "NL.IMBAG.Pand.0002_6",
];

async function blobOf(dir: string): Promise<Blob> {
  return new Blob([await readFile(fixture(dir))]);
}

async function readRange(blob: Blob, useOffsetIndex: boolean) {
  const metadata = await parquetMetadataAsync(asyncBufferFromBlob(blob));
  const file = asyncBufferFromBlob(blob);
  const rows = await parquetReadObjects({
    file,
    metadata,
    columns: COLUMNS,
    rowStart: ROW_START,
    rowEnd: ROW_END,
    useOffsetIndex,
    utf8: false,
    parsers: RAW_WKB_PARSERS,
    compressors,
  });
  return { rows, bytesRead: file.bytesRead() };
}

describe("asyncBufferFromBlob", () => {
  it("slices the blob's bytes and counts them", async () => {
    const bytes = new Uint8Array(64).map((_, i) => i * 3);
    const buf = asyncBufferFromBlob(new Blob([bytes]));
    expect(buf.byteLength).toBe(64);
    expect(buf.bytesRead()).toBe(0);
    const out = new Uint8Array(await buf.slice(10, 20));
    expect(Array.from(out)).toEqual(Array.from(bytes.slice(10, 20)));
    expect(buf.bytesRead()).toBe(10);
  });

  it("reads a partial row-group range through the offset index with fewer bytes", async () => {
    const blob = await blobOf("multigroup-cityparquet");
    const paged = await readRange(blob, true);
    const whole = await readRange(blob, false);

    expect(paged.rows.map((r) => r.id)).toEqual(EXPECTED_IDS);
    expect(whole.rows.map((r) => r.id)).toEqual(EXPECTED_IDS);
    for (const row of paged.rows) {
      expect(row.geometry_lod2_2).toBeInstanceOf(Uint8Array);
    }
    expect(paged.rows.map((r) => r.geometry_lod2_2)).toEqual(
      whole.rows.map((r) => r.geometry_lod2_2),
    );
    expect(paged.bytesRead).toBeLessThan(whole.bytesRead);
  });

  it("returns the right rows from a file without a page index", async () => {
    const blob = await blobOf("multigroup-noindex-cityparquet");
    const { rows } = await readRange(blob, true);
    expect(rows.map((r) => r.id)).toEqual(EXPECTED_IDS);
    for (const row of rows) {
      expect(row.geometry_lod2_2).toBeInstanceOf(Uint8Array);
    }
  });
});

/**
 * A fake server over `bytes`: answers HEAD with Content-Length and a ranged GET
 * with a 206 of the requested (end-inclusive) span. `full200` makes it ignore
 * `Range` and answer 200 with the whole body, as a server without range support
 * does. Every request is recorded; the signal is honoured.
 */
function fakeFetch(bytes: Uint8Array, opts: { full200?: boolean } = {}) {
  const requests: { method: string; range: string | null }[] = [];
  const fetchImpl = async (
    _url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const range = headers.get("Range");
    requests.push({ method, range });
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "Content-Length": String(bytes.byteLength) },
      });
    }
    if (opts.full200 || range === null) {
      return new Response(bytes.slice(), { status: 200 });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m) return new Response(null, { status: 416 });
    const start = Number(m[1]);
    const endInclusive = Math.min(Number(m[2]), bytes.byteLength - 1);
    return new Response(bytes.slice(start, endInclusive + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${endInclusive}/${bytes.byteLength}`,
      },
    });
  };
  return { fetch: fetchImpl as typeof fetch, requests };
}

describe("asyncBufferFromHttp", () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 251);

  it("learns the length from HEAD and requests an end-inclusive Range per slice", async () => {
    const server = fakeFetch(bytes);
    const buf = await asyncBufferFromHttp("https://example.test/f.parquet", {
      fetch: server.fetch,
    });
    expect(buf.byteLength).toBe(1000);
    expect(server.requests[0]!.method).toBe("HEAD");

    const out = new Uint8Array(await buf.slice(100, 200));
    expect(server.requests.at(-1)).toEqual({
      method: "GET",
      range: "bytes=100-199",
    });
    expect(Array.from(out)).toEqual(Array.from(bytes.slice(100, 200)));
    expect(buf.bytesRead()).toBe(100);
  });

  it("falls back to a bytes=0-0 GET's Content-Range when HEAD gives no length", async () => {
    const server = fakeFetch(bytes);
    const noHead = (async (url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "HEAD"
        ? new Response(null, { status: 405 })
        : server.fetch(url, init)) as typeof fetch;
    const buf = await asyncBufferFromHttp("https://example.test/f.parquet", {
      fetch: noHead,
    });
    expect(buf.byteLength).toBe(1000);
    expect(server.requests.at(-1)).toEqual({
      method: "GET",
      range: "bytes=0-0",
    });
    expect(buf.bytesRead()).toBe(0);
  });

  it("falls back to the ranged GET when the HEAD request itself rejects", async () => {
    // Codex milestone review (Important): a HEAD that THROWS — CORS, a
    // network refusal, a proxy that drops the method — escaped
    // `probeByteLength` before the `bytes=0-0` fallback could run, so a
    // source whose ranged GETs work perfectly failed to open at all.
    const server = fakeFetch(bytes);
    const headRejects = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") throw new TypeError("Failed to fetch");
      return server.fetch(url, init);
    }) as typeof fetch;
    const buf = await asyncBufferFromHttp("https://example.test/f.parquet", {
      fetch: headRejects,
    });
    expect(buf.byteLength).toBe(1000);
    expect(server.requests.at(-1)).toEqual({
      method: "GET",
      range: "bytes=0-0",
    });
    const out = new Uint8Array(await buf.slice(10, 20));
    expect(Array.from(out)).toEqual(Array.from(bytes.slice(10, 20)));
  });

  it("does not cache: the same slice twice is two requests", async () => {
    const server = fakeFetch(bytes);
    const buf = await asyncBufferFromHttp("https://example.test/f.parquet", {
      byteLength: 1000,
      fetch: server.fetch,
    });
    await buf.slice(0, 10);
    await buf.slice(0, 10);
    expect(server.requests.filter((r) => r.method === "GET")).toHaveLength(2);
    expect(buf.bytesRead()).toBe(20);
  });

  it("throws RangeNotSupportedError when a ranged GET over 4 MiB is answered 200", async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    const server = fakeFetch(big, { full200: true });
    const buf = await asyncBufferFromHttp("https://example.test/f.parquet", {
      byteLength: big.byteLength,
      fetch: server.fetch,
    });
    await expect(buf.slice(0, 5 * 1024 * 1024)).rejects.toBeInstanceOf(
      RangeNotSupportedError,
    );
  });

  it("throws RangeNotSupportedError for a small slice of a large file answered 200", async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    const server = fakeFetch(big, { full200: true });
    const buf = await asyncBufferFromHttp("https://example.test/f.parquet", {
      byteLength: big.byteLength,
      fetch: server.fetch,
    });
    await expect(buf.slice(0, 1024)).rejects.toBeInstanceOf(
      RangeNotSupportedError,
    );
  });

  it("slices a small file locally when the server answers 200", async () => {
    const server = fakeFetch(bytes, { full200: true });
    const buf = await asyncBufferFromHttp("https://example.test/f.parquet", {
      byteLength: 1000,
      fetch: server.fetch,
    });
    const out = new Uint8Array(await buf.slice(100, 110));
    expect(Array.from(out)).toEqual(Array.from(bytes.slice(100, 110)));
  });

  it("rejects with AbortError under an aborted signal, then succeeds under a fresh one", async () => {
    const server = fakeFetch(bytes);
    const buf = await asyncBufferFromHttp("https://example.test/f.parquet", {
      byteLength: 1000,
      fetch: server.fetch,
    });
    const aborted = new AbortController();
    aborted.abort();
    buf.setSignal(aborted.signal);
    await expect(buf.slice(0, 10)).rejects.toMatchObject({
      name: "AbortError",
    });

    buf.setSignal(new AbortController().signal);
    const out = new Uint8Array(await buf.slice(0, 10));
    expect(Array.from(out)).toEqual(Array.from(bytes.slice(0, 10)));
  });
});

describe("asyncBufferFromHttp transport hardening", () => {
  it("rejects with AbortError when the signal fires during an in-flight slice, and the fetch received that signal", async () => {
    let received: AbortSignal | undefined;
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => (started = resolve));
    const pending = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        received = init?.signal ?? undefined;
        started();
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as typeof fetch;
    const buf = await asyncBufferFromHttp("https://example.test/f.parquet", {
      byteLength: 1000,
      fetch: pending,
    });
    const controller = new AbortController();
    buf.setSignal(controller.signal);
    const slice = buf.slice(0, 10);
    await fetchStarted;
    controller.abort();
    await expect(slice).rejects.toMatchObject({ name: "AbortError" });
    expect(received).toBe(controller.signal);
  });

  it("rejects with AbortError when the signal fires while the body is being read, even if the body ignores it", async () => {
    let bodyStarted!: () => void;
    const bodyRead = new Promise<void>((resolve) => (bodyStarted = resolve));
    const stalled = (async () => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          bodyStarted();
          return new Promise(() => {}); // never delivers
        },
      });
      return new Response(body, {
        status: 206,
        headers: { "Content-Range": "bytes 0-9/1000" },
      });
    }) as typeof fetch;
    const buf = await asyncBufferFromHttp("https://example.test/f.parquet", {
      byteLength: 1000,
      fetch: stalled,
    });
    const controller = new AbortController();
    buf.setSignal(controller.signal);
    const slice = buf.slice(0, 10);
    await bodyRead;
    controller.abort();
    await expect(slice).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses a 200 whose own Content-Length is over 4 MiB without reading the body, even when the caller claimed a small length", async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    let bodyPulled = false;
    const server = (async () => {
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            bodyPulled = true;
            controller.enqueue(big);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ); // pull only when read, so "pulled" means "read"
      return new Response(body, {
        status: 200,
        headers: { "Content-Length": String(big.byteLength) },
      });
    }) as typeof fetch;
    const buf = await asyncBufferFromHttp("https://example.test/f.parquet", {
      byteLength: 1000, // stale: the real resource is 6 MiB
      fetch: server,
    });
    await expect(buf.slice(0, 10)).rejects.toBeInstanceOf(
      RangeNotSupportedError,
    );
    expect(bodyPulled).toBe(false);
    expect(buf.bytesRead()).toBe(0);
  });

  it("stops reading a 200 without Content-Length once it passes 4 MiB, even when the caller claimed a small length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let chunksPulled = 0;
    const server = (async () => {
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            chunksPulled += 1;
            if (chunksPulled > 64) controller.close();
            else controller.enqueue(chunk);
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const buf = await asyncBufferFromHttp("https://example.test/f.parquet", {
      byteLength: 1000, // stale
      fetch: server,
    });
    await expect(buf.slice(0, 10)).rejects.toBeInstanceOf(
      RangeNotSupportedError,
    );
    expect(chunksPulled).toBeLessThanOrEqual(6);
  });
});
