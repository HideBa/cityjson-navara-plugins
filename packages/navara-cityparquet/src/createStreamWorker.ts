/**
 * Starts a CityParquet stream worker, for `CityStreamPluginOptions.workers`.
 *
 * The `new Worker(new URL(...))` must be a literal next to the entry it names:
 * Vite only rewrites a literal specifier into a worker chunk.
 */
export function createCityParquetWorker(): Worker {
  return new Worker(new URL("./stream.worker.ts", import.meta.url), {
    type: "module",
  });
}
