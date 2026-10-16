/// <reference lib="webworker" />
// The FlatCityBuf stream worker: the shared core over the FlatCityBuf adapter.
import { installStreamWorker } from "@cityjson/navara-stream/worker";
import { createFcbSourceAdapter } from "./fcbSourceAdapter";
installStreamWorker(self as unknown as Worker, createFcbSourceAdapter());
