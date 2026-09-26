import { describe, expect, it } from "vitest";
import {
  createExtensionSettings,
  discoverEngineExtensions,
  discoverProjectExtensions,
  exportExtensionZip,
  inspectBabextension,
  installEngineExtensionDefaults,
  unpackEngineExtensionZip,
  writeProjectExtension,
} from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { EngineExtensionLibrary } from "./engine-extension-library";

async function storage(name: string) {
  const result = new MemoryStorageAdapter("opfs");
  await result.openDocumentsProject(name);
  return result;
}

async function archive(guid: string, displayName: string, source = "export function activate(api) { api.log('original'); }") {
  const project = await storage("source");
  const settings = { ...createExtensionSettings(displayName, guid), iconKey: "Code", experimental: true };
  const extension = await writeProjectExtension(project, "tool", settings, source);
  await project.writeText("extensions/tool/assets/data.txt", "template");
  return exportExtensionZip(project, extension);
}

async function library() {
  const bundled = await storage("bundled");
  const saved = await storage("library");
  await unpackEngineExtensionZip(bundled, await archive("bundled-guid", "Bundled Tool"), "bundled");
  return { bundled, saved, library: new EngineExtensionLibrary(bundled, saved) };
}

describe("EngineExtensionLibrary", () => {
  it("persists defaults and exports source, assets and metadata across library reloads", async () => {
    const { bundled, saved, library: initial } = await library();
    await initial.import(await archive("user-guid", "User Tool"));
    await initial.setEnabledByDefault("user-guid", true);
    const reloaded = new EngineExtensionLibrary(bundled, saved);
    expect((await reloaded.list()).find((entry) => entry.extensionGuid === "user-guid"))
      .toMatchObject({ bundled: false, enabledByDefault: true });
    const exported = await inspectBabextension(await reloaded.export("user-guid"));
    expect(exported.settings).toMatchObject({ extensionGuid: "user-guid", displayName: "User Tool", iconKey: "Code", experimental: true, enabledByDefault: true });
    expect(new TextDecoder().decode(exported.files.find((file) => file.path === "index.ts")?.data)).toContain("api.log('original')");
    expect(new TextDecoder().decode(exported.files.find((file) => file.path === "assets/data.txt")?.data)).toBe("template");
  });

  it("leaves duplicate-name imports unchanged until confirmed and preserves defaults when identity changes", async () => {
    const { library: store } = await library();
    await store.import(await archive("old-guid", "User Tool"));
    await store.setEnabledByDefault("old-guid", true);
    const incoming = await archive("new-guid", " user TOOL ", "export function activate(api) { api.log('replacement'); }");
    expect(await store.import(incoming)).toMatchObject({ status: "conflict", existing: { extensionGuid: "old-guid" } });
    expect((await inspectBabextension(await store.export("old-guid"))).settings.enabledByDefault).toBe(true);
    expect(await store.import(incoming, { replaceGuid: "old-guid" })).toMatchObject({ status: "imported", entry: { extensionGuid: "new-guid", enabledByDefault: true } });
    await expect(store.export("old-guid")).rejects.toThrow(/no longer exists/i);
    const replacement = await inspectBabextension(await store.export("new-guid"));
    expect(new TextDecoder().decode(replacement.files.find((file) => file.path === "index.ts")?.data)).toContain("api.log('replacement')");
  });

  it("requires GUID replacement confirmation after a rename and rejects conflicting name and GUID owners", async () => {
    const { library: store } = await library();
    await store.import(await archive("first-guid", "First Tool"));
    await store.import(await archive("second-guid", "Second Tool"));
    const renamed = await archive("first-guid", "Renamed Tool");
    expect(await store.import(renamed)).toMatchObject({ status: "conflict", existing: { extensionGuid: "first-guid" } });
    await store.import(renamed, { replaceGuid: "first-guid" });
    expect((await store.list()).find((entry) => entry.extensionGuid === "first-guid")?.settings.displayName).toBe("Renamed Tool");
    await expect(store.import(await archive("first-guid", "Second Tool"), { replaceGuid: "first-guid" })).rejects.toThrow(/name and ID match different/i);
    expect((await store.list()).filter((entry) => !entry.bundled)).toHaveLength(2);
  });

  it("protects bundled identities and names while allowing default changes and downloads", async () => {
    const { library: store } = await library();
    await expect(store.remove("bundled-guid")).rejects.toThrow(/bundled.*cannot be deleted/i);
    await expect(store.import(await archive("other-guid", "bundled TOOL"), { replaceGuid: "bundled-guid" })).rejects.toThrow(/bundled.*cannot be replaced/i);
    await expect(store.import(await archive("bundled-guid", "Different Tool"))).rejects.toThrow(/bundled.*cannot be replaced/i);
    await store.setEnabledByDefault("bundled-guid", true);
    expect((await inspectBabextension(await store.export("bundled-guid"))).settings.enabledByDefault).toBe(true);
  });

  it("freezes snapshots and new-project copies independently of later library defaults, replacement and deletion", async () => {
    const { bundled, saved, library: store } = await library();
    await store.import(await archive("user-guid", "User Tool"));
    await store.setEnabledByDefault("user-guid", true);
    const snapshot = await store.createStorageSnapshot();
    const project = await storage("new-project");
    await installEngineExtensionDefaults(project, snapshot);
    await store.setEnabledByDefault("user-guid", false);
    await store.import(await archive("user-guid", "User Tool", "export function activate() {}"), { replaceGuid: "user-guid" });
    await store.remove("user-guid");
    expect((await discoverEngineExtensions(snapshot)).find((entry) => entry.extensionGuid === "user-guid"))
      .toMatchObject({ settings: { enabledByDefault: true } });
    const copy = (await discoverProjectExtensions(project)).find((entry) => entry.extensionGuid === "user-guid")!;
    expect(copy).toMatchObject({ readOnly: false, settings: { enabledByDefault: true } });
    expect(await project.readText(`${copy.folderPath}/index.ts`)).toContain("api.log('original')");
    await project.writeText(`${copy.folderPath}/index.ts`, "export function activate() {}");
    expect(await snapshot.readText("user-tool/index.ts")).toContain("api.log('original')");
    await expect(snapshot.writeText("user-tool/index.ts", "changed")).rejects.toThrow(/read-only/i);
    expect((await new EngineExtensionLibrary(bundled, saved).list()).map((entry) => entry.extensionGuid)).toEqual(["bundled-guid"]);
  });
});
