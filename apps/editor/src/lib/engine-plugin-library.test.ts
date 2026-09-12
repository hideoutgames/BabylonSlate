import { describe, expect, it } from "vitest";
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
    const reloaded = new EnginePluginLibrary(bundled, saved);
    expect((await reloaded.list()).map((entry) => entry.pluginGuid)).toEqual(["bundled-guid"]);
    await expect(captured.writeText("user-pack/assets/data.txt", "changed"))
      .rejects.toThrow(/read-only/i);
  });
});
