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
    compilerOptions: { paths: {} },
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
