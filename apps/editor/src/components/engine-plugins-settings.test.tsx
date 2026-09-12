import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createDefaultPluginSettings } from "@babylonslate/assets";
import { EnginePluginsSettings } from "./engine-plugins-settings";
import type { EnginePluginEntry } from "../lib/engine-plugin-library";

// Base UI forwards switch clicks using PointerEvent; jsdom lacks it.
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
}

const { library, download } = vi.hoisted(() => ({
  library: {
    list: vi.fn(),
    setEnabledByDefault: vi.fn(),
    remove: vi.fn(),
    export: vi.fn(),
  },
  download: vi.fn(),
}));
vi.mock("../lib/engine-plugin-library", () => ({
  ensureEnginePluginLibrary: async () => library,
}));
vi.mock("../lib/plugin-download", () => ({ downloadPluginArchive: download }));

function entry(guid: string, bundled: boolean): EnginePluginEntry {
  return {
    pluginGuid: guid,
    source: "engine",
    folderName: guid,
    folderPath: `engine-plugins/${guid}`,
    contentPath: `engine-plugins/${guid}/assets`,
    settingsPath: `engine-plugins/${guid}/plugin.plugin.babasset`,
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
        exact: true,
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
});
