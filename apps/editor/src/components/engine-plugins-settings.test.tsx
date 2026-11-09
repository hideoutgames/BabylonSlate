import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createEmptyProject, type PluginEnableOverride } from "@haptic/core";
import { createDefaultPluginSettings, type PluginDescriptor } from "@haptic/assets";
import { EnginePluginsSettings } from "./engine-plugins-settings";
import type { EnginePluginEntry } from "../lib/engine-plugin-library";

// Base UI forwards switch clicks using PointerEvent; jsdom lacks it.
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
}

const { library, download, project } = vi.hoisted(() => ({
  library: {
    list: vi.fn(),
    setEnabledByDefault: vi.fn(),
    remove: vi.fn(),
    export: vi.fn(),
  },
  download: vi.fn(),
  project: {
    open: false,
    plugins: [] as PluginDescriptor[],
    overrides: {} as Record<string, PluginEnableOverride>,
    applyPluginOverrides: vi.fn(),
    importPlugin: vi.fn(),
    // Assets per root, and which assets each one is referenced by.
    assets: [] as Array<{ rootId: string; header: { guid: string; name: string } }>,
    inbound: {} as Record<string, string[]>,
  },
}));
vi.mock("../lib/engine-plugin-library", () => ({
  ensureEnginePluginLibrary: async () => library,
}));
vi.mock("../lib/plugin-download", () => ({ savePluginArchive: download }));
vi.mock("../context/document-context", async () => {
  const { documentContextMock, sharedMockState } = await import("../testing/document-context-mock");
  const projectState = sharedMockState(() => {
    const empty = createEmptyProject("Demo");
    return { ...empty, settings: { ...empty.settings, pluginOverrides: project.overrides } };
  });
  return documentContextMock(() => {
    const [document, setDocument] = projectState.use();
    if (!project.open) return {};
    return {
      projectDocument: document,
      projectName: "Demo",
      pluginDescriptors: project.plugins,
      assetRegistry: {
        list: () => project.assets,
        showReferences: (guid: string) => ({ inbound: project.inbound[guid] ?? [] }),
      },
      applyPluginOverrides: project.applyPluginOverrides,
      importPlugin: project.importPlugin,
      updateProjectSettings: (patch: { pluginOverrides: Record<string, PluginEnableOverride> }) => {
        project.overrides = patch.pluginOverrides;
        setDocument((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
      },
    };
  });
});

function entry(guid: string, bundled: boolean): EnginePluginEntry {
  return {
    pluginGuid: guid,
    source: "engine",
    folderName: guid,
    folderPath: `engine-plugins/${guid}`,
    contentPath: `engine-plugins/${guid}/assets`,
    settingsPath: `engine-plugins/${guid}/plugin.plugin.hasset`,
    settings: createDefaultPluginSettings({
      pluginGuid: guid,
      displayName: bundled ? "Starter Content" : "User Plugin",
    }),
    bundled,
    enabledByDefault: false,
    readOnly: true,
  };
}
let entries: EnginePluginEntry[];
beforeEach(() => {
  vi.resetAllMocks();
  entries = [entry("bundled", true), entry("custom", false)];
  library.list.mockImplementation(async () => entries);
  library.setEnabledByDefault.mockImplementation(async (guid: string, enabled: boolean) => {
    entries = entries.map((item) => item.pluginGuid === guid ? { ...item, enabledByDefault: enabled } : item);
  });
  project.open = false;
  project.overrides = {};
  project.assets = [];
  project.inbound = {};
  // The open project sees the bundled plugin but has no copy of the user-added one.
  project.plugins = [entry("bundled", true)];
});
afterEach(cleanup);

describe("EnginePluginsSettings", () => {
  it("persists a default toggle and exposes only download for a bundled entry", async () => {
    library.setEnabledByDefault.mockImplementation(
      async (guid: string, enabled: boolean) => {
        entries = entries.map((item) =>
          item.pluginGuid === guid
            ? { ...item, enabledByDefault: enabled }
            : item,
        );
      },
    );
    const bytes = new Uint8Array([4, 5]);
    library.export.mockResolvedValue(bytes);
    render(<EnginePluginsSettings />);
    const row = await screen.findByTestId("engine-plugin-row-bundled");
    expect(within(row).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Open" })).toBeNull();
    fireEvent.click(within(row).getByRole("switch"));
    await waitFor(() =>
      expect(within(row).getByRole("switch").getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(library.setEnabledByDefault).toHaveBeenCalledWith("bundled", true);
    fireEvent.click(within(row).getByRole("button", { name: "Export" }));
    await waitFor(() =>
      expect(download).toHaveBeenCalledWith(bytes, "Starter Content"),
    );
    expect(library.export).toHaveBeenCalledWith("bundled");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps user plugins on cancellation and deletes only after confirmation", async () => {
    library.remove.mockImplementation(async (guid: string) => {
      entries = entries.filter((item) => item.pluginGuid !== guid);
    });
    render(<EnginePluginsSettings />);
    const row = await screen.findByTestId("engine-plugin-row-custom");
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(library.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByTestId("engine-plugin-row-custom")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("engine-plugin-row-custom")).toBeNull(),
    );
    expect(library.remove).toHaveBeenCalledWith("custom");
    expect(screen.getByTestId("engine-plugin-row-bundled")).toBeTruthy();
  });

  it("keeps the previous default visible after a failed write and allows retry", async () => {
    library.setEnabledByDefault.mockRejectedValue(new Error("Storage is full"));
    render(<EnginePluginsSettings />);
    const row = await screen.findByTestId("engine-plugin-row-custom");
    fireEvent.click(within(row).getByRole("switch"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Storage is full",
    );
    expect(within(row).getByRole("switch").getAttribute("aria-checked")).toBe(
      "false",
    );
    fireEvent.click(within(row).getByRole("switch"));
    await waitFor(() => expect(library.setEnabledByDefault).toHaveBeenCalledTimes(2));
  });

  it("asks where a change applies while a project is open, copying a missing plugin in and naming references a disable breaks", async () => {
    project.open = true;
    const bytes = new Uint8Array([7]);
    library.export.mockResolvedValue(bytes);
    const imported = { ...entry("custom", false), source: "project" as const };
    project.importPlugin.mockResolvedValue({ status: "imported", descriptor: imported });
    render(<EnginePluginsSettings />);

    fireEvent.click(within(await screen.findByTestId("engine-plugin-row-custom")).getByRole("switch"));
    const enable = await screen.findByRole("alertdialog", { name: "Enable User Plugin" });
    expect(enable.textContent).toContain("It is not in Demo yet, so a project choice copies it in.");
    fireEvent.click(within(enable).getByRole("button", { name: "Project & Engine" }));
    await waitFor(() => expect(library.setEnabledByDefault).toHaveBeenCalledWith("custom", true));
    expect(library.export).toHaveBeenCalledWith("custom");
    expect(project.importPlugin).toHaveBeenCalledWith(bytes);
    expect(project.applyPluginOverrides).toHaveBeenCalledWith({ custom: { enabled: true } });
    expect(project.overrides).toEqual({ custom: { enabled: true } });

    project.plugins = [entry("bundled", true), imported];
    project.assets = [{ rootId: "plugin:bundled", header: { guid: "rock", name: "Rock" } }, { rootId: "project", header: { guid: "level", name: "Level" } }];
    project.inbound = { rock: ["level"] };
    library.setEnabledByDefault.mockClear();
    const bundledSwitch = within(screen.getByTestId("engine-plugin-row-bundled")).getByRole("switch");
    fireEvent.click(bundledSwitch);
    const enableBundled = await screen.findByRole("alertdialog", { name: "Enable Starter Content" });
    fireEvent.click(within(enableBundled).getByRole("button", { name: "Project Only" }));
    await waitFor(() => expect(project.overrides).toEqual({ custom: { enabled: true }, bundled: { enabled: true } }));
    expect(library.setEnabledByDefault).not.toHaveBeenCalled();

    fireEvent.click(bundledSwitch);
    await waitFor(() => expect(library.setEnabledByDefault).toHaveBeenCalledWith("bundled", true));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(bundledSwitch);
    const disable = await screen.findByRole("alertdialog", { name: "Disable Starter Content" });
    expect(disable.textContent).toContain("Other assets in Demo still reference it: Level.");
    fireEvent.click(within(disable).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(project.overrides.bundled).toEqual({ enabled: true });
    expect(library.setEnabledByDefault).toHaveBeenCalledTimes(1);
  });
});
