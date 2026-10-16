/**
 * `@cityjson/navara-stream/worker` — what a format's worker entry and source
 * adapter import: the format-agnostic worker core, the adapter contract and
 * the wire protocol. Kept apart from the main barrel so a worker chunk carries
 * the core's own graph and not the main-thread layer machinery.
 */
export { installStreamWorker } from "./streamWorkerCore";
export type {
  StreamWorkerContext,
  StreamWorkerOptions,
} from "./streamWorkerCore";
export type {
  AdmissionCode,
  AdmissionError,
  OpenedSource,
  OpenRequest,
  StreamHeader,
  StreamSourceAdapter,
} from "./streamSourceAdapter";
export { createUnsupportedSourceAdapter } from "./unsupportedSourceAdapter";
export * from "./workerProtocol";
