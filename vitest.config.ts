import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  resolve(import.meta.dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    // proj4 and three are singleton registries: proj4 keeps a module-global EPSG
    // table and three relies on `instanceof`. Two copies silently break both, and
    // the source aliases below bypass node_modules resolution, so pin them to one
    // instance here exactly as the app's vite.config.ts does.
    dedupe: ["proj4", "three"],
    alias: {
      "@cityjson/navara-core": pkg("navara-core"),
      "@cityjson/navara-cityjson": pkg("navara-cityjson"),
      "@cityjson/navara-flatcitybuf": pkg("navara-flatcitybuf"),
      "@cityjson/navara-cityparquet": pkg("navara-cityparquet"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/tests/**/*.test.ts"],
  },
});
