/// <reference lib="webworker" />
// Placeholder entry: refuses every source until the CityParquet adapter lands.
import { installStreamWorker } from "./streamWorkerCore";
import { createUnsupportedSourceAdapter } from "./unsupportedSourceAdapter";
installStreamWorker(
  self as unknown as Worker,
  createUnsupportedSourceAdapter("CityParquet streaming is not available yet"),
);
