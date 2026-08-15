import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

describe("desktop Electron host", () => {
  it("exposes userData and project IPC channels in preload", () => {
    const preload = readFileSync(join(root, "preload.ts"), "utf8");
    expect(preload).toContain("userData");
    expect(preload).toContain("project");
    expect(preload).toContain("settings:read");
    expect(preload).toContain("secrets:get");
    expect(preload).toContain("lfs:fetch");
    expect(preload).toContain("project:readBinary");
  });

  it("main process uses NodeStorageAdapter for project files", () => {
    const main = readFileSync(join(root, "main.ts"), "utf8");
    expect(main).toContain("NodeStorageAdapter");
    expect(main).toContain("openAbsoluteFolder");
    expect(main).toContain("settings:read");
    expect(main).toContain("safeStorage");
    expect(main).toContain("secrets:get");
    expect(main).toContain("lfs:fetch");
    expect(main).toContain("project:readBinary");
  });
});
