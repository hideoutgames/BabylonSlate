import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "./memory-adapter";
import { createMountedProjectStorage } from "./mounted-storage";

describe("mounted project storage", () => {
  it("takes metadata-only views and routes settings overlays without copying source payloads", async () => {
    const source = new MemoryStorageAdapter(), overrides = new MemoryStorageAdapter();
    await source.openDocumentsProject("source");
    await overrides.openDocumentsProject("overrides");
    await source.writeBinary("generation/assets/large", new Uint8Array(1024));
    await source.writeText("generation/settings", "original");
    await overrides.writeText("settings", "override");
    const fullRead = vi.spyOn(source, "readBinary");
    const view = createMountedProjectStorage([
      { path: "plugin", storage: source, sourcePath: "generation" },
      { path: "plugin/settings", storage: overrides, sourcePath: "settings" },
      { path: "plugin/virtual/note", storage: overrides, sourcePath: "settings" },
    ]);
    expect((await view.readdir(".")).map(entry => entry.name)).toEqual(["plugin"]);
    expect((await view.readdir("plugin")).map(entry => entry.name)).toEqual(["assets", "settings", "virtual"]);
    expect((await view.readdir("plugin/virtual")).map(entry => entry.name)).toEqual(["note"]);
    expect(source.getReadMetrics().actualBytesRead).toBe(0);
    expect(await view.readText("plugin/settings")).toBe("override");
    expect((await view.readBinaryRange("plugin/assets/large", 10, 3)).bytes).toEqual(new Uint8Array(3));
    expect(source.getReadMetrics().actualBytesRead).toBe(3);
    expect(fullRead).not.toHaveBeenCalled();
    await expect(view.remove("plugin/assets/large")).rejects.toThrow(/read-only/i);
    await expect(view.readBinaryRange("../plugin/settings", 0, 1)).rejects.toThrow(/path/i);
    expect(await source.readText("generation/settings")).toBe("original");
  });
});
