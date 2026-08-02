import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NAVARA_CORE_VERSION } from "../src/index";

describe("@cityjson/navara-core package identity", () => {
  it("exports a version string matching package.json", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf-8"),
    ) as { name: string; version: string };
    expect(manifest.name).toBe("@cityjson/navara-core");
    expect(NAVARA_CORE_VERSION).toBe(manifest.version);
  });

  it("is importable through its package name alias", async () => {
    const mod = await import("@cityjson/navara-core");
    expect(mod.NAVARA_CORE_VERSION).toBe(NAVARA_CORE_VERSION);
  });
});
