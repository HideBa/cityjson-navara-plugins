/// <reference lib="webworker" />
import { installStreamWorker } from "./streamWorkerCore";
import { createFcbSourceAdapter } from "./fcbSourceAdapter";
installStreamWorker(self as unknown as Worker, createFcbSourceAdapter());
