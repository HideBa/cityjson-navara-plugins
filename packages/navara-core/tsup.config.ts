import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  // `composite: true` (inherited from tsconfig.base.json for `tsc -b`) makes the
  // dts program demand that every source file be listed up front, which fails as
  // soon as the package has more than one module. The dts build only needs a
  // plain program rooted at the entry.
  dts: {
    compilerOptions: {
      composite: false,
      incremental: false,
      // tsup 8.5.1 hardcodes `baseUrl: compilerOptions.baseUrl || "."` for its
      // dts program (tsup/dist/rollup.js), AFTER spreading ours — so it cannot
      // be unset from here, and TS 6 errors TS5101 on the deprecated option.
      // Our own tsconfigs carry no `baseUrl` (see tsconfig.base.json), so this
      // excuses tsup's injected one only; `tsc -b` stays strict about it.
      ignoreDeprecations: "6.0",
    },
  },
  sourcemap: true,
  clean: true,
  treeshake: true,
});
