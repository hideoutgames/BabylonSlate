import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createEmptyProject, type PluginEnableOverride } from "@babylonslate/core";
import { createDefaultPluginSettings, resolvePluginGraph, type PluginDescriptor } from "@babylonslate/assets";
import { ProjectPluginsSettings } from "./project-plugins-settings";

const harness = vi.hoisted(() => ({
  plugins: [] as PluginDescriptor[],
  overrides: {} as Record<string, PluginEnableOverride>,
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => {
    const [project, setProject] = useState(() => ({
      ...createEmptyProject("Plugins"),
      settings: { ...createEmptyProject("Plugins").settings, pluginOverrides: harness.overrides },
    }));
    return {
      projectDocument: project,
      pluginDescriptors: harness.plugins,
      pluginDiagnostics: resolvePluginGraph(
        harness.plugins.filter((plugin) => project.settings.pluginOverrides[plugin.pluginGuid]?.enabled ?? plugin.settings.enabledByDefault),
        undefined,
        project.settings.pluginOverrides,
      ).diagnostics,
      assetRegistry: null,
      showPluginContent: false,
      applyPluginOverrides: async () => {},
      updateProjectSettings: (patch: { pluginOverrides: Record<string, PluginEnableOverride> }) => {
        harness.overrides = patch.pluginOverrides;
        setProject({ ...project, settings: { ...project.settings, ...patch } });
      },
    };
  },
}));

function plugin(guid: string): PluginDescriptor {
  return {
    pluginGuid: guid,
    folderName: guid,
    folderPath: `plugins/${guid}`,
    settingsPath: `plugins/${guid}/${guid}.plugin.babasset`,
    contentPath: `plugins/${guid}/assets`,
    source: "project",
    readOnly: false,
    settings: createDefaultPluginSettings({ pluginGuid: guid, displayName: guid === "pack" ? "Pack" : "Base Tools" }),
  };
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const pack = plugin("pack");
  pack.settings.engineVersion = "old-engine";
  pack.settings.pluginDependencies = [{ guid: "base", version: "0.1" }];
  const base = plugin("base");
  base.settings.enabledByDefault = true;
  base.settings.version = "2.7";
  harness.plugins = [pack, base];
  harness.overrides = {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Plugin version warnings", () => {
  it("enables an outdated plugin without a popup and shows the differences inline", async () => {
    render(<ProjectPluginsSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Enable Pack" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Pack" }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const warning = screen.getByText(/Warning:.*old-engine/);
    expect(warning.textContent).toContain("Base Tools");
    expect(warning.textContent).toContain("2.7");
    expect(resolvePluginGraph(harness.plugins, undefined, harness.overrides).order.map((entry) => entry.pluginGuid)).toEqual(["base", "pack"]);
    expect(screen.queryByRole("button", { name: "Review Pack Compatibility" })).toBeNull();
  });

  it("keeps stale acknowledgements nonblocking and retains the separate Beta enable confirmation", async () => {
    harness.overrides = { pack: { enabled: true, acceptedCompatibility: "previous-context" } };
    harness.plugins[0]!.settings.beta = true;
    render(<ProjectPluginsSettings />);
    expect(screen.getByText(/Warning:.*old-engine/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Enable Pack" }));
    await waitFor(() => expect(harness.overrides.pack).toEqual({ enabled: false }));
    fireEvent.click(screen.getByRole("switch", { name: "Enable Pack" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Enable Beta Plugin" });
    expect(dialog.textContent).toContain("Pack is marked Beta");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(harness.overrides.pack).toEqual({ enabled: false });
  });
});
