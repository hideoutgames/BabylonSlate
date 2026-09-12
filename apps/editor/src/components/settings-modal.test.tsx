import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsModal } from "./settings-modal";
import { createDefaultPluginSettings, type PluginDescriptor } from "@babylonslate/assets";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const {
  updateProjectVersion,
  updateProjectSettings,
  setShowPluginContent,
  sourceControl,
  host,
  exportGameArtifact,
  exportProject,
  importPlugin,
  sourceControlEnabled,
  lastProjectInput,
  pluginDescriptors,
  applyPluginOverrides,
} = vi.hoisted(() => {
  const lastProjectInput = { current: null as unknown };
  return {
    updateProjectVersion: vi.fn(),
    updateProjectSettings: vi.fn((patch: { input?: unknown }) => {
      if (patch?.input) lastProjectInput.current = patch.input;
    }),
    setShowPluginContent: vi.fn(),
    sourceControl: {
      hasToken: false,
      saveToken: vi.fn(async () => undefined),
      clearToken: vi.fn(async () => undefined),
      readGitPrefill: vi.fn(async () => ({ repositoryUrl: "", branch: "" })),
    },
    host: { platform: "electron", testMode: true },
    exportGameArtifact: vi.fn(),
    exportProject: vi.fn(),
    importPlugin: vi.fn(),
    sourceControlEnabled: { current: false },
    lastProjectInput,
    pluginDescriptors: [] as PluginDescriptor[],
    applyPluginOverrides: vi.fn(async () => undefined),
  };
});

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
      if (lastProjectInput.current) {
        projectDocument.settings.input =
          lastProjectInput.current as typeof projectDocument.settings.input;
      }
      if (sourceControlEnabled.current) {
        projectDocument.settings.sourceControl = {
          ...projectDocument.settings.sourceControl,
          enabled: true,
        };
      }
      return {
      projectDocument,
      exportProject,
      exportGameArtifact,
      zipExportedGame: vi.fn(),
      retryFailedTextureEncoding: vi.fn(),
      updateProjectSettings,
      updateProjectVersion,
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
          {
            header: { guid: "mixer-1", name: "Master", type: "AudioMixer" },
            path: "assets/Master.mixer.babasset",
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
      pluginDescriptors,
      pluginDiagnostics: [],
      showPluginContent: false,
      setShowPluginContent,
      applyPluginOverrides,
      createProjectPlugin: vi.fn(),
      deleteProjectPlugin: vi.fn(),
      exportPlugin: vi.fn(),
      importPlugin,
      openDocument: vi.fn(),
    };
    },
  };
});

afterEach(() => {
  cleanup();
  lastProjectInput.current = null;
  updateProjectSettings.mockClear();
  updateProjectVersion.mockClear();
  setShowPluginContent.mockClear();
  sourceControl.saveToken.mockClear();
  sourceControl.clearToken.mockClear();
  sourceControl.clearToken.mockImplementation(async () => undefined);
  sourceControl.hasToken = false;
  host.platform = "electron";
  host.testMode = true;
  exportGameArtifact.mockReset();
  exportProject.mockReset();
  importPlugin.mockReset();
  sourceControlEnabled.current = false;
  pluginDescriptors.length = 0;
  applyPluginOverrides.mockClear();
});

it("hides unrelated settings when search has no matching section", () => {
  render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
  fireEvent.change(screen.getByTestId("settings-modal-search"), {
    target: { value: "unmatched-setting" },
  });
  expect(screen.queryByTestId("settings-compile-on-save")).toBeNull();
  expect(screen.getByText("No Matching Settings")).toBeTruthy();
  fireEvent.change(screen.getByTestId("settings-modal-search"), {
    target: { value: "autosave" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Autosave Interval/ }));
  expect(screen.getByTestId("settings-autosave-interval")).toBeTruthy();
});

describe("SettingsModal project authoring", () => {
  it("edits the authored project version from General", () => {
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    const version = screen.getByRole("textbox", { name: "Project Version" });
    expect((version as HTMLInputElement).value).toBe("1.0.0");
    fireEvent.change(version, { target: { value: "2.4.0-beta.3" } });
    expect(updateProjectVersion).toHaveBeenCalledWith("2.4.0-beta.3");
  });

  it("explains a failed plugin import and re-enables importing", async () => {
    let reject!: (error: Error) => void;
    importPlugin.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-plugins"));
    const file = new File([new Uint8Array([1, 2])], "broken.babplugin");
    Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1, 2]).buffer });
    await act(async () => {
      fireEvent.change(screen.getByTestId("import-plugin-input"), { target: { files: [file] } });
    });
    expect(screen.getByTestId("settings-plugin-import").hasAttribute("disabled")).toBe(true);
    await act(async () => { reject(new Error("Invalid plugin archive")); });
    expect(await screen.findByText("Invalid plugin archive")).toBeTruthy();
    expect(screen.getByTestId("settings-plugin-import").hasAttribute("disabled")).toBe(false);
  });
  it("keeps a project export pending and shows a recoverable failure", async () => {
    let reject!: (error: Error) => void;
    exportProject.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-export"));
    fireEvent.click(screen.getByTestId("export-project"));
    expect(screen.getByTestId("export-project").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("export-project").textContent).toMatch(/Exporting/);
    await act(async () => { reject(new Error("Backup storage unavailable")); });
    expect(await screen.findByText("Backup storage unavailable")).toBeTruthy();
    expect(screen.getByTestId("export-project").hasAttribute("disabled")).toBe(false);
  });
  it("shows no matches instead of unrelated settings for an unknown query", () => {
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.change(screen.getByPlaceholderText("Search settings"), { target: { value: "no-such-setting" } });
    expect(screen.getByText("No Matching Settings")).toBeTruthy();
    expect(screen.queryByTestId("settings-startup-scene")).toBeNull();
  });

  it("finds a specific field and reveals it when its result is chosen", async () => {
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.change(screen.getByPlaceholderText("Search settings"), { target: { value: "reverb decay" } });
    fireEvent.click(screen.getByRole("button", { name: /Reverb Decay Scale/ }));
    const field = await screen.findByTestId("settings-audio-reverb-decay-scale");
    await waitFor(() => expect(document.activeElement).toBe(field));
  });
  it("keeps input authoring in assets rather than Project Settings", () => {
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    expect(screen.queryByTestId("settings-modal-category-input")).toBeNull();
    expect(screen.queryByTestId("settings-input-mapping")).toBeNull();
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

  it("picks the project AudioMixer from Audio Mixer assets", async () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-audio"));
    expect(screen.queryByTestId("settings-audio-mixer-guid")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-audio-mixer"));
    expect(await screen.findByTestId("search-item-mixer-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("search-item-mixer-1"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ audioMixerGuid: "mixer-1" }),
      }),
    );
  });

  it("toggles project Audio occlusion", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-audio"));
    fireEvent.click(screen.getByTestId("settings-audio-occlusion"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ occlusionEnabled: false }),
      }),
    );
  });

  it("edits Audio reverb wet, decay, and damping scales", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-audio"));
    expect(screen.getByTestId("settings-audio-reverb-wet-scale-slider")).toBeTruthy();
    fireEvent.change(screen.getByTestId("settings-audio-reverb-wet-scale"), {
      target: { value: "1.5" },
    });
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ reverbWetScale: 1.5 }),
      }),
    );
    fireEvent.change(screen.getByTestId("settings-audio-reverb-decay-scale"), {
      target: { value: "0.25" },
    });
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ reverbDecayScale: 0.25 }),
      }),
    );
    fireEvent.change(screen.getByTestId("settings-audio-reverb-damping-scale"), {
      target: { value: "2" },
    });
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ reverbDampingScale: 2 }),
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

  it("edits physics collision layers as a named list", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-physics"));
    fireEvent.change(screen.getByTestId("settings-collision-layers-0-value"), {
      target: { value: "Player" },
    });
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        physics: expect.objectContaining({
          collisionLayers: expect.arrayContaining(["Player"]),
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
    const gameInstance = await screen.findByTestId("search-item-GameInstance");
    const myGame = screen.getByTestId("search-item-MyGame");
    expect(gameInstance.textContent).toContain("Class");
    expect(myGame.textContent).toContain("Class");
    expect(myGame.title).toContain("Project");
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

  it("authors infinite loop detection on the General category", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-general"));
    expect(screen.getByTestId("settings-infinite-loop-detection")).toBeTruthy();
    expect(screen.getByTestId("settings-loop-count")).toBeTruthy();
    fireEvent.click(screen.getByTestId("settings-infinite-loop-detection"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({ infiniteLoopDetection: false }),
    );
  });

  it.each([
    ["general", "settings-infinite-loop-detection", /Stops runaway scripts/],
    ["twoD", "settings-pixel-perfect", /Keeps pixels sharp/],
    ["twoD", "settings-integer-zoom", /Applies to game cameras/],
    ["audio", "settings-audio-occlusion", /Wall muffling/],
    ["rendering", "setting-render-custom", /Sets the design size/],
    ["rendering", "setting-render-black-bars", /Adds bars to preserve/],
    ["rendering", "setting-play-follow-system", /Off uses a fixed aspect ratio/],
  ])("keeps the %s %s description inside its setting before the separator", (category, controlId, descriptionText) => {
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId(`settings-modal-category-${category}`));
    const control = screen.getByTestId(controlId);
    const description = screen.getByText(descriptionText);
    expect(control.closest('[data-slot="field"]')?.contains(description)).toBe(true);
    expect(control.getAttribute("aria-describedby")).toBe(description.id);
  });

  it("shows both maturity flags and the selected icon to the right of a plugin name", () => {
    pluginDescriptors.push({
      pluginGuid: "tools",
      source: "project",
      folderName: "tools",
      readOnly: false,
      folderPath: "plugins/tools",
      contentPath: "plugins/tools/assets",
      settingsPath: "plugins/tools/tools.plugin.babasset",
      settings: {
        ...createDefaultPluginSettings({ pluginGuid: "tools", displayName: "Tool Pack" }),
        iconKey: "Star",
        experimental: true,
        beta: true,
      },
    });
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-plugins"));
    const name = screen.getByText("Tool Pack");
    expect(name.nextElementSibling?.matches("svg.lucide-star")).toBe(true);
    expect(screen.getByText("Experimental")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    fireEvent.click(screen.getByTestId("settings-plugin-export-tools"));
    expect(screen.getByRole("button", { name: "Export To Download" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export To Engine Plugins" })).toBeTruthy();
  });

  it("identifies Beta when confirming enablement and enables only after confirmation", async () => {
    pluginDescriptors.push({
      pluginGuid: "tools",
      source: "project",
      folderName: "tools",
      readOnly: false,
      folderPath: "plugins/tools",
      contentPath: "plugins/tools/assets",
      settingsPath: "plugins/tools/tools.plugin.babasset",
      settings: {
        ...createDefaultPluginSettings({ pluginGuid: "tools", displayName: "Tool Pack" }),
        beta: true,
      },
    });
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-plugins"));
    fireEvent.click(screen.getByTestId("settings-plugin-enable-tools"));
    expect(screen.getByRole("heading", { name: "Enable Beta Plugin" })).toBeTruthy();
    expect(applyPluginOverrides).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(updateProjectSettings).toHaveBeenCalledWith({
      pluginOverrides: { tools: { enabled: true } },
    }));
    expect(applyPluginOverrides).toHaveBeenCalledWith({ tools: { enabled: true } });
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

  it("explains where to create a GitHub token", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    const help = screen.getByTestId("settings-source-control-token-help");
    expect(help.textContent).toMatch(/GitHub/);
    expect(help.textContent).toMatch(/repo/);
    expect(help.textContent).toMatch(/Contents/);
    const link = screen.getByRole("link", { name: "GitHub Token Settings" });
    expect(link.getAttribute("href")).toBe("https://github.com/settings/tokens");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toMatch(/noreferrer/);
  });

  it("notes that Save Token stores the secret for this project on this device", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    const copy = screen.getByTestId("settings-source-control-token-copy");
    expect(copy.textContent).toMatch(/on this device for this project/i);
    expect(copy.textContent).toMatch(/never included in project files or Git/i);
    expect(copy.textContent).not.toMatch(/This browser only/i);
    expect(copy.textContent).not.toMatch(/Not Saved/);
    expect(screen.queryByText("Not Saved")).toBeNull();
    sourceControl.hasToken = true;
    cleanup();
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    expect(screen.getByTestId("settings-source-control-token-copy").textContent).toMatch(
      /Token Saved/,
    );
    sourceControl.hasToken = false;
  });

  it("clears the stored token and the draft field", async () => {
    sourceControl.hasToken = true;
    sourceControl.clearToken.mockImplementation(async () => {
      sourceControl.hasToken = false;
    });
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    fireEvent.change(screen.getByTestId("settings-source-control-token"), {
      target: { value: "ghp_secret" },
    });
    expect(screen.getByTestId("settings-source-control-token-copy").textContent).toMatch(
      /Token Saved/,
    );
    fireEvent.click(screen.getByTestId("settings-source-control-clear-token"));
    expect(sourceControl.clearToken).toHaveBeenCalled();
    await waitFor(() => {
      expect(
        (screen.getByTestId("settings-source-control-token") as HTMLInputElement)
          .value,
      ).toBe("");
    });
    expect(screen.getByTestId("settings-source-control-token-copy").textContent).not.toMatch(
      /Token Saved/,
    );
  });

  it("keeps Close Project beside Done when browsing or searching settings", () => {
    const onOpenChange = vi.fn();
    const onCloseProject = vi.fn();
    render(
      <SettingsModal
        open
        onOpenChange={onOpenChange}
        scope="project"
        onCloseProject={onCloseProject}
      />,
    );
    const close = screen.getByRole("button", { name: "Close Project" });
    const done = screen.getByRole("button", { name: "Done" });
    expect(close.parentElement).toBe(done.parentElement);
    fireEvent.click(screen.getByTestId("settings-modal-category-twoD"));
    expect(screen.getByRole("button", { name: "Close Project" })).toBe(close);
    fireEvent.change(screen.getByPlaceholderText("Search settings"), {
      target: { value: "no-such-setting" },
    });
    expect(screen.getByText("No Matching Settings")).toBeTruthy();
    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCloseProject).toHaveBeenCalledOnce();
  });

  it("does not offer Close Project in Engine Settings", () => {
    render(
      <SettingsModal
        open
        onOpenChange={() => {}}
        scope="engine"
        onCloseProject={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Close Project" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
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
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      exportGameArtifact.mockRejectedValueOnce(new Error("zip failed"));
      render(
        <SettingsModal open onOpenChange={() => {}} scope="project" />,
      );
      fireEvent.click(screen.getByTestId("settings-modal-category-export"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("export-game"));
      });
      expect(screen.getByTestId("export-game-error").textContent).toBe(
        "Could not build the zip. Try again.",
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});
