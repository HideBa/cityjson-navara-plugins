/// <reference lib="webworker" />
// The CityParquet stream worker: the shared core over the CityParquet adapter.
import { installStreamWorker } from "@cityjson/navara-stream/worker";
import { createCityParquetSourceAdapter } from "./streamAdapter";
installStreamWorker(self as unknown as Worker, createCityParquetSourceAdapter());
