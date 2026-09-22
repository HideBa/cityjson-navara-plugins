/**
 * A source adapter that admits nothing: every `open` is refused with
 * `"unsupported"`, so the registry throws its message and terminates the
 * worker. No entry runs on it today (the CityParquet worker has its real
 * adapter); it stays as the stand-in for a format whose streaming is not
 * available yet. Nothing else can be asked of it.
 */
import type { OpenedSource, StreamSourceAdapter } from "./streamSourceAdapter";

export function createUnsupportedSourceAdapter(
  message: string,
): StreamSourceAdapter {
  const noFile = (): never => {
    throw new Error("no file open");
  };
  return {
    open: (): Promise<OpenedSource> =>
      Promise.resolve({
        header: {
          version: "",
          featuresCount: undefined,
          extent: undefined,
          referenceSystem: undefined,
          epsg: null,
        },
        admission: { code: "unsupported", message },
      }),
    probe: noFile,
    select: noFile,
    appearance: noFile,
    bakeLod: noFile,
    // Closing nothing is not an error: the core closes before a reopen.
    close: () => undefined,
  };
}
