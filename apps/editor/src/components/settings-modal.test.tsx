import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsModal } from "./settings-modal";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const {
  updateProjectSettings,
  setShowPluginContent,
  sourceControl,
  host,
  exportGameArtifact,
  sourceControlEnabled,
} = vi.hoisted(() => ({
  updateProjectSettings: vi.fn(),
  setShowPluginContent: vi.fn(),
  sourceControl: {
    hasToken: false,
    saveToken: vi.fn(async () => undefined),
    clearToken: vi.fn(async () => undefined),
    readGitPrefill: vi.fn(async () => ({ repositoryUrl: "", branch: "" })),
  },
  host: { platform: "electron", testMode: true },
  exportGameArtifact: vi.fn(),
  sourceControlEnabled: { current: false },
}));

vi.mock("@babylonslate/vfs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/vfs")>();
  return {
    ...actual,
    getHostPlatform: () => host.platform,
    isTestModeEnabled: () => host.testMode,
  };
});

vi.mock("../context/document-context", async () => {
  const { createEmptyProject: emptyProject } = await import("@babylonslate/core");
  return {
    useDocuments: () => {
      const projectDocument = emptyProject("Demo");
      if (sourceControlEnabled.current) {
        projectDocument.settings.sourceControl = {
          ...projectDocument.settings.sourceControl,
          enabled: true,
        };
      }
      return {
      projectDocument,
      exportProject: vi.fn(),
      exportGameArtifact,
      zipExportedGame: vi.fn(),
      retryFailedTextureEncoding: vi.fn(),
      updateProjectSettings,
      sourceControl,
      prefillSourceControlFromGit: sourceControl.readGitPrefill,
      assetRegistry: {
        list: () => [
          {
            header: { guid: "font-1", name: "Display", type: "Font" },
            path: "assets/Display.font.babasset",
          },
          {
            header: { guid: "scene-1", name: "Main", type: "Scene" },
            path: "assets/main.scene.babasset",
          },
          {
            header: { guid: "scene-2", name: "Arena", type: "Scene" },
            path: "assets/Arena.scene.babasset",
          },
          {
            header: {
              guid: "class-tools",
              name: "Tools",
              type: "Class",
              parentClass: "EditorUtilityObject",
            },
            path: "assets/Tools.class.babasset",
          },
          {
            header: {
              guid: "class-game",
              name: "MyGame",
              type: "Class",
              parentClass: "GameInstance",
            },
            path: "assets/MyGame.class.babasset",
          },
        ],
        getByGuid: (guid: string) =>
          guid === "font-1"
            ? {
                header: { guid: "font-1", name: "Display", type: "Font" },
                path: "assets/Display.font.babasset",
              }
            : undefined,
      },
      openDocuments: [],
      pluginDescriptors: [],
      pluginDiagnostics: [],
      showPluginContent: false,
      setShowPluginContent,
      applyPluginOverrides: vi.fn(),
      createProjectPlugin: vi.fn(),
      deleteProjectPlugin: vi.fn(),
      exportPlugin: vi.fn(),
      importPlugin: vi.fn(),
      openDocument: vi.fn(),
    };
    },
  };
});

afterEach(() => {
  cleanup();
  updateProjectSettings.mockClear();
  setShowPluginContent.mockClear();
  sourceControl.saveToken.mockClear();
  sourceControl.clearToken.mockClear();
  sourceControl.hasToken = false;
  host.platform = "electron";
  host.testMode = true;
  exportGameArtifact.mockReset();
  sourceControlEnabled.current = false;
});

describe("SettingsModal project authoring", () => {
  it("edits input mappings with the structured editor instead of JSON", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-input"));
    expect(screen.getByTestId("settings-input-mapping")).toBeTruthy();
    expect(screen.queryByTestId("settings-input-actions")).toBeNull();
    expect(screen.getByTestId("input-action-0-name")).toBeTruthy();
    fireEvent.click(screen.getByTestId("input-action-add"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          actions: expect.arrayContaining([
            expect.objectContaining({ name: "New Action" }),
          ]),
        }),
      }),
    );
  });

  it("picks the default font from Font assets instead of a guid field", async () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-fonts"));
    expect(screen.queryByTestId("settings-default-font-guid")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-default-font"));
    expect(await screen.findByTestId("search-item-font-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("search-item-font-1"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        fonts: expect.objectContaining({ defaultFontGuid: "font-1" }),
      }),
    );
  });

  it("edits sorting layers as a named list", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-twoD"));
    fireEvent.change(screen.getByTestId("settings-sorting-layers-0-value"), {
      target: { value: "Far" },
    });
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        twoD: expect.objectContaining({
          sortingLayers: expect.arrayContaining(["Far"]),
        }),
      }),
    );
  });

  it("picks the packaged startup scene from Scene assets only", async () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-export"));
    fireEvent.click(screen.getByTestId("settings-startup-scene"));
    expect(await screen.findByTestId("search-item-scene-1")).toBeTruthy();
    expect(screen.queryByTestId("search-item-font-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-scene-2"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({ startupSceneGuid: "scene-2" }),
    );
  });

  it("picks Game Instance from a ClassPicker on the Export category", async () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-export"));
    fireEvent.click(screen.getByTestId("settings-game-instance"));
    expect(await screen.findByTestId("search-item-GameInstance")).toBeTruthy();
    expect(screen.getByTestId("search-item-MyGame")).toBeTruthy();
    expect(screen.queryByTestId("search-item-Tools")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-MyGame"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({ gameInstanceClass: "MyGame" }),
    );
  });

  it("authors Export Game preset fields separately from Export Project", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-export"));
    expect(screen.getByTestId("export-game")).toBeTruthy();
    expect(screen.getByTestId("export-project")).toBeTruthy();
    expect(screen.getByTestId("setting-export-packed")).toBeTruthy();
    expect(screen.getByTestId("setting-export-debugger")).toBeTruthy();
    fireEvent.click(screen.getByTestId("setting-export-debugger"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        exportPresets: [
          expect.objectContaining({ bundleDebugger: true, packed: true }),
        ],
      }),
    );
  });

  it("authors custom render resolution on the Rendering category", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    expect(screen.getByTestId("setting-render-custom")).toBeTruthy();
    expect(screen.getByTestId("setting-render-width")).toBeTruthy();
    expect(screen.getByTestId("setting-render-height")).toBeTruthy();
    expect(screen.getByTestId("setting-render-black-bars")).toBeTruthy();
  });

  it("registers EditorUtilityObject classes from a ClassPicker list", async () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-general"));
    fireEvent.click(screen.getByTestId("settings-editor-utility-objects-add"));
    expect(await screen.findByTestId("search-item-Tools")).toBeTruthy();
    expect(screen.queryByTestId("search-item-Hero")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-Tools"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        editorUtilityObjects: ["Tools"],
      }),
    );
  });

  it("opens a Plugins category for enablement and New Plugin", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-plugins"));
    expect(screen.getByTestId("settings-plugins-panel")).toBeTruthy();
    expect(screen.getByTestId("settings-plugin-new")).toBeTruthy();
    expect(screen.getByTestId("settings-plugin-import")).toBeTruthy();
    expect(screen.getByTestId("import-plugin-input")).toBeTruthy();
    expect(screen.getByTestId("settings-show-plugin-content")).toBeTruthy();
  });

  it("toggles Show Plugin Content from the Plugins category", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-plugins"));
    fireEvent.click(screen.getByTestId("settings-show-plugin-content"));
    expect(setShowPluginContent).toHaveBeenCalledWith(true);
  });

  it("hides Source Control on production web", () => {
    host.platform = "web";
    host.testMode = false;
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    expect(screen.queryByTestId("settings-modal-category-sourceControl")).toBeNull();
  });

  it("saves the token through the secret store, not project.json", async () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    fireEvent.change(screen.getByTestId("settings-source-control-token"), {
      target: { value: "ghp_secret" },
    });
    fireEvent.click(screen.getByTestId("settings-source-control-save-token"));
    expect(sourceControl.saveToken).toHaveBeenCalledWith("ghp_secret");
    expect(updateProjectSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sourceControl: expect.objectContaining({ token: "ghp_secret" }),
      }),
    );
  });

  it("shows Title Case token status without revealing the secret", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    const copy = screen.getByTestId("settings-source-control-token-copy");
    expect(copy.textContent).toMatch(/Not written to the project/i);
    expect(copy.textContent).toMatch(/This browser only/i);
    expect(copy.textContent).not.toMatch(/Not Saved/);
    expect(screen.queryByText("Not Saved")).toBeNull();
    sourceControl.hasToken = true;
    cleanup();
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    expect(screen.getByText(/Token Saved/)).toBeTruthy();
    sourceControl.hasToken = false;
  });

  it("labels the Session category Done instead of Close", () => {
    render(
      <SettingsModal
        open
        onOpenChange={() => {}}
        scope="project"
        onCloseProject={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-project"));
    expect(screen.getByTestId("settings-modal-category-project").textContent).toBe(
      "Done",
    );
    expect(screen.getByTestId("close-project").textContent).toMatch(/Close Project/);
  });

  it("confirms before turning Source Control Enable off", () => {
    sourceControlEnabled.current = true;
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    fireEvent.click(screen.getByTestId("settings-source-control-enabled"));
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId("settings-source-control-disable-confirm")).toBeTruthy();
  });

  it("surfaces a thrown Export Game failure", async () => {
    exportGameArtifact.mockRejectedValueOnce(new Error("zip failed"));
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-export"));
    fireEvent.click(screen.getByTestId("export-game"));
    expect(await screen.findByTestId("export-game-error")).toBeTruthy();
    expect(screen.getByTestId("export-game-error").textContent).toMatch(
      /zip failed/,
    );
  });
});
