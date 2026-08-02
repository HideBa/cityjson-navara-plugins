import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries: the default barrel is engine-free and Node-importable, while
  // `./plugin` carries the three @navaramap-binding modules (the engine crashes
  // at module scope under Node — Task B1's NODE_IMPORT_SAFE = false).
  entry: ["src/index.ts", "src/plugin.ts"],
  format: ["esm"],
  target: "es2022",
  dts: {
    // tsup's .d.ts pass runs a plain (non-`tsc -b`) program, so it is not
    // project-reference aware: the workspace `paths` aliases from
    // tsconfig.base.json would pull navara-core's *sources* into this
    // package's program and trip rootDir (TS6059/TS6307). Dropping `paths`
    // here resolves @cityjson/navara-core through node_modules to its built
    // dist/index.d.ts — exactly how a published consumer resolves it, and
    // available because `pnpm -r build` builds navara-core first.
    //
    // `composite: true` (also inherited from tsconfig.base.json, for `tsc -b`)
    // makes that same non-project program demand an explicit file list, which
    // fails with TS6307 as soon as the package has more than one module. The
    // dts pass only ever needs a plain program rooted at the entry.
    compilerOptions: { paths: {}, composite: false, incremental: false },
  },
  sourcemap: true,
  clean: true,
  treeshake: true,
  // proj4 and three are singleton registries (a module-global EPSG table and
  // `instanceof` checks): bundling either would give the host a second copy
  // whose registrations are invisible to core's. They stay peer + external.
  external: [
    "@navaramap/three",
    "@navaramap/three-default-plugin",
    "proj4",
    "three",
    "@cityjson/navara-core",
  ],
});
