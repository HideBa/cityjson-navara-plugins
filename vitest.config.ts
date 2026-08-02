import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  resolve(import.meta.dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
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
