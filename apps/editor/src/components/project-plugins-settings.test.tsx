import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createEmptyProject, type PluginEnableOverride } from "@haptic/core";
import { createDefaultPluginSettings, resolvePluginGraph, type PluginDescriptor } from "@haptic/assets";
import { ProjectPluginsSettings } from "./project-plugins-settings";

const harness = vi.hoisted(() => ({
  plugins: [] as PluginDescriptor[],
  overrides: {} as Record<string, PluginEnableOverride>,
  importPlugin: (async () => ({ status: "kept" })) as (bytes: unknown, decision?: unknown, options?: { allowExecuteJavaScript?: boolean }) => Promise<unknown>,
}));

vi.mock("../context/document-context", async () => {
  const { documentContextMock, sharedMockState } = await import("../testing/document-context-mock");
  const projectState = sharedMockState(() => ({
    ...createEmptyProject("Plugins"),
    settings: { ...createEmptyProject("Plugins").settings, pluginOverrides: harness.overrides },
  }));
  return documentContextMock(() => {
    const [project, setProject] = projectState.use();
    return {
      projectDocument: project,
      pluginDescriptors: harness.plugins,
      pluginDiagnostics: resolvePluginGraph(
        harness.plugins.filter((plugin) => project.settings.pluginOverrides[plugin.pluginGuid]?.enabled ?? plugin.settings.enabledByDefault),
      ).diagnostics,
      assetRegistry: null,
      showPluginContent: false,
      applyPluginOverrides: async () => {},
      importPlugin: (bytes: unknown, decision?: unknown, options?: { allowExecuteJavaScript?: boolean }) => harness.importPlugin(bytes, decision, options),
      updateProjectSettings: (patch: { pluginOverrides: Record<string, PluginEnableOverride> }) => {
        harness.overrides = patch.pluginOverrides;
        setProject((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
      },
    };
  });
});

function plugin(guid: string): PluginDescriptor {
  return {
    pluginGuid: guid,
    folderName: guid,
    folderPath: `plugins/${guid}`,
    settingsPath: `plugins/${guid}/${guid}.plugin.hasset`,
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
    expect(resolvePluginGraph(harness.plugins).order.map((entry) => entry.pluginGuid)).toEqual(["base", "pack"]);
    expect(screen.queryByRole("button", { name: "Review Pack Compatibility" })).toBeNull();
  });

  it("keeps an enabled outdated plugin's warning nonblocking and retains the separate Beta enable confirmation", async () => {
    harness.overrides = { pack: { enabled: true } };
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

describe("Plugin import Execute JavaScript disclosure", () => {
  const pick = () => {
    const bytes = new Uint8Array([7]);
    const file = new File([bytes], "Scripted.hplugin");
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
    fireEvent.change(screen.getByTestId("import-plugin-input"), { target: { files: [file] } });
  };
  const disclosed = { status: "executeJavaScript", incoming: {}, assets: [{ guid: "hero", name: "Hero", type: "Class", nodes: [{ nodeId: "a", body: "x" }, { nodeId: "b", body: "y" }] }] };

  it("installs nothing until the dialog is confirmed, keeping the Keep / Replace choice", async () => {
    const importPlugin = vi.fn(async (_bytes: unknown, decision?: unknown, options?: { allowExecuteJavaScript?: boolean }) =>
      options?.allowExecuteJavaScript ? { status: "imported", descriptor: plugin("scripted") } : decision === "replace" ? disclosed : { status: "conflict", incoming: { settings: { displayName: "Scripted" } } });
    harness.importPlugin = importPlugin;
    render(<ProjectPluginsSettings />);
    pick();
    fireEvent.click(await screen.findByTestId("settings-plugin-import-replace"));
    const dialog = await screen.findByTestId("execute-javascript-import-dialog");
    expect(dialog.textContent).toContain("Hero (Class)2 nodes");
    fireEvent.click(screen.getByTestId("execute-javascript-import-confirm"));
    await waitFor(() => expect(importPlugin).toHaveBeenCalledTimes(3));
    expect(importPlugin.mock.calls.map(([, decision, options]) => [decision, options])).toEqual([
      [undefined, { allowExecuteJavaScript: false }],
      ["replace", { allowExecuteJavaScript: false }],
      ["replace", { allowExecuteJavaScript: true }],
    ]);
    await waitFor(() => expect(screen.queryByTestId("execute-javascript-import-dialog")).toBeNull());
  });

  it("Cancel leaves the plugin uninstalled", async () => {
    const importPlugin = vi.fn(async () => disclosed);
    harness.importPlugin = importPlugin;
    render(<ProjectPluginsSettings />);
    pick();
    fireEvent.click(within(await screen.findByTestId("execute-javascript-import-dialog")).getByTestId("execute-javascript-import-cancel"));
    await waitFor(() => expect(screen.queryByTestId("execute-javascript-import-dialog")).toBeNull());
    expect(importPlugin).toHaveBeenCalledTimes(1);
  });
});
