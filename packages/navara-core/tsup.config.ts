import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  // `composite: true` (inherited from tsconfig.base.json for `tsc -b`) makes the
  // dts program demand that every source file be listed up front, which fails as
  // soon as the package has more than one module. The dts build only needs a
  // plain program rooted at the entry.
  dts: { compilerOptions: { composite: false, incremental: false } },
  sourcemap: true,
  clean: true,
  treeshake: true,
});
