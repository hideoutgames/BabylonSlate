import { describe, expect, it, vi } from "vitest";
import {
  createDefaultPluginSettings,
  discoverEnginePlugins,
  exportPluginZip,
  inspectBabplugin,
  unpackEnginePluginZip,
  writeProjectPlugin,
} from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { EnginePluginLibrary } from "./engine-plugin-library";

async function storage(name: string) {
  const result = new MemoryStorageAdapter("opfs");
  await result.openDocumentsProject(name);
  return result;
}

async function archive(guid: string, displayName: string, content = "original") {
  const source = await storage("source");
  const settings = createDefaultPluginSettings({ pluginGuid: guid, displayName });
  settings.iconKey = "Box";
  settings.beta = true;
  const plugin = await writeProjectPlugin(source, "pack", settings);
  await source.writeText("plugins/pack/assets/data.txt", content);
  return exportPluginZip(source, plugin);
}

async function library() {
  const bundled = await storage("bundled");
  const saved = await storage("library");
  await unpackEnginePluginZip(bundled, await archive("bundled-guid", "Bundled Pack"), "bundled");
  return { bundled, saved, library: new EnginePluginLibrary(bundled, saved) };
}

describe("EnginePluginLibrary", () => {
  it("persists user archives and defaults and exports their content and metadata", async () => {
    const { bundled, saved, library: initial } = await library();
    await initial.import(await archive("user-guid", "User Pack"));
    await initial.setEnabledByDefault("user-guid", true);
    const reloaded = new EnginePluginLibrary(bundled, saved);
    expect((await reloaded.list()).find((entry) => entry.pluginGuid === "user-guid"))
      .toMatchObject({ bundled: false, enabledByDefault: true });
    const inspected = await inspectBabplugin(await reloaded.export("user-guid"));
    expect(inspected.settings).toMatchObject({
      pluginGuid: "user-guid", displayName: "User Pack", iconKey: "Box", beta: true,
      enabledByDefault: true,
    });
    const content = inspected.files.find((file) => file.path === "assets/data.txt");
    expect(new TextDecoder().decode(content?.data)).toBe("original");
  });

  it("requires confirmation for duplicate names and preserves the global default on replacement", async () => {
    const { library: store } = await library();
    await store.import(await archive("old-guid", "User Pack"));
    await store.setEnabledByDefault("old-guid", true);
    const incoming = await archive("new-guid", " user PACK ", "replacement");
    expect(await store.import(incoming)).toMatchObject({
      status: "conflict", existing: { pluginGuid: "old-guid" },
    });
    expect((await inspectBabplugin(await store.export("old-guid"))).settings.pluginGuid)
      .toBe("old-guid");
    expect(await store.import(incoming, { replaceGuid: "old-guid" })).toMatchObject({
      status: "imported", entry: { pluginGuid: "new-guid", enabledByDefault: true },
    });
    await expect(store.export("old-guid")).rejects.toThrow(/no longer exists/i);
    const replaced = await inspectBabplugin(await store.export("new-guid"));
    expect(new TextDecoder().decode(replaced.files.find((file) => file.path === "assets/data.txt")?.data))
      .toBe("replacement");
  });

  it("requires confirmation for a renamed plugin with the same GUID", async () => {
    const { library: store } = await library();
    await store.import(await archive("user-guid", "First Name"));
    const incoming = await archive("user-guid", "New Name");
    expect(await store.import(incoming)).toMatchObject({ status: "conflict" });
    await store.import(incoming, { replaceGuid: "user-guid" });
    expect((await store.list()).filter((entry) => !entry.bundled))
      .toMatchObject([{ settings: { displayName: "New Name" } }]);
  });

  it("protects bundled names and GUIDs while allowing their defaults and download", async () => {
    const { library: store } = await library();
    await expect(store.remove("bundled-guid")).rejects.toThrow(/bundled.*cannot be deleted/i);
    await expect(store.import(await archive("other-guid", "bundled PACK"), { replaceGuid: "bundled-guid" }))
      .rejects.toThrow(/bundled.*cannot be replaced/i);
    await expect(store.import(await archive("bundled-guid", "Different Name")))
      .rejects.toThrow(/bundled.*cannot be replaced/i);
    await store.setEnabledByDefault("bundled-guid", true);
    expect((await inspectBabplugin(await store.export("bundled-guid"))).settings.enabledByDefault)
      .toBe(true);
  });

  it("does not replace two different entries when the incoming name and GUID disagree", async () => {
    const { library: store } = await library();
    await store.import(await archive("first-guid", "First Pack"));
    await store.import(await archive("second-guid", "Second Pack"));
    await expect(store.import(await archive("first-guid", "Second Pack"), { replaceGuid: "first-guid" }))
      .rejects.toThrow(/name and ID match different/i);
    expect((await store.list()).filter((entry) => !entry.bundled)).toHaveLength(2);
  });

  it("keeps captured storage unchanged when defaults change or user plugins are deleted", async () => {
    const { bundled, saved, library: store } = await library();
    await store.import(await archive("user-guid", "User Pack"));
    await store.setEnabledByDefault("user-guid", true);
    const captured = await store.createStorageSnapshot();
    await store.setEnabledByDefault("user-guid", false);
    await store.remove("user-guid");
    expect((await discoverEnginePlugins(captured)).find((entry) => entry.pluginGuid === "user-guid"))
      .toMatchObject({ settings: { enabledByDefault: true } });
    expect(await captured.readText("user-pack/assets/data.txt")).toBe("original");
    const reloaded = new EnginePluginLibrary(bundled, saved);
    expect((await reloaded.list()).map((entry) => entry.pluginGuid)).toEqual(["bundled-guid"]);
    await expect(captured.writeText("user-pack/assets/data.txt", "changed"))
      .rejects.toThrow(/read-only/i);
  });

  it("allows metadata actions without reading bundled content files", async () => {
    const { bundled, library: store } = await library();
    await store.import(await archive("user-guid", "User Pack"));
    const readBinary = bundled.readBinary.bind(bundled);
    vi.spyOn(bundled, "readBinary").mockImplementation(async (path) => {
      if (path.startsWith("bundled/assets/")) {
        throw new Error("Content storage is temporarily unavailable");
      }
      return readBinary(path);
    });
    expect(await store.list()).toHaveLength(2);
    await store.setEnabledByDefault("bundled-guid", true);
    await store.remove("user-guid");
    expect(await store.list()).toMatchObject([
      { pluginGuid: "bundled-guid", enabledByDefault: true },
    ]);
  });

  it("lists and captures imported plugins without reading content until a snapshot requests it", async () => {
    const { bundled, saved, library: store } = await library();
    await store.import(await archive("user-guid", "User Pack"));
    const savedRead = vi.spyOn(saved, "readBinary");
    const bundledRead = vi.spyOn(bundled, "readBinary");
    expect(await store.list()).toHaveLength(2);
    const snapshot = await store.createStorageSnapshot();
    expect(savedRead.mock.calls.some(([path]) => path.startsWith("content/"))).toBe(false);
    expect(bundledRead.mock.calls.some(([path]) => path.startsWith("bundled/assets/"))).toBe(false);
    expect(await snapshot.readText("user-pack/assets/data.txt")).toBe("original");
    expect(savedRead.mock.calls.some(([path]) => path.endsWith("/assets/data.txt"))).toBe(true);
  });

  it("keeps the old snapshot usable after a replacement publishes a new generation", async () => {
    const { library: store } = await library();
    await store.import(await archive("user-guid", "User Pack"));
    const original = await store.createStorageSnapshot();
    await store.import(await archive("user-guid", "User Pack", "replacement"), { replaceGuid: "user-guid" });
    expect(await original.readText("user-pack/assets/data.txt")).toBe("original");
    expect(await (await store.createStorageSnapshot()).readText("user-pack/assets/data.txt")).toBe("replacement");
  });

  it.each([false, true])("keeps the prior library listing when defaults persistence fails (replacement: %s)", async (replace) => {
    const { saved, library: store } = await library();
    if (replace) {
      await store.import(await archive("original-guid", "User Pack"));
      await store.setEnabledByDefault("original-guid", true);
    }
    const before = await store.list();
    const writeText = saved.writeText.bind(saved);
    let failed = false;
    const failingWrite = vi.spyOn(saved, "writeText").mockImplementation(async (path, value) => {
      await writeText(path, value);
      if (!failed && path === "defaults.json") {
        failed = true;
        throw new Error("Defaults write failed");
      }
    });

    await expect(store.import(await archive("incoming-guid", "User Pack", "replacement"),
      replace ? { replaceGuid: "original-guid" } : {})).rejects.toThrow("Defaults write failed");

    expect(await store.list()).toEqual(before);
    if (replace) {
      const restored = await inspectBabplugin(await store.export("original-guid"));
      expect(restored.settings.enabledByDefault).toBe(true);
      expect(new TextDecoder().decode(restored.files.find((file) => file.path === "assets/data.txt")?.data)).toBe("original");
    }
    failingWrite.mockRestore();
  });

  it("falls back to plugin defaults when the saved defaults file is unreadable", async () => {
    const { saved, library: store } = await library();
    await store.import(await archive("user-guid", "User Pack"));
    await saved.writeText("defaults.json", "{not json");
    expect((await store.list()).map((entry) => entry.enabledByDefault)).toEqual([false, false]);
    await store.setEnabledByDefault("user-guid", true);
    expect((await store.list()).find((entry) => entry.pluginGuid === "user-guid")?.enabledByDefault).toBe(true);
  });
});
