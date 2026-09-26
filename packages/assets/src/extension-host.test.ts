import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "@babylonslate/core";
import { createExtensionSettings, resolveExtensionGraph, type ExtensionDescriptor } from "./extension-host";

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
});
