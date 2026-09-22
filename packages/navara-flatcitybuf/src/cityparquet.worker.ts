/// <reference lib="webworker" />
// The CityParquet stream worker: the shared core over the CityParquet adapter.
import { createCityParquetSourceAdapter } from "./cityParquetSourceAdapter";
import { installStreamWorker } from "./streamWorkerCore";
installStreamWorker(self as unknown as Worker, createCityParquetSourceAdapter());
