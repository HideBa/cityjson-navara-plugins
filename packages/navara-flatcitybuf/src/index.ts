/**
 * @cityjson/navara-flatcitybuf — FlatCityBuf as a source for
 * `@cityjson/navara-stream`: the header admission rules, the source adapter
 * its worker runs, and the factory that starts that worker.
 *
 * Engine-free and Node-importable. `./fcb.worker.ts` is deliberately NOT
 * re-exported: it is a worker entry whose module scope installs an
 * `onmessage` handler, reached only through {@link createFlatCityBufWorker}.
 */
export { checkAdmission, headerModel, openFcb } from "./fcbSource";
export { createFcbSourceAdapter } from "./fcbSourceAdapter";
export { createFlatCityBufWorker } from "./createWorker";
