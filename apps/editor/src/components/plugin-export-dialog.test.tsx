import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createDefaultPluginSettings,
  type PluginDescriptor,
} from "@babylonslate/assets";
import { PluginExportDialog } from "./plugin-export-dialog";

const { install, download } = vi.hoisted(() => ({
  install: vi.fn(),
  download: vi.fn(),
}));
vi.mock("../lib/engine-plugin-library", () => ({
  ensureEnginePluginLibrary: async () => ({ import: install }),
}));
vi.mock("../lib/plugin-download", () => ({ downloadPluginArchive: download }));

const plugin: PluginDescriptor = {
  pluginGuid: "plugin-a",
  folderName: "plugin-a",
  folderPath: "plugins/plugin-a",
  settingsPath: "plugins/plugin-a/plugin.plugin.babasset",
  contentPath: "plugins/plugin-a/assets",
  source: "project",
  readOnly: false,
  settings: createDefaultPluginSettings({
    pluginGuid: "plugin-a",
    displayName: "My Plugin",
  }),
};
const bytes = new Uint8Array([1, 2, 3]);
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("PluginExportDialog", () => {
  it("waits for a destination and downloads without installing when Download is chosen", async () => {
    const exportPlugin = vi.fn().mockResolvedValue(bytes);
    const onClose = vi.fn();
    render(
      <PluginExportDialog
        plugin={plugin}
        exportPlugin={exportPlugin}
        onClose={onClose}
      />,
    );
    expect(exportPlugin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export To Download" }));
    await waitFor(() =>
      expect(download).toHaveBeenCalledWith(bytes, "My Plugin"),
    );
    expect(exportPlugin).toHaveBeenCalledWith("plugin-a");
    expect(install).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("requires a separate Replace confirmation for an existing Engine Plugin", async () => {
    const existing = {
      ...plugin,
      pluginGuid: "existing-plugin",
      bundled: false,
      enabledByDefault: true,
    };
    install
      .mockResolvedValueOnce({ status: "conflict", existing })
      .mockResolvedValueOnce({ status: "imported", entry: existing });
    const onClose = vi.fn();
    render(
      <PluginExportDialog
        plugin={plugin}
        exportPlugin={async () => bytes}
        onClose={onClose}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Export To Engine Plugins" }),
    );
    await screen.findByRole("alertdialog");
    expect(install).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Replace" }),
    );
    await waitFor(() =>
      expect(install).toHaveBeenCalledWith(bytes, {
        replaceGuid: "existing-plugin",
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(download).not.toHaveBeenCalled();
  });

  it("leaves an existing entry untouched when replacement is cancelled", async () => {
    install.mockResolvedValue({
      status: "conflict",
      existing: { ...plugin, bundled: false, enabledByDefault: false },
    });
    const onClose = vi.fn();
    render(
      <PluginExportDialog
        plugin={plugin}
        exportPlugin={async () => bytes}
        onClose={onClose}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Export To Engine Plugins" }),
    );
    await screen.findByRole("alertdialog");
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(install).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a bundled-name error without a Replace prompt and keeps export retryable", async () => {
    install.mockRejectedValue(
      new Error("Bundled Engine Plugin names cannot be replaced."),
    );
    const onClose = vi.fn();
    render(
      <PluginExportDialog
        plugin={plugin}
        exportPlugin={async () => bytes}
        onClose={onClose}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Export To Engine Plugins" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Bundled Engine Plugin names cannot be replaced.",
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Export To Download" }),
    ).toHaveProperty("disabled", false);
  });
});
