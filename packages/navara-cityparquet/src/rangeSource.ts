/**
 * Range-read sources for hyparquet: a `Blob` (a dropped file) and an HTTP URL,
 * each an `AsyncBuffer` whose `slice` reads only the bytes asked for.
 *
 * Both count the bytes they have read, so a caller can see what a query cost,
 * and both fetch every slice under a signal the caller swaps per request: a
 * worker serving a stream of viewport requests sets the current request's
 * signal before each read, so aborting one request cancels its in-flight range
 * reads without poisoning the next request, which brings a fresh signal.
 *
 * Nothing is cached here. Caching belongs to whoever knows which ranges are
 * worth keeping; a buffer that kept every slice would grow to the whole file
 * over a long session, which is what range reads exist to avoid.
 *
 * Engine-free: no `@navaramap/*` imports.
 */

import type { AsyncBuffer } from "./vendor/hyparquet/index.js";

export interface RangeBuffer extends AsyncBuffer {
  readonly bytesRead: () => number;
  /** The signal every subsequent `slice` is fetched under — set per request
   *  by the worker (`fetch`/`probe`), so an abort cancels in-flight range
   *  reads and a later request is not poisoned by an earlier abort. */
  setSignal(signal: AbortSignal | undefined): void;
}

/** The server answered a ranged GET with the whole file (`200`), and the file
 *  is large enough that downloading everything is not an acceptable fallback;
 *  also thrown when the file's length cannot be learned at all. */
export class RangeNotSupportedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RangeNotSupportedError";
  }
}

/** A `200` to a ranged GET is tolerated for a resource up to this size (the
 *  body is small enough to slice locally); above it the server is treated as
 *  range-less. */
const MAX_UNRANGED_BYTES = 4 * 1024 * 1024;

/** The error an aborted signal rejects with: its reason when that is an
 *  Error, else a plain `AbortError`. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

/** Throws the signal's abort reason when it has already fired. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Settles with `promise`, or rejects with the abort reason as soon as `signal`
 * fires — whichever comes first. A body stream is not guaranteed to honour the
 * request's signal (a polyfill, a service-worker response, a test double), so
 * the read is raced rather than trusted; `onAbort` releases whatever the
 * losing promise was holding.
 */
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(abortReason(signal));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Clamps a hyparquet slice request to the buffer. */
function clampRange(
  start: number,
  end: number | undefined,
  byteLength: number,
): [number, number] {
  const s = Math.max(0, Math.min(start, byteLength));
  const e = Math.max(s, Math.min(end ?? byteLength, byteLength));
  return [s, e];
}

/**
 * A `Blob` (or `File`) as a range-read buffer. `Blob#slice` is lazy, so each
 * read touches only its own bytes; the signal is checked before a read starts
 * and after it settles (a local read cannot be interrupted mid-flight).
 */
export function asyncBufferFromBlob(blob: Blob): RangeBuffer {
  let bytesRead = 0;
  let signal: AbortSignal | undefined;
  return {
    byteLength: blob.size,
    bytesRead: () => bytesRead,
    setSignal(next) {
      signal = next;
    },
    async slice(start, end) {
      const current = signal;
      throwIfAborted(current);
      const [s, e] = clampRange(start, end, blob.size);
      const buf = await blob.slice(s, e).arrayBuffer();
      throwIfAborted(current);
      bytesRead += buf.byteLength;
      return buf;
    },
  };
}

/**
 * The total length from a `Content-Range: bytes a-b/total` header, or `null`
 * when the header is absent or the total is unknown (`*`).
 */
function totalFromContentRange(header: string | null): number | null {
  const m = header ? /\/(\d+)\s*$/.exec(header) : null;
  return m ? Number(m[1]) : null;
}

/** Discards a response body we will not read, so the connection is freed. */
function discardBody(res: Response): void {
  res.body?.cancel().catch(() => {});
}

/** The response's own `Content-Length`, or `null` when absent or malformed. */
function contentLengthOf(res: Response): number | null {
  const header = res.headers.get("Content-Length");
  return header !== null && /^\d+$/.test(header.trim()) ? Number(header) : null;
}

/**
 * Reads a response body under `signal`, refusing (and cancelling) once it
 * passes `cap` bytes when a cap is given. A `200` answer carries the whole
 * resource, whose real size the caller's `byteLength` may not reflect (a
 * stale value, a server without `Content-Length`), so the cap is enforced on
 * the bytes as they arrive rather than on what anyone claimed up front.
 */
async function readBody(
  res: Response,
  signal: AbortSignal | undefined,
  cap: { bytes: number; refusal: () => Error } | null,
): Promise<ArrayBuffer> {
  const body = res.body;
  if (body === null) {
    return abortable(res.arrayBuffer(), signal, () => {});
  }
  const reader = body.getReader();
  const release = () => {
    reader.cancel().catch(() => {});
  };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await abortable(reader.read(), signal, release);
    if (done) break;
    total += value.byteLength;
    if (cap !== null && total > cap.bytes) {
      release();
      throw cap.refusal();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/** The resource's byte length: `HEAD`'s Content-Length, else a one-byte
 *  ranged GET's Content-Range total. */
async function probeByteLength(
  url: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  const head = await fetchImpl(url, { method: "HEAD" });
  if (head.ok) {
    const length = head.headers.get("Content-Length");
    if (length !== null && /^\d+$/.test(length.trim())) return Number(length);
  }
  const probe = await fetchImpl(url, { headers: { Range: "bytes=0-0" } });
  const total =
    probe.status === 206
      ? totalFromContentRange(probe.headers.get("Content-Range"))
      : null;
  discardBody(probe);
  if (total === null) {
    throw new RangeNotSupportedError(
      `Could not determine the size of ${url}: the server sent neither a Content-Length for HEAD nor a Content-Range for a ranged request (HTTP ${probe.status}).`,
    );
  }
  return total;
}

/** Own implementation (not hyparquet's `asyncBufferFromUrl`, which accepts a
 *  200 by downloading and retaining the whole file): HEAD for the length
 *  (fallback: `Range: bytes=0-0` and read `Content-Range`), then one ranged
 *  GET per slice; a `200` to a ranged GET of more than 4 MiB throws
 *  `RangeNotSupportedError` (measured on the file, which a `200` carries
 *  whole: a small slice of a large file answered `200` throws too — by the
 *  response's own Content-Length when it sends one, else by the claimed
 *  length, and in every case by a 4 MiB cap on the body read); a signal that
 *  fires mid-slice rejects the slice with its abort reason even when the
 *  fetch or its body ignores it; no slice is cached. */
export async function asyncBufferFromHttp(
  url: string,
  opts: { byteLength?: number; fetch?: typeof fetch } = {},
): Promise<RangeBuffer> {
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const byteLength = opts.byteLength ?? (await probeByteLength(url, fetchImpl));
  let bytesRead = 0;
  let signal: AbortSignal | undefined;

  return {
    byteLength,
    bytesRead: () => bytesRead,
    setSignal(next) {
      signal = next;
    },
    async slice(start, end) {
      const current = signal;
      throwIfAborted(current);
      const [s, e] = clampRange(start, end, byteLength);
      if (s === e) return new ArrayBuffer(0);
      const res = await fetchImpl(url, {
        headers: { Range: `bytes=${s}-${e - 1}` },
        signal: current,
      });
      // A fetch that ignored the signal must not hand back an aborted read.
      if (current?.aborted) {
        discardBody(res);
        throw abortReason(current);
      }
      if (res.status === 206) {
        const buf = await readBody(res, current, null);
        bytesRead += buf.byteLength;
        if (buf.byteLength !== e - s) {
          throw new Error(
            `Range request for bytes ${s}-${e - 1} of ${url} returned ${buf.byteLength} bytes instead of ${e - s}.`,
          );
        }
        return buf;
      }
      if (res.status === 200) {
        // A 200 carries the WHOLE resource, so the size that matters is the
        // file's, not the range's: a 1 KiB slice of a 335 MB file answered 200
        // would otherwise download all of it. The response's own
        // Content-Length is the authority (the caller's `byteLength` may be
        // stale); without one, the claimed length decides, and the body read
        // is capped anyway so an understated claim still cannot pull in a
        // large file.
        const declared = contentLengthOf(res);
        const size = declared ?? byteLength;
        const refusal = () =>
          new RangeNotSupportedError(
            `The server for ${url} does not support range requests: it answered a ${e - s}-byte range with the whole ${size}-byte file.`,
          );
        if (size > MAX_UNRANGED_BYTES) {
          discardBody(res);
          throw refusal();
        }
        const whole = await readBody(res, current, {
          bytes: MAX_UNRANGED_BYTES,
          refusal,
        });
        bytesRead += whole.byteLength;
        return whole.slice(s, e);
      }
      discardBody(res);
      throw new Error(
        `Range request for bytes ${s}-${e - 1} of ${url} failed with HTTP ${res.status}.`,
      );
    },
  };
}
