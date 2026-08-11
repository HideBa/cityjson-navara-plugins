import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
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
    // fails with TS6307 as soon as the barrel re-exports a second module —
    // which it now does. The dts pass only ever needs a plain program rooted
    // at the entry. Same fix, same reason, as navara-cityjson's.
    //
    // tsup 8.5.1 hardcodes `baseUrl: compilerOptions.baseUrl || "."` for its
    // dts program, AFTER spreading ours, so it cannot be unset from here and
    // TS 6 errors TS5101 on the deprecated option. `ignoreDeprecations`
    // excuses tsup's injected `baseUrl` only — our own tsconfigs carry none,
    // and `tsc -b` stays strict about it.
    compilerOptions: {
      paths: {},
      composite: false,
      incremental: false,
      ignoreDeprecations: "6.0",
    },
  },
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: [
    "@navaramap/three",
    "@navaramap/three-default-plugin",
    "three",
    "@cityjson/navara-core",
  ],
});
