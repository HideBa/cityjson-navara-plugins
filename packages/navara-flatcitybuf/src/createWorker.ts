/**
 * Starts a FlatCityBuf stream worker, for `CityStreamPluginOptions.workers`.
 *
 * The `new Worker(new URL(...))` must be a literal next to the entry it names:
 * Vite only rewrites a literal specifier into a worker chunk, resolved
 * relative to THIS module's real path inside the submodule when the package is
 * consumed through the app's source alias. (tsup does not emit workers, so a
 * published-dist consumer needs a different packaging.)
 */
export function createFlatCityBufWorker(): Worker {
  return new Worker(new URL("./fcb.worker.ts", import.meta.url), {
    type: "module",
  });
}
