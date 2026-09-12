import { useState } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  createDefaultPluginSettings,
  normalizePluginSettings,
  type PluginDescriptor,
  type PluginSettingsPayload,
} from "@babylonslate/assets";
import { PluginSettingsDetailsPanel } from "./plugin-settings-details-panel";

const harness = vi.hoisted(() => ({
  content: {} as PluginSettingsPayload,
  plugins: [] as PluginDescriptor[],
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "plugin-settings:pack" }),
}));
vi.mock("../context/document-context", () => ({
  useDocuments: () => {
    const [content, setContent] = useState(harness.content);
    return {
      openDocuments: [
        {
          id: "plugin-settings:pack",
          ref: { path: "plugins/pack/pack.plugin.babasset", label: "Pack" },
          content,
        },
      ],
      pluginDescriptors: harness.plugins,
      assetRegistry: null,
      applyAssetDocumentChange: async (
        _id: string,
        value: PluginSettingsPayload,
      ) => {
        harness.content = normalizePluginSettings(value, {
          pluginGuid: "pack",
        });
        setContent(harness.content);
        return true;
      },
    };
  },
}));

function plugin(guid: string, displayName: string): PluginDescriptor {
  return {
    pluginGuid: guid,
    folderName: guid,
    folderPath: `plugins/${guid}`,
    settingsPath: `plugins/${guid}/${guid}.plugin.babasset`,
    contentPath: `plugins/${guid}/assets`,
    source: "project",
    readOnly: false,
    settings: createDefaultPluginSettings({ pluginGuid: guid, displayName }),
  };
}

beforeEach(() => {
  harness.plugins = [plugin("pack", "Pack"), plugin("base", "Base Tools")];
  harness.plugins[1]!.settings.version = "2.3.0";
  harness.content = harness.plugins[0]!.settings;
});
afterEach(cleanup);

describe("Plugin Settings Details", () => {
  it("adds a selected plugin dependency that survives normalization, excludes self and duplicates, and removes it", async () => {
    render(<PluginSettingsDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Dependency" }));
    expect(screen.queryByTestId("search-item-pack")).toBeNull();
    fireEvent.click(await screen.findByTestId("search-item-base"));

    await waitFor(() =>
      expect(screen.getByDisplayValue("Base Tools")).toBeTruthy(),
    );
    expect(harness.content.pluginDependencies).toEqual([
      { guid: "base", versionRange: "^2.3.0" },
    ]);
    fireEvent.change(screen.getByLabelText("Version Range"), {
      target: { value: ">=2.3.0 <3.0.0" },
    });
    expect(harness.content.pluginDependencies[0]!.versionRange).toBe(
      ">=2.3.0 <3.0.0",
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Dependency" }));
    expect(await screen.findByText("No Other Plugins Available")).toBeTruthy();
    expect(screen.queryByTestId("search-item-base")).toBeNull();
    fireEvent.keyDown(
      screen.getByTestId("plugin-settings-dependency-menu-query"),
      { key: "Escape" },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Base Tools Dependency" }),
    );
    expect(harness.content.pluginDependencies).toEqual([]);
    expect(screen.queryByDisplayValue("Base Tools")).toBeNull();
  });

  it("previews and selects an icon while preserving the read-only imported engine range", async () => {
    harness.content.engineVersionRange = ">=0.0.0 <2.0.0";
    render(<PluginSettingsDetailsPanel {...({} as IDockviewPanelProps)} />);
    const engineRange = screen.getByLabelText(
      "Engine Version Range",
    ) as HTMLInputElement;
    expect(engineRange.readOnly).toBe(true);
    expect(engineRange.value).toBe(">=0.0.0 <2.0.0");

    fireEvent.click(screen.getByTestId("plugin-settings-icon"));
    const choice = await screen.findByTestId("search-item-Camera");
    expect(choice.querySelector("svg")).toBeTruthy();
    fireEvent.click(choice);
    expect(harness.content.iconKey).toBe("Camera");
    expect(harness.content.engineVersionRange).toBe(">=0.0.0 <2.0.0");
    expect(screen.getByTestId("plugin-settings-icon").textContent).toBe(
      "Camera",
    );

    fireEvent.click(screen.getByTestId("plugin-settings-icon"));
    fireEvent.click(await screen.findByTestId("search-item-default"));
    expect(harness.content.iconKey).toBeNull();
  });

  it("retains missing dependencies for removal and disables changes for engine plugins", () => {
    harness.content.pluginDependencies = [
      { guid: "missing", versionRange: "^1.0.0" },
    ];
    harness.plugins[0]!.source = "engine";
    render(<PluginSettingsDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByDisplayValue("missing")).toBeTruthy();
    expect(screen.getByText("Missing Plugin")).toBeTruthy();
    expect(
      (screen.getByTestId("plugin-settings-icon") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Add Dependency",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Remove missing Dependency",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
