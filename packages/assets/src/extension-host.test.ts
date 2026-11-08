import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "@haptic/core";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { encodeAssetDocument } from "./asset-document";
import { projectContentRoot } from "./content-root";
import { createExtensionSettings, discoverProjectExtensions, mountExtensionContentRoots, readExtensionCodeFiles, resolveExtensionGraph, writeProjectExtension, type ExtensionDescriptor } from "./extension-host";
import { normalizeExtensionSettings } from "./extension-settings";
import { AssetRegistry } from "./registry";

function extension(guid: string, dependencies: string[] = []): ExtensionDescriptor {
  return {
    extensionGuid: guid,
    folderName: guid,
    folderPath: `extensions/${guid}`,
    settingsPath: `extensions/${guid}/extension.json`,
    contentPath: `extensions/${guid}/assets`,
    source: "project",
    readOnly: false,
    settings: {
      ...createExtensionSettings(guid, guid),
      enabledByDefault: true,
      extensionDependencies: dependencies.map((guid) => ({ guid, version: "1.0.0" })),
    },
  };
}

describe("Extension enablement", () => {
  it("orders enabled dependencies first and blocks dependents when a prerequisite is disabled", () => {
    const extensions = [extension("tool", ["base"]), extension("base"), extension("independent")];
    expect(resolveExtensionGraph(extensions).order.map((extension) => extension.extensionGuid)).toEqual(["base", "independent", "tool"]);
    const disabled = resolveExtensionGraph(extensions, ENGINE_VERSION, { base: { enabled: false } });
    expect(disabled.order.map((extension) => extension.extensionGuid)).toEqual(["independent"]);
    expect(disabled.diagnostics).toEqual([expect.objectContaining({ code: "extension.missing", extensionGuid: "tool", dependencyGuid: "base", severity: "error" })]);
  });

  it("allows explicit project enablement and reports version differences without preventing activation", () => {
    const tool = extension("tool");
    tool.settings.enabledByDefault = false;
    tool.settings.engineVersion = "old-engine";
    expect(resolveExtensionGraph([tool]).order).toEqual([]);
    const enabled = resolveExtensionGraph([tool], ENGINE_VERSION, { tool: { enabled: true } });
    expect(enabled.order.map((extension) => extension.extensionGuid)).toEqual(["tool"]);
    expect(enabled.diagnostics).toEqual([expect.objectContaining({ code: "extension.engine_unsatisfiable", severity: "warning" })]);
  });

  it("isolates missing dependencies and cycles while unrelated modules remain available", () => {
    const result = resolveExtensionGraph([
      extension("dependent", ["missing-base"]),
      extension("missing-base", ["absent"]),
      extension("cycle-a", ["cycle-b"]),
      extension("cycle-b", ["cycle-a"]),
      extension("independent"),
    ]);
    expect(result.order.map((extension) => extension.extensionGuid)).toEqual(["independent"]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "extension.missing", extensionGuid: "missing-base" }),
      expect.objectContaining({ code: "extension.dependency_blocked", extensionGuid: "dependent" }),
      expect.objectContaining({ code: "extension.cycle", extensions: ["cycle-a", "cycle-b"] }),
    ]));
  });

  it("keeps malformed packages visible for deletion without disabling healthy modules", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("extensions");
    await writeProjectExtension(storage, "healthy", { ...createExtensionSettings("Healthy", "healthy"), enabledByDefault: true });
    await storage.mkdir("extensions/broken", true);
    await storage.writeText("extensions/broken/extension.json", "{invalid json");
    const discovered = await discoverProjectExtensions(storage);
    const broken = discovered.find((entry) => entry.folderName === "broken")!;
    expect(broken).toMatchObject({ folderPath: "extensions/broken", readOnly: false, invalid: expect.any(String), settings: { enabledByDefault: false } });
    expect((await discoverProjectExtensions(storage)).find((entry) => entry.folderName === "broken")?.extensionGuid).toBe(broken.extensionGuid);
    const graph = resolveExtensionGraph(discovered, ENGINE_VERSION, { [broken.extensionGuid]: { enabled: true } });
    expect(graph.order.map((entry) => entry.extensionGuid)).toEqual(["healthy"]);
    expect(graph.diagnostics).toEqual([expect.objectContaining({ code: "extension.invalid", extensionGuid: broken.extensionGuid })]);
    await storage.remove(broken.folderPath);
    expect((await discoverProjectExtensions(storage)).map((entry) => entry.extensionGuid)).toEqual(["healthy"]);
  });

  it("isolates every duplicate identity and restores the survivor after a conflicting copy is removed", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("extensions");
    const duplicate = { ...createExtensionSettings("Duplicated", "duplicate"), enabledByDefault: true };
    await writeProjectExtension(storage, "first", duplicate);
    await writeProjectExtension(storage, "second", duplicate);
    await writeProjectExtension(storage, "healthy", { ...createExtensionSettings("Healthy", "healthy"), enabledByDefault: true });
    const discovered = await discoverProjectExtensions(storage);
    const invalid = discovered.filter((entry) => entry.invalid);
    expect(invalid).toHaveLength(2);
    expect(new Set(invalid.map((entry) => entry.extensionGuid)).size).toBe(2);
    expect(resolveExtensionGraph(discovered).order.map((entry) => entry.extensionGuid)).toEqual(["healthy"]);
    expect(resolveExtensionGraph(discovered).diagnostics.filter((entry) => entry.code === "extension.invalid")).toHaveLength(2);
    await storage.remove("extensions/second");
    const recovered = await discoverProjectExtensions(storage);
    expect(recovered.find((entry) => entry.folderName === "first")).toMatchObject({ extensionGuid: "duplicate", settings: { enabledByDefault: true } });
    expect(resolveExtensionGraph(recovered).order.map((entry) => entry.extensionGuid)).toEqual(["duplicate", "healthy"]);
  });
});

describe("Gameplay extensions", () => {
  it("start Editor Only with a game entry and a Library Name from the display name", () => {
    expect(createExtensionSettings("GLSL to Material", "g")).toMatchObject({
      editorOnly: true, gameEntryPoint: "game.ts", libraryName: "glslToMaterial", appearInContentBrowser: false,
    });
    expect(createExtensionSettings("3D Tools", "t").libraryName).toBe("_3dTools");
    // Hand-written manifests may leave the gameplay fields out.
    const { editorOnly, gameEntryPoint, libraryName, appearInContentBrowser, ...minimal } = createExtensionSettings("Weather Kit", "w");
    void [editorOnly, gameEntryPoint, libraryName, appearInContentBrowser];
    expect(normalizeExtensionSettings(minimal)).toMatchObject({ editorOnly: true, gameEntryPoint: "game.ts", libraryName: "weatherKit", appearInContentBrowser: false });
    expect(normalizeExtensionSettings({ ...minimal, editorOnly: false, libraryName: " weather ", appearInContentBrowser: true }))
      .toMatchObject({ editorOnly: false, libraryName: "weather", appearInContentBrowser: true });
  });

  it("read every code file of a package except its assets", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Code Files");
    await writeProjectExtension(storage, "tools", createExtensionSettings("Tools", "tools"), "export function activate() {}");
    await storage.mkdir("extensions/tools/code/nested", true);
    await storage.writeText("extensions/tools/code/nested/util.ts", "export const util = 1;");
    await storage.writeText("extensions/tools/code/notes.md", "not code");
    await storage.writeText("extensions/tools/assets/script.js", "asset data, not code");
    expect((await readExtensionCodeFiles(storage, "extensions/tools")).map((file) => file.path)).toEqual(["code/nested/util.ts", "index.ts"]);
  });

  it("mount the assets of gameplay packages only, and unmount a package that becomes Editor Only", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Roots");
    const gameplay = { ...extension("weather"), settings: { ...extension("weather").settings, editorOnly: false } };
    const editorOnly = extension("tools");
    for (const entry of [gameplay, editorOnly]) {
      await storage.mkdir(entry.contentPath, true);
      await storage.writeBinary(`${entry.contentPath}/Rain.material.hasset`, await encodeAssetDocument({ type: "Material", name: "Rain", guid: `${entry.extensionGuid}-rain`, version: 1, payload: {} }));
    }
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());

    await mountExtensionContentRoots(registry, [gameplay, editorOnly]);
    expect(registry.listRoots().map((root) => [root.id, root.kind, root.pathPrefix])).toEqual([
      ["project", "project", "assets"], ["extension:weather", "extension", "extensions/weather/assets"],
    ]);
    expect(registry.getByGuid("weather-rain")?.rootId).toBe("extension:weather");
    expect(registry.getByGuid("tools-rain")).toBeUndefined();

    await mountExtensionContentRoots(registry, [{ ...gameplay, settings: { ...gameplay.settings, editorOnly: true } }]);
    expect(registry.listRoots().map((root) => root.id)).toEqual(["project"]);
    expect(registry.getByGuid("weather-rain")).toBeUndefined();
  });
});
