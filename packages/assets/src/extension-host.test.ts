import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "@babylonslate/core";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { createExtensionSettings, discoverProjectExtensions, resolveExtensionGraph, writeProjectExtension, type ExtensionDescriptor } from "./extension-host";

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
