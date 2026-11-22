import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsModal } from "./settings-modal";
import { createDefaultPluginSettings, createExtensionSettings, normalizeExtensionContributions, type ExtensionDescriptor, type PluginDescriptor } from "@haptic/assets";
import { createEmptyProject, defaultExportPreset } from "@haptic/core";
import { createAppSettingsStore } from "@haptic/vfs";
import { receiveActiveAppSettingsUpdate } from "../context/app-settings-context";
import { ENGINE_CATEGORIES, PROJECT_CATEGORIES } from "../lib/settings-catalog";
import { ENGINE_SETTING_FIELDS, PROJECT_SETTING_FIELDS } from "../lib/settings-search";
import { FakeGitHost, MemorySecrets } from "@haptic/source-control/fake-host";
import { SourceControlAccounts } from "../services/source-control-accounts";
import { TEST_GITHUB_CREDENTIAL } from "../testing/source-control-hosts";
import { deviceIntegratedSync, INTEGRATED_REPOSITORY } from "../testing/integrated-sync";

beforeEach(() => {
  const host = new FakeGitHost();
  accounts.current = new SourceControlAccounts(new MemorySecrets(), host.http, { fakeHost: host });
});

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
  accounts,
  projectSourceControl,
  projectExportPresets,
  lastProjectRender,
  pluginDescriptors,
  applyPluginOverrides,
  projectTwoD,
  projectGeneral,
  extensionState,
} = vi.hoisted(() => {
  const lastProjectRender = { current: null as import("@haptic/core").RenderProjectSettings | null };
  return {
    updateProjectVersion: vi.fn(),
    updateProjectSettings: vi.fn((patch: { render?: import("@haptic/core").RenderProjectSettings }) => {
      if (patch?.render) lastProjectRender.current = patch.render;
    }),
    setShowPluginContent: vi.fn(),
    sourceControl: {
      readGitPrefill: vi.fn(async () => ({ repositoryUrl: "", branch: "" })),
      folder: { current: { tier: null, hasGit: false } as { tier: import("@haptic/core").StorageTier | null; hasGit: boolean } },
      setAdoption: vi.fn<(adopted: boolean) => Promise<void>>(async () => {}),
      /** The Integrated sync the editor would run; idle unless a test configures one. */
      sync: { current: null as import("../services/source-control-sync").SourceControlSyncService | null },
    },
    host: { platform: "electron", testMode: true },
    exportGameArtifact: vi.fn(),
    exportProject: vi.fn(),
    importPlugin: vi.fn(),
    sourceControlEnabled: { current: false },
    accounts: { current: null as import("../services/source-control-accounts").SourceControlAccounts | null },
    projectSourceControl: { current: null as Partial<import("@haptic/core").SourceControlProjectSettings> | null },
    projectExportPresets: { current: null as import("@haptic/core").ExportPreset[] | null },
    lastProjectRender,
    pluginDescriptors: [] as PluginDescriptor[],
    applyPluginOverrides: vi.fn(async () => undefined),
    projectTwoD: { current: null as Partial<import("@haptic/core").TwoDProjectSettings> | null },
    projectGeneral: { current: null as Partial<import("@haptic/core").ProjectSettings> | null },
    extensionState: {
      entries: [] as import("@haptic/assets").ExtensionDescriptor[],
      overrides: {} as Record<string, { enabled: boolean }>,
      values: {} as Record<string, Record<string, string | number | boolean>>,
    },
  };
});

vi.mock("@haptic/vfs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@haptic/vfs")>();
  return {
    ...actual,
    getHostPlatform: () => host.platform,
    isTestModeEnabled: () => host.testMode,
  };
});

// The device's credentials on in-memory secrets, against the fake GitHub and GitLab host.
vi.mock("../services/source-control-accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/source-control-accounts")>();
  return { ...actual, sourceControlAccounts: async () => accounts.current! };
});

vi.mock("../context/document-context", async () => {
  const { createEmptyProject: emptyProject } = await import("@haptic/core");
  return (await import("../testing/document-context-mock")).documentContextMock(() => {
    const projectDocument = emptyProject("Demo");
    if (lastProjectRender.current) projectDocument.settings.render = lastProjectRender.current;
    if (sourceControlEnabled.current) {
      projectDocument.settings.sourceControl = {
        ...projectDocument.settings.sourceControl,
        mode: "manual",
      };
    }
    if (projectSourceControl.current) {
      projectDocument.settings.sourceControl = {
        ...projectDocument.settings.sourceControl,
        ...projectSourceControl.current,
      };
    }
    if (projectExportPresets.current) {
      projectDocument.settings.exportPresets = projectExportPresets.current;
    }
    if (projectTwoD.current) projectDocument.settings.twoD = { ...projectDocument.settings.twoD, ...projectTwoD.current };
    if (projectGeneral.current) Object.assign(projectDocument.settings, projectGeneral.current);
    projectDocument.settings.extensionOverrides = extensionState.overrides;
    projectDocument.settings.extensionSettings = extensionState.values;
    const snapshot = { entries: extensionState.entries, commands: [], assetTypes: [], diagnostics: [], trusted: true, untrusted: [] };
    return {
    projectDocument,
    extensionService: {
      subscribe: () => () => {}, getSnapshot: () => snapshot,
      projectTrustKey: (guid: string) => guid, createdHere: () => false, forgetCreatedProject: () => {},
    } as never,
    projectGuid: "test-project",
    activeDocumentId: "active-scene",
    exportProject,
    exportGameArtifact,
    zipExportedGame: vi.fn(),
    retryFailedTextureEncoding: vi.fn(),
    // Context providers may recreate callbacks during unrelated updates.
    updateProjectSettings: (...args: Parameters<typeof updateProjectSettings>) => updateProjectSettings(...args),
    updateProjectVersion,
    sourceControl,
    prefillSourceControlFromGit: sourceControl.readGitPrefill,
    readSourceControlFolder: async () => sourceControl.folder.current,
    setSourceControlAdoption: (adopted: boolean) => sourceControl.setAdoption(adopted),
    ...(sourceControl.sync.current ? { sourceControlSync: sourceControl.sync.current } : {}),
    assetRegistry: {
      list: () => [
        {
          header: { guid: "font-1", name: "Display", type: "Font" },
          path: "assets/Display.font.hasset",
        },
        {
          header: { guid: "scene-1", name: "Main", type: "Scene" },
          path: "assets/main.scene.hasset",
        },
        {
          header: { guid: "scene-2", name: "Arena", type: "Scene" },
          path: "assets/Arena.scene.hasset",
        },
        {
          header: {
            guid: "class-tools",
            name: "Tools",
            type: "Class",
            parentClass: "EditorUtilityObject",
          },
          path: "assets/Tools.class.hasset",
        },
        {
          header: {
            guid: "class-game",
            name: "MyGame",
            type: "Class",
            parentClass: "GameInstance",
          },
          path: "assets/MyGame.class.hasset",
        },
        {
          header: { guid: "mixer-1", name: "Master", type: "AudioMixer" },
          path: "assets/Master.mixer.hasset",
        },
      ],
      listRoots: () => [{ id: "project" }],
      folderTree: () => ({
        name: "assets",
        path: "assets",
        assets: [],
        children: [{ name: "Weapons", path: "assets/Weapons", assets: [], children: [] }],
      }),
      getByGuid: (guid: string) =>
        guid === "font-1"
          ? {
              header: { guid: "font-1", name: "Display", type: "Font" },
              path: "assets/Display.font.hasset",
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
  });
});

const RENDERING_SECTIONS = ["pipeline", "scalability", "shadows", "environment", "postProcessing", "sceneLayerPostProcessing", "cel", "resolution", "water", "playPreview"];

/** Collapses every Rendering sub-category except `open`, so jsdom renders only what a test uses. */
function showRenderingSections(...open: string[]) {
  receiveActiveAppSettingsUpdate({
    collapsedSettingsSections: RENDERING_SECTIONS.filter((id) => !open.includes(id)).map((id) => `project:rendering:${id}`),
  });
}

afterEach(async () => {
  cleanup();
  // Collapsed sub-categories are remembered on this device; start each test with all open.
  await createAppSettingsStore().update((settings) => { settings.collapsedSettingsSections = []; });
  receiveActiveAppSettingsUpdate({ collapsedSettingsSections: [] });
  lastProjectRender.current = null;
  projectTwoD.current = null;
  updateProjectSettings.mockClear();
  updateProjectVersion.mockClear();
  setShowPluginContent.mockClear();
  sourceControl.readGitPrefill.mockClear();
  sourceControl.folder.current = { tier: null, hasGit: false };
  sourceControl.setAdoption.mockReset();
  sourceControl.setAdoption.mockImplementation(async () => {});
  sourceControl.sync.current?.dispose();
  sourceControl.sync.current = null;
  host.platform = "electron";
  host.testMode = true;
  exportGameArtifact.mockReset();
  exportProject.mockReset();
  importPlugin.mockReset();
  sourceControlEnabled.current = false;
  projectSourceControl.current = null;
  projectExportPresets.current = null;
  pluginDescriptors.length = 0;
  applyPluginOverrides.mockClear();
  extensionState.entries = [];
  extensionState.overrides = {};
  extensionState.values = {};
});

function discordExtension(enabledByDefault: boolean): ExtensionDescriptor {
  return {
    extensionGuid: "discord", folderName: "discord", folderPath: "extensions/discord", settingsPath: "extensions/discord/extension.json",
    contentPath: "extensions/discord/assets", source: "project", readOnly: false,
    settings: {
      ...createExtensionSettings("Discord Presence", "discord"), enabledByDefault,
      contributes: normalizeExtensionContributions({ settings: { title: "Discord", sections: [{ id: "app", title: "Application", fields: [
        { id: "applicationId", label: "Application ID", type: "text" },
        { id: "showElapsed", label: "Show Elapsed Time", type: "toggle", default: true },
      ] }] } }),
    },
  };
}

describe("extension settings categories", () => {
  it("adds an enabled extension's category under the title it writes, in Miscellaneous, and saves its fields in the project", async () => {
    extensionState.entries = [discordExtension(false)];
    extensionState.overrides = { discord: { enabled: true } };
    extensionState.values = { discord: { applicationId: "123" } };
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);

    const sidebar = screen.getByTestId("settings-modal-categories");
    expect([...sidebar.querySelectorAll("p")].map((label) => label.textContent))
      .toEqual(["Project", "Gameplay", "Graphics & Audio", "Miscellaneous", "Plugins & Extensions"]);
    expect(within(within(sidebar).getByText("Miscellaneous").parentElement!).getByTestId("settings-modal-category-extension:discord")).toBeTruthy();

    fireEvent.click(screen.getByTestId("settings-modal-category-extension:discord"));

    expect(screen.getByTestId("settings-modal-category-extension:discord").textContent).toContain("Discord");
    const applicationId = screen.getByTestId("property-ext-discord-applicationId") as HTMLInputElement;
    expect(applicationId.value).toBe("123");
    fireEvent.change(applicationId, { target: { value: "456" } });
    expect(updateProjectSettings).toHaveBeenLastCalledWith({ extensionSettings: { discord: { applicationId: "456" } } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show Elapsed Time" }));
    expect(updateProjectSettings).toHaveBeenLastCalledWith({ extensionSettings: { discord: { applicationId: "123", showElapsed: false } } });
  });

  it("finds an extension's field in search and focuses it", async () => {
    extensionState.entries = [discordExtension(true)];
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);

    fireEvent.change(screen.getByPlaceholderText("Search settings"), { target: { value: "application id" } });
    fireEvent.click(screen.getByRole("button", { name: /Application ID/ }));

    const field = await screen.findByTestId("property-ext-discord-applicationId");
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it("leaves a disabled extension's category out of Project Settings and never adds one to Engine Settings", () => {
    extensionState.entries = [discordExtension(true)];
    extensionState.overrides = { discord: { enabled: false } };
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    expect(screen.queryByTestId("settings-modal-category-extension:discord")).toBeNull();
    // An empty Miscellaneous group is hidden.
    expect(within(screen.getByTestId("settings-modal-categories")).queryByText("Miscellaneous")).toBeNull();
    cleanup();

    extensionState.overrides = {};
    render(<SettingsModal open onOpenChange={() => {}} scope="engine" />);
    expect(screen.getByTestId("engine-settings-modal-category-undo")).toBeTruthy();
    expect(screen.queryByTestId("engine-settings-modal-category-extension:discord")).toBeNull();
  });
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

it.each([true, false])("offers the Auto-Save switch, with its interval usable only while it is on (on: %s)", (autoSave) => {
  projectGeneral.current = { autoSave };
  try {
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    const toggle = screen.getByRole("switch", { name: "Auto-Save" });
    expect(toggle.getAttribute("aria-checked")).toBe(String(autoSave));
    expect((screen.getByTestId("settings-autosave-interval") as HTMLInputElement).disabled).toBe(!autoSave);
    fireEvent.click(toggle);
    expect(updateProjectSettings).toHaveBeenLastCalledWith({ autoSave: !autoSave });
  } finally {
    projectGeneral.current = null;
  }
});

it("finds the Garbage Collection Interval and saves a whole number of ticks", () => {
  render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
  fireEvent.change(screen.getByTestId("settings-modal-search"), { target: { value: "garbage" } });
  fireEvent.click(screen.getByRole("button", { name: /Garbage Collection Interval/ }));
  const field = screen.getByTestId("settings-garbage-collection-interval") as HTMLInputElement;
  expect(field.value).toBe("60");
  fireEvent.change(field, { target: { value: "120" } });
  fireEvent.blur(field);
  expect(updateProjectSettings).toHaveBeenLastCalledWith({ garbageCollectionIntervalTicks: 120 });
});

it("finds the trace budget and persists MiB edits as bytes", async () => {
  const store = createAppSettingsStore();
  const previous = await store.load();
  await store.update((settings) => { settings.traceByteBudget = 201_326_592; });
  const onEngineSaved = vi.fn();
  const view = render(
    <SettingsModal open onOpenChange={() => {}} scope="engine" onEngineSaved={onEngineSaved} />,
  );
  try {
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), {
      target: { value: "trace memory" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Trace Memory Budget/ }));
    const field = screen.getByLabelText("Trace Memory Budget (MiB)");
    await waitFor(() => expect(field).toHaveProperty("value", "192"));
    fireEvent.change(field, { target: { value: "64" } });
    await waitFor(() => expect(onEngineSaved).toHaveBeenCalled());
    fireEvent.blur(field);
    expect((await createAppSettingsStore().load()).traceByteBudget).toBe(67_108_864);
    await waitFor(() => expect(field).toHaveProperty("value", "64"));
    onEngineSaved.mockClear();
    fireEvent.change(field, { target: { value: "2048" } });
    expect(onEngineSaved).not.toHaveBeenCalled();
    fireEvent.blur(field);
    await waitFor(() => expect(onEngineSaved).toHaveBeenCalled());
    expect((await createAppSettingsStore().load()).traceByteBudget).toBe(268_435_456);
  } finally {
    view.unmount();
    await store.save(previous);
  }
});

it("finds and persists the local Keep Simulation Changes preference without changing profiling or Trace", async () => {
  const store = createAppSettingsStore();
  const previous = await store.load();
  await store.update(settings => { settings.debuggerDefaults.keepSimulationChanges = false; });
  const view = render(<SettingsModal open onOpenChange={() => {}} scope="engine" />);
  try {
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), { target: { value: "keep simulation" } });
    fireEvent.click(screen.getByRole("button", { name: /Keep Simulation Changes/ }));
    const toggle = await screen.findByRole("switch", { name: "Keep Simulation Changes" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(toggle);
    await waitFor(async () => expect((await store.load()).debuggerDefaults.keepSimulationChanges).toBe(true));
    const saved = await store.load();
    expect(saved.traceByteBudget).toBe(previous.traceByteBudget);
    expect(saved.debuggerDefaults.profileDurationSeconds).toBe(previous.debuggerDefaults.profileDurationSeconds);
    expect(saved.debuggerDefaults.profileByteBudget).toBe(previous.debuggerDefaults.profileByteBudget);
  } finally {
    view.unmount();
    await store.save(previous);
  }
});

it("reveals the advanced profile budget through search without changing Trace", async () => {
  const store = createAppSettingsStore();
  const previous = await store.load();
  const view = render(<SettingsModal open onOpenChange={() => {}} scope="engine" />);
  try {
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), { target: { value: "profile retained" } });
    fireEvent.click(screen.getByRole("button", { name: /Profile Retained Data Budget/ }));
    const input = await screen.findByLabelText("Profile Retained Data Budget (MiB)");
    fireEvent.change(input, { target: { value: "24" } });
    fireEvent.blur(input);
    await waitFor(async () => expect((await store.load()).debuggerDefaults.profileByteBudget).toBe(24 * 1024 * 1024));
    expect((await store.load()).traceByteBudget).toBe(previous.traceByteBudget);
  } finally {
    view.unmount();
    await store.save(previous);
  }
});

describe("SettingsModal sub-categories", () => {
  it("remembers a collapsed sub-category on this device and expands all on request", async () => {
    const first = render(<SettingsModal open onOpenChange={() => {}} scope="project" initialCategoryId="rendering" />);
    fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
    expect(screen.queryByTestId("setting-render-mode")).toBeNull();
    await waitFor(async () =>
      expect((await createAppSettingsStore().load()).collapsedSettingsSections).toEqual(["project:rendering:pipeline"]),
    );
    first.unmount();

    render(<SettingsModal open onOpenChange={() => {}} scope="project" initialCategoryId="rendering" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pipeline" }).getAttribute("aria-expanded")).toBe("false"),
    );
    // The same id in another category or the other dialog stays open.
    expect(screen.getByRole("button", { name: "Scalability" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Expand All" }));
    expect(screen.getByTestId("setting-render-mode")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse All" })).toBeTruthy();
    await waitFor(async () =>
      expect((await createAppSettingsStore().load()).collapsedSettingsSections).toEqual([]),
    );
  }, 30_000);

  it("names the sub-category beside each search result", () => {
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.change(screen.getByPlaceholderText("Search settings"), { target: { value: "shadow distance" } });
    const result = screen.getByRole("button", { name: /Shadow Distance/ });
    expect(result.textContent).toContain("Rendering › Shadows");
  });

  it.each([
    ["project", PROJECT_CATEGORIES.map((category) => category.id), PROJECT_SETTING_FIELDS],
    ["engine", ENGINE_CATEGORIES.map((category) => category.id), ENGINE_SETTING_FIELDS],
  ] as const)("keeps every %s search result's control inside the sub-category it opens", async (scope, categoryIds, fields) => {
    // CEL Shading renders only in CEL mode.
    lastProjectRender.current = { ...createEmptyProject("Demo").settings.render, mode: "cel" };
    for (const categoryId of categoryIds) {
      const view = render(<SettingsModal open onOpenChange={() => {}} scope={scope} initialCategoryId={categoryId} />);
      for (const field of fields.filter((entry) => entry.categoryId === categoryId && entry.sectionId)) {
        // Some pages (Engine Settings → Source Control) load on first open.
        const section = await screen.findByTestId(`settings-section-${field.sectionId}`).catch(() => null);
        expect(section, `${categoryId} › ${field.sectionId} for ${field.label}`).not.toBeNull();
        // The section's group is named by its header.
        expect(document.getElementById(section?.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(field.sectionTitle);
        const control = field.targetId ? document.getElementById(field.targetId) : null;
        // Controls that show only in some states (Bloom Weight needs Bloom) are absent here.
        if (control) expect(section?.contains(control), `${field.targetId} in ${field.sectionId}`).toBe(true);
      }
      view.unmount();
    }
  }, 60_000);
});

describe("SettingsModal project authoring", () => {
  it("explains a failed plugin import and re-enables importing", async () => {
    let reject!: (error: Error) => void;
    importPlugin.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-plugins"));
    const file = new File([new Uint8Array([1, 2])], "broken.hplugin");
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
  it("reopens a collapsed sub-category when search reveals its control", async () => {
    showRenderingSections("environment");
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    const section = screen.getByRole("button", { name: "Environment Lighting" });
    expect(section.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(section);
    expect(screen.queryByLabelText("Environment Rotation")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search settings"), { target: { value: "environment rotation" } });
    fireEvent.click(screen.getByRole("button", { name: /Environment Rotation/ }));
    const field = await screen.findByLabelText("Environment Rotation");
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(screen.getByRole("button", { name: "Environment Lighting" }).getAttribute("aria-expanded")).toBe("true");
  });
  it.each([
    ["render width", /Render Width/, "Resolution", "setting-render-width"],
    ["play frame cap", /Play Frame Cap/, "Play Preview", "setting-play-frame-cap"],
    ["water blend", /Water Blend Distance/, "Water", "setting-water-blend-distance"],
    ["shadow distance", /Shadow Distance/, "Shadows", "project-shadow-distance"],
    ["texture anisotropy", /Texture Anisotropy/, "Scalability", "quality-textures-anisotropy"],
    ["reflections", /Real-Time Reflections/, "Post Processing", "project-effects-reflections"],
    ["fft size", /Water FFT Size/, "Scalability", "quality-water-fft-size"],
    ["allow reflections", /Allow Reflections/, "Scalability", "quality-postprocessing-reflections"],
    ["msaa", /Anti-Aliasing/, "Scalability", "quality-postprocessing-antialiasing"],
    ["ssao", /Ambient Occlusion/, "Post Processing", "project-effects-ambient-occlusion"],
    ["lut", /Color Grading/, "Post Processing", "project-effects-color-grading"],
    ["upscaling", /FSR Upscaling/, "Post Processing", "project-effects-upscaling"],
    ["volumetric lighting", /Volumetric Fog/, "Post Processing", "project-effects-volumetric"],
    ["fog density", /Volumetric Fog/, "Post Processing", "project-effects-volumetric"],
  ])("opens the Rendering sub-category holding %s from search", async (query, result, section, targetId) => {
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    showRenderingSections();
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    expect(screen.getByRole("button", { name: section }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.change(screen.getByPlaceholderText("Search settings"), { target: { value: query } });
    fireEvent.click(screen.getByRole("button", { name: result }));
    // Base UI redirects focus from the checkbox id to the visible switch.
    const target = document.getElementById(targetId);
    const control = target?.matches('input[type="checkbox"]') ? screen.getByTestId(targetId) : target;
    await waitFor(() => expect(document.activeElement).toBe(control));
    expect(screen.getByRole("button", { name: section }).getAttribute("aria-expanded")).toBe("true");
  });
  it("stages the Water Blend Distance with the project's render settings, clamped, with 0 for off", () => {
    showRenderingSections("water");
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    const field = screen.getByLabelText("Water Blend Distance") as HTMLInputElement;
    expect(field.value).toBe("8");
    fireEvent.change(field, { target: { value: "500" } });
    fireEvent.blur(field);
    expect(field.value).toBe("64");
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.blur(field);
    expect(lastProjectRender.current).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(lastProjectRender.current?.water).toEqual({ blendDistance: 0 });
  });
  it("stages post processing settings until Done", () => {
    showRenderingSections("postProcessing");
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    expect(screen.getByTestId("project-render-effects")).toBeTruthy();
    expect(screen.queryByLabelText("Scene-Wide Fog Density")).toBeNull();
    fireEvent.change(screen.getByLabelText("Volumetric Steps"), { target: { value: "32" } });
    fireEvent.blur(screen.getByLabelText("Volumetric Steps"));
    expect(screen.queryByLabelText("Render Scale")).toBeNull();
    fireEvent.click(screen.getByTestId("project-effects-upscaling"));
    fireEvent.change(screen.getByLabelText("Render Scale"), { target: { value: "0.5" } });
    fireEvent.blur(screen.getByLabelText("Render Scale"));
    fireEvent.click(screen.getByTestId("project-effects-reflections"));
    expect(screen.queryByLabelText("Occlusion Radius")).toBeNull();
    fireEvent.click(screen.getByTestId("project-effects-ambient-occlusion"));
    fireEvent.change(screen.getByLabelText("Occlusion Radius"), { target: { value: "1.5" } });
    fireEvent.blur(screen.getByLabelText("Occlusion Radius"));
    expect(screen.queryByTestId("project-effects-lut")).toBeNull();
    fireEvent.click(screen.getByTestId("project-effects-color-grading"));
    expect(screen.getByTestId("project-effects-lut")).toBeTruthy();
    fireEvent.click(screen.getByTestId("project-effects-volumetric"));
    fireEvent.change(screen.getByLabelText("Scene-Wide Fog Density"), { target: { value: "0.0085" } });
    fireEvent.blur(screen.getByLabelText("Scene-Wide Fog Density"));
    fireEvent.click(screen.getByTestId("project-effects-volumetric"));
    expect(screen.queryByLabelText("Scene-Wide Fog Density")).toBeNull();
    expect(screen.getByLabelText("Volumetric Steps")).toHaveProperty("value", "32");
    expect(lastProjectRender.current).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(lastProjectRender.current).toMatchObject({ effects: { upscaling: { enabled: true, renderScale: 0.5, sharpness: 0.2 }, colorGrading: { enabled: true, lutTextureGuid: null }, ambientOcclusion: { enabled: true, radius: 1.5 }, reflections: { enabled: true }, volumetricLighting: { enabled: false, density: 0.0085, steps: 32 } } });
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

  it("edits sorting layers as a named list", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-game"));
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

  it("picks Neutral tone mapping when a project without tone mapping switches to Scene Linear", async () => {
    const render0 = createEmptyProject("Demo", { kind: "2d" }).settings.render;
    lastProjectRender.current = { ...render0, effects: { ...render0.effects!, toneMapping: "none" } };
    showRenderingSections("postProcessing");
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    fireEvent.click(screen.getByTestId("project-effects-pipeline"));
    const option = await screen.findByRole("option", { name: "Scene Linear" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    await waitFor(() => expect(screen.getByTestId("project-effects-tone-mapping").textContent).toContain("Neutral"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(lastProjectRender.current?.effects).toMatchObject({ colorPipeline: { mode: "sceneLinear" }, toneMapping: "neutral" });
  });

  it("offers Nearest Texture Filtering only with Pixel-Perfect Mode on", () => {
    const view = render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-game"));
    const control = () => screen.getByTestId("settings-nearest-textures");
    expect(control().hasAttribute("data-disabled")).toBe(true);
    expect(control().closest('[data-slot="field"]')?.getAttribute("data-disabled")).toBe("true");
    expect(screen.getByText("Needs Pixel-Perfect Mode.")).toBeTruthy();
    // Stored on, but inert without Pixel-Perfect Mode: it reads off.
    projectTwoD.current = { pixelPerfect: false, nearestTextures: true };
    view.rerender(<SettingsModal open onOpenChange={() => {}} scope="project" key="inert" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-game"));
    expect(control().getAttribute("aria-checked")).toBe("false");
    projectTwoD.current = { pixelPerfect: true, nearestTextures: false };
    view.rerender(<SettingsModal open onOpenChange={() => {}} scope="project" key="pixel-perfect" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-game"));
    expect(control().hasAttribute("data-disabled")).toBe(false);
    expect(screen.queryByText("Needs Pixel-Perfect Mode.")).toBeNull();
    fireEvent.click(control());
    expect(updateProjectSettings).toHaveBeenLastCalledWith({
      twoD: expect.objectContaining({ pixelPerfect: true, nearestTextures: true }),
    });
  });

  it("edits a Collision Preset's responses and adds one with a fresh id", () => {
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-physics"));
    const defaultPreset = { id: "default", name: "Default", layer: 1, mask: 0xffffffff, overlapMask: 0 };
    fireEvent.click(screen.getByRole("radio", { name: "Default Overlap" }));
    expect(updateProjectSettings).toHaveBeenLastCalledWith({
      physics: { collisionLayers: ["Default"], collisionPresets: [{ ...defaultPreset, mask: 0xfffffffe, overlapMask: 1 }] },
    });
    fireEvent.change(screen.getByTestId("settings-collision-presets-add-value"), { target: { value: "Ghost Pass" } });
    fireEvent.click(screen.getByTestId("settings-collision-presets-add"));
    expect(updateProjectSettings).toHaveBeenLastCalledWith({
      physics: {
        collisionLayers: ["Default"],
        collisionPresets: [defaultPreset, { id: "ghost-pass", name: "Ghost Pass", layer: 1, mask: 0xffffffff, overlapMask: 0 }],
      },
    });
  });

  it("picks the packaged startup scene from Scene assets only", async () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-game"));
    fireEvent.click(screen.getByTestId("settings-startup-scene"));
    expect(await screen.findByTestId("search-item-scene-1")).toBeTruthy();
    expect(screen.queryByTestId("search-item-font-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-scene-2"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({ startupSceneGuid: "scene-2" }),
    );
  });

  it("picks Game Instance from a ClassPicker on the Game category", async () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-game"));
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

  it("authors packaging preset fields beside Export Project", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-export"));
    expect(screen.getByTestId("export-project")).toBeTruthy();
    expect(screen.getByTestId("setting-export-debugger")).toBeTruthy();
    fireEvent.click(screen.getByTestId("setting-export-debugger"));
    expect(updateProjectSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        exportPresets: [
          expect.objectContaining({ bundleDebugger: true }),
        ],
      }),
    );
  });

  it("edits the first export preset and keeps the others", () => {
    const web = { ...defaultExportPreset(), bundleDebugger: true };
    const desktop = { ...defaultExportPreset("desktop", "Desktop"), bundleDebugger: true };
    projectExportPresets.current = [web, desktop];
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-export"));
    fireEvent.click(screen.getByTestId("setting-export-debugger"));
    expect(updateProjectSettings).toHaveBeenLastCalledWith({
      exportPresets: [{ ...web, bundleDebugger: false }, desktop],
    });
  });

  it("downloads only the exported archive bytes and releases the URL after the download starts", async () => {
    exportProject.mockResolvedValue(new Uint8Array([9, 9, 1, 2, 3, 9]).subarray(2, 5));
    const blobs: Blob[] = [];
    const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:project-archive";
    });
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
      fireEvent.click(screen.getByTestId("settings-modal-category-export"));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await act(async () => {
        fireEvent.click(screen.getByTestId("export-project"));
      });
      expect(click).toHaveBeenCalledTimes(1);
      expect(blobs.map((blob) => blob.size)).toEqual([3]);
      // Safari and WKWebView read the blob URL after the click returns.
      expect(revokeUrl).not.toHaveBeenCalled();
      act(() => { vi.runAllTimers(); });
      expect(revokeUrl).toHaveBeenCalledWith("blob:project-archive");
    } finally {
      vi.useRealTimers();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      click.mockRestore();
    }
  });

  it("adds an Always Package Folder from the Export category's folder picker", () => {
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-export"));
    fireEvent.click(screen.getByTestId("settings-always-package-folders-add"));
    const row = screen.getByTestId("tree-row-assets/Weapons");
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 8, clientY: 8 });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
      fireEvent(row, event);
    }
    fireEvent.click(screen.getByTestId("settings-always-package-folders-picker-confirm"));
    expect(updateProjectSettings).toHaveBeenCalledWith({ alwaysPackageFolders: ["assets/Weapons"] });
  });

  it("authors custom render resolution on the Rendering category", () => {
    showRenderingSections("resolution");
    render(
      <SettingsModal open onOpenChange={() => {}} scope="project" />,
    );
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    expect(screen.getByTestId("setting-render-custom")).toBeTruthy();
    expect(screen.getByTestId("setting-render-width")).toBeTruthy();
    expect(screen.getByTestId("setting-render-height")).toBeTruthy();
    expect(screen.getByTestId("setting-render-black-bars")).toBeTruthy();
  });

  it("shows Large World Rendering off for a project without it, and stages turning it on until Done", () => {
    showRenderingSections("pipeline");
    lastProjectRender.current = createEmptyProject("Demo").settings.render;
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    const toggle = screen.getByTestId("setting-render-large-world");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(updateProjectSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(lastProjectRender.current).toMatchObject({ largeWorldRendering: true });
  });

  it("offers Upscaling only with Custom Resolution, and stages Pixelated until Done", async () => {
    showRenderingSections("resolution");
    const openResolution = () => {
      fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    };
    lastProjectRender.current = { ...createEmptyProject("Demo").settings.render, customResolution: false };
    const view = render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    openResolution();
    expect(screen.queryByTestId("setting-render-upscaling")).toBeNull();
    lastProjectRender.current = { ...createEmptyProject("Demo").settings.render, customResolution: true, blackBars: true };
    view.rerender(<SettingsModal open onOpenChange={() => {}} scope="project" key="bars" />);
    openResolution();
    expect(screen.getByTestId("setting-render-upscaling").textContent).toContain("Smooth");
    fireEvent.click(screen.getByTestId("setting-render-upscaling"));
    const option = await screen.findByRole("option", { name: "Pixelated" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    await waitFor(() => expect(screen.getByTestId("setting-render-upscaling").textContent).toContain("Pixelated"));
    expect(updateProjectSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(lastProjectRender.current).toMatchObject({ customResolution: true, blackBars: true, upscaling: "pixelated" });
  });

  it("says FSR Upscaling and Anti-Aliasing stay off while Upscaling is Pixelated", () => {
    showRenderingSections("scalability", "postProcessing");
    lastProjectRender.current = { ...createEmptyProject("Demo").settings.render, customResolution: true, upscaling: "smooth" };
    const view = render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    expect(screen.queryByTestId("project-effects-upscaling-note")).toBeNull();
    expect(screen.queryByTestId("quality-antialiasing-pixelated")).toBeNull();
    lastProjectRender.current = { ...createEmptyProject("Demo").settings.render, customResolution: true, upscaling: "pixelated" };
    view.rerender(<SettingsModal open onOpenChange={() => {}} scope="project" key="pixelated" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    expect(screen.getByTestId("project-effects-upscaling-note").textContent).toContain("Pixelated");
    expect(screen.getByTestId("project-effects-upscaling").getAttribute("aria-describedby")).toContain("project-effects-upscaling-note");
    expect(screen.getByTestId("quality-antialiasing-pixelated")).toBeTruthy();
  });

  it("stages the pipeline preference until Done", async () => {
    showRenderingSections("pipeline");
    const view = render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    const select = async (id: string, name: string) => {
      fireEvent.click(screen.getByTestId(id));
      const option = await screen.findByRole("option", { name });
      fireEvent.pointerDown(option);
      fireEvent.click(option);
      await waitFor(() => expect(screen.getByTestId(id).textContent).toContain(name));
    };
    await select("setting-render-mode", "CEL");
    expect(lastProjectRender.current).toBeNull();
    // Unrelated provider rerenders must not commit or discard the active draft.
    view.rerender(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    expect(screen.getByTestId("setting-render-mode").textContent).toContain("CEL");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(lastProjectRender.current).toMatchObject({ mode: "cel" });
  });

  it("shows CEL controls only in CEL and retains their values when returning from PBR", async () => {
    showRenderingSections("pipeline", "cel");
    const view = render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    const selectMode = async (name: "CEL" | "PBR") => {
      fireEvent.click(screen.getByTestId("setting-render-mode"));
      const option = await screen.findByRole("option", { name });
      fireEvent.pointerDown(option);
      fireEvent.click(option);
      await waitFor(() => expect(screen.getByTestId("setting-render-mode").textContent).toContain(name));
      expect(lastProjectRender.current).toBeNull();
      view.rerender(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    };
    fireEvent.click(screen.getByTestId("settings-modal-category-rendering"));
    expect(screen.queryByTestId("project-cel-settings")).toBeNull();
    await selectMode("CEL");
    fireEvent.change(screen.getByLabelText("Shadow Bands"), { target: { value: "6" } });
    view.rerender(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    await selectMode("PBR");
    expect(screen.queryByRole("button", { name: "CEL Shading" })).toBeNull();
    expect(screen.queryByTestId("project-cel-settings")).toBeNull();
    expect(lastProjectRender.current).toBeNull();
    await selectMode("CEL");
    expect((screen.getByLabelText("Shadow Bands") as HTMLInputElement).value).toBe("6");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(lastProjectRender.current).toMatchObject({ mode: "cel", cel: { shadowBands: 6 } });
  });

  // Explanations are the label's tooltip and stay the control's screen-reader description;
  // live state (a missing requirement) stays visible.
  it.each([
    ["general", "settings-infinite-loop-detection", /Stops runaway scripts/, "hint"],
    ["game", "settings-pixel-perfect", /Draws the 2D editor view at device pixels/, "hint"],
    ["game", "settings-nearest-textures", /nearest-neighbour filtering/, "hint"],
    ["game", "settings-nearest-textures", /Needs Pixel-Perfect Mode/, "status"],
    ["audio", "settings-audio-occlusion", /Wall muffling/, "hint"],
    ["rendering", "setting-render-custom", /Sets the design size/, "hint"],
    ["rendering", "setting-render-black-bars", /Adds bars to preserve/, "hint"],
    ["rendering", "setting-render-large-world", /kilometres from the origin/, "hint"],
    ["rendering", "setting-play-follow-system", /Off uses a fixed aspect ratio/, "hint"],
  ])("keeps the %s %s description %s inside its setting before the separator", (category, controlId, descriptionText, kind) => {
    showRenderingSections("pipeline", "resolution", "playPreview");
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId(`settings-modal-category-${category}`));
    const control = screen.getByTestId(controlId);
    const description = screen.getByText(descriptionText);
    const field = control.closest('[data-slot="field"]');
    expect(field?.contains(description)).toBe(true);
    expect(control.getAttribute("aria-describedby")?.split(" ")).toContain(description.id);
    expect(description.classList.contains("sr-only")).toBe(kind === "hint");
    if (kind === "hint") expect(field?.querySelector("[data-label-hint]")).toBeTruthy();
  });

  it("identifies Beta when confirming enablement and enables only after confirmation", async () => {
    pluginDescriptors.push({
      pluginGuid: "tools",
      source: "project",
      folderName: "tools",
      readOnly: false,
      folderPath: "plugins/tools",
      contentPath: "plugins/tools/assets",
      settingsPath: "plugins/tools/tools.plugin.hasset",
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

  it.each(["project", "engine"] as const)("hides %s Source Control on production web", (scope) => {
    host.platform = "web";
    host.testMode = false;
    render(<SettingsModal open onOpenChange={() => {}} scope={scope} />);
    expect(screen.queryByTestId(`${scope === "engine" ? "engine-settings-modal" : "settings-modal"}-category-sourceControl`)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search settings"), { target: { value: "source control" } });
    expect(screen.queryByText("Source Control")).toBeNull();
  });

  it("lists Engine Settings → Source Control in the Projects group", async () => {
    render(<SettingsModal open onOpenChange={() => {}} scope="engine" />);
    const category = screen.getByTestId("engine-settings-modal-category-sourceControl");
    expect(category.closest(".flex-col")?.querySelector("p")?.textContent).toBe("Projects");
    fireEvent.click(category);
    expect(await screen.findByText("Self-Managed GitLab")).toBeTruthy();
    expect(screen.getByText("Other Git Hosts")).toBeTruthy();
  });

  it("offers Off and Manual modes, with no Token or Poll Interval rows", () => {
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    const mode = screen.getByTestId("settings-source-control-mode");
    expect(within(mode).getAllByRole("button").map((button) => button.textContent)).toEqual(["Off", "Manual"]);
    expect(screen.getByTestId("settings-source-control-mode-off").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Token")).toBeNull();
    expect(screen.queryByText(/Poll Interval/)).toBeNull();
    expect(screen.queryByText("Release Locks After Push")).toBeNull();
  });

  it("chooses Lock On Edit from Ask, Always and Never, Ask by default", () => {
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    const lockOnEdit = screen.getByRole("group", { name: "Lock On Edit" });
    expect(within(lockOnEdit).getAllByRole("button").map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([
      ["Ask", "true"],
      ["Always", "false"],
      ["Never", "false"],
    ]);
    fireEvent.click(within(lockOnEdit).getByRole("button", { name: "Never" }));
    expect(updateProjectSettings).toHaveBeenLastCalledWith({
      sourceControl: expect.objectContaining({ mode: "off", lockOnEdit: "never" }),
    });
  });

  it("offers Integrated on desktop for a folder with .git, only after the one-Git-app warning, recording the answer before taking its origin and branch", async () => {
    host.testMode = false;
    sourceControl.folder.current = { tier: "external", hasGit: true };
    // A Manual project's settings name another branch: the working copy's own wins.
    projectSourceControl.current = { mode: "manual", repositoryUrl: "https://github.com/team/old.git", branch: "main" };
    sourceControl.readGitPrefill.mockResolvedValueOnce({ repositoryUrl: "https://github.com/team/game.git", branch: "develop" });
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    const integrated = await screen.findByTestId("settings-source-control-mode-integrated");
    expect(within(screen.getByTestId("settings-source-control-mode")).getAllByRole("button").map((button) => button.textContent)).toEqual(["Off", "Integrated", "Manual"]);
    // A folder that has Git already is never offered Publish.
    expect(screen.queryByTestId("settings-source-control-publish")).toBeNull();
    // Cancel stores nothing and switches nothing.
    fireEvent.click(integrated);
    expect((await screen.findByTestId("source-control-adopt-confirm")).textContent).toContain("No other Git app may use it at the same time");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("source-control-adopt-confirm")).toBeNull());
    expect(sourceControl.setAdoption).not.toHaveBeenCalled();
    expect(updateProjectSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("settings-source-control-mode-integrated"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("source-control-adopt-confirm-action"));
    });
    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith({
        sourceControl: expect.objectContaining({ mode: "integrated", repositoryUrl: "https://github.com/team/game.git", branch: "develop" }),
      }),
    );
    // The answer is in the working copy before the mode that needs it.
    expect(sourceControl.setAdoption.mock.calls).toEqual([[true]]);
    expect(sourceControl.setAdoption.mock.invocationCallOrder[0]).toBeLessThan(updateProjectSettings.mock.invocationCallOrder[0]!);
  });

  it("keeps the mode when the answer cannot be recorded, saying why in the warning", async () => {
    host.testMode = false;
    sourceControl.folder.current = { tier: "external", hasGit: true };
    projectSourceControl.current = { mode: "manual", repositoryUrl: "https://github.com/team/game.git", branch: "main" };
    sourceControl.readGitPrefill.mockResolvedValueOnce({ repositoryUrl: "https://github.com/team/game.git", branch: "main" });
    sourceControl.setAdoption.mockRejectedValueOnce(new Error("The folder is read-only."));
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    fireEvent.click(await screen.findByTestId("settings-source-control-mode-integrated"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("source-control-adopt-confirm-action"));
    });
    expect((await screen.findByTestId("source-control-adopt-error")).textContent).toContain("The folder is read-only.");
    expect(updateProjectSettings).not.toHaveBeenCalled();
  });

  it("asks once before running Git in a desktop working copy, and Stop Using asks again, never changing the project's mode", async () => {
    host.testMode = false;
    sourceControl.folder.current = { tier: "documents", hasGit: true };
    projectSourceControl.current = { mode: "integrated", repositoryUrl: INTEGRATED_REPOSITORY, branch: "main" };
    const desktop = await deviceIntegratedSync({ adopted: false });
    sourceControl.sync.current = desktop.service;
    sourceControl.setAdoption.mockImplementation(desktop.setAdoption);
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    expect((await screen.findByTestId("settings-source-control-blocked")).textContent).toBe("Haptic Does Not Run Git In This Folder Yet");
    expect(screen.queryByTestId("settings-source-control-stop-using")).toBeNull();

    // Cancel stores nothing; the blocker stays, and nothing asks again by itself.
    fireEvent.click(screen.getByTestId("settings-source-control-adopt"));
    expect((await screen.findByTestId("source-control-adopt-confirm")).textContent).toContain("No other Git app may use it at the same time");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("source-control-adopt-confirm")).toBeNull());
    expect(desktop.adoption.adopted).toBe(false);
    expect(screen.getByTestId("settings-source-control-blocked")).toBeTruthy();

    fireEvent.click(screen.getByTestId("settings-source-control-adopt"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("source-control-adopt-confirm-action"));
    });
    await waitFor(() => expect(screen.queryByTestId("settings-source-control-blocked")).toBeNull());
    expect(desktop.adoption.adopted).toBe(true);
    expect(desktop.service.getSnapshot()).toMatchObject({ active: true, blocked: null });

    await act(async () => {
      fireEvent.click(await screen.findByTestId("settings-source-control-stop-using"));
    });
    expect((await screen.findByTestId("settings-source-control-blocked")).textContent).toBe("Haptic Does Not Run Git In This Folder Yet");
    expect(desktop.adoption.adopted).toBe(false);
    expect(desktop.service.getSnapshot().active).toBe(false);
    expect(updateProjectSettings).not.toHaveBeenCalled();
  });

  it("offers an iPad project only Off and Manual, with Publish for an Off project in app storage", async () => {
    host.platform = "ios";
    host.testMode = false;
    sourceControl.folder.current = { tier: "documents", hasGit: false };
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    expect(await screen.findByTestId("settings-source-control-publish")).toBeTruthy();
    expect(within(screen.getByTestId("settings-source-control-mode")).getAllByRole("button").map((button) => button.textContent)).toEqual(["Off", "Manual"]);
  });

  it("offers Integrated back to an iPad copy in app storage that has .git, which only Haptic syncs, without the one-Git-app warning", async () => {
    host.platform = "ios";
    host.testMode = false;
    sourceControl.folder.current = { tier: "documents", hasGit: true };
    // A branch whose project.json says Manual left this working copy without Haptic's Git.
    projectSourceControl.current = { mode: "manual", repositoryUrl: "https://github.com/team/game.git", branch: "main" };
    sourceControl.readGitPrefill.mockResolvedValueOnce({ repositoryUrl: "https://github.com/team/game.git", branch: "main" });
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    const integrated = await screen.findByTestId("settings-source-control-mode-integrated");
    expect(within(screen.getByTestId("settings-source-control-mode")).getAllByRole("button").map((button) => button.textContent)).toEqual(["Off", "Integrated", "Manual"]);
    await act(async () => {
      fireEvent.click(integrated);
    });
    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith({
        sourceControl: expect.objectContaining({ mode: "integrated", repositoryUrl: "https://github.com/team/game.git", branch: "main" }),
      }),
    );
    expect(screen.queryByTestId("source-control-adopt-confirm")).toBeNull();
    expect(sourceControl.setAdoption).not.toHaveBeenCalled();
  });

  it("shows Integrated and Release Locks After Push for an Integrated project, and why a folder cannot run it", async () => {
    host.platform = "ios";
    host.testMode = false;
    sourceControl.folder.current = { tier: "external", hasGit: true };
    projectSourceControl.current = { mode: "integrated", repositoryUrl: INTEGRATED_REPOSITORY };
    sourceControl.sync.current = (await deviceIntegratedSync({ adopted: false, platform: "ios", tier: "external" })).service;
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    expect(screen.getByTestId("settings-source-control-mode-integrated").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("settings-source-control-release-after-push")).toBeTruthy();
    expect((await screen.findByTestId("settings-source-control-blocked")).textContent).toBe("Another Git App Syncs This Folder");
  });

  it("keeps an Integrated project's repository and branch as the working copy has them, even signed in", async () => {
    await accounts.current!.save(TEST_GITHUB_CREDENTIAL);
    projectSourceControl.current = { mode: "integrated", repositoryUrl: "https://github.com/haptic-test/game.git", branch: "main" };
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    await waitFor(() => expect(screen.getByTestId("settings-source-control-account-state").textContent).toBe("ada (GitHub)"));
    // No repository or branch picker: a different one would leave the working copy behind.
    expect(screen.queryByTestId("settings-source-control-repository")).toBeNull();
    expect(screen.getByTestId("settings-source-control-url").hasAttribute("readonly")).toBe(true);
    expect(screen.getByTestId("settings-source-control-branch").hasAttribute("readonly")).toBe(true);
    expect(screen.getByTestId("settings-source-control-branch").getAttribute("role")).not.toBe("combobox");
    // The project's branch is the team's default; the checked-out one is the working copy's own.
    expect(screen.getByLabelText("Default Branch")).toBe(screen.getByTestId("settings-source-control-branch"));
  });

  it("fills Source Control from Git without replacing a URL typed during the read", async () => {
    let finishPrefill!: (prefill: { repositoryUrl: string; branch: string }) => void;
    sourceControl.readGitPrefill.mockImplementationOnce(
      () => new Promise((resolve) => { finishPrefill = resolve; }),
    );
    const view = render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    fireEvent.click(screen.getByTestId("settings-source-control-mode-manual"));
    expect(sourceControl.readGitPrefill).toHaveBeenCalledTimes(1);
    projectSourceControl.current = { repositoryUrl: "https://example.com/typed.git" };
    view.rerender(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    await act(async () => {
      finishPrefill({ repositoryUrl: "https://example.com/origin.git", branch: "develop" });
    });
    expect(updateProjectSettings).toHaveBeenLastCalledWith({
      sourceControl: expect.objectContaining({
        mode: "manual",
        repositoryUrl: "https://example.com/typed.git",
        branch: "develop",
      }),
    });
  });

  it("turns Manual on with the repository and branch read from Git", async () => {
    sourceControl.readGitPrefill.mockResolvedValueOnce({ repositoryUrl: "https://example.com/origin.git", branch: "develop" });
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    fireEvent.click(screen.getByTestId("settings-source-control-mode-manual"));
    await waitFor(() =>
      expect(updateProjectSettings).toHaveBeenCalledWith({
        sourceControl: expect.objectContaining({ mode: "manual", repositoryUrl: "https://example.com/origin.git", branch: "develop" }),
      }),
    );
    expect(screen.queryByTestId("settings-source-control-url-error")).toBeNull();
  });

  it("refuses to turn Manual on without a repository until one is entered", async () => {
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    fireEvent.click(screen.getByTestId("settings-source-control-mode-manual"));
    const error = await screen.findByTestId("settings-source-control-url-error");
    expect(error.textContent).toBe("Enter a repository URL before turning on Source Control.");
    expect(screen.getByTestId("settings-source-control-url").getAttribute("aria-invalid")).toBe("true");
    expect(updateProjectSettings).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("settings-source-control-url"), {
      target: { value: "https://example.com/team.git" },
    });
    expect(screen.queryByTestId("settings-source-control-url-error")).toBeNull();
  });

  it("turns Manual on at once when a repository is already set", () => {
    projectSourceControl.current = { repositoryUrl: "https://example.com/team.git" };
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    fireEvent.click(screen.getByTestId("settings-source-control-mode-manual"));
    expect(updateProjectSettings).toHaveBeenCalledWith({
      sourceControl: expect.objectContaining({ mode: "manual", repositoryUrl: "https://example.com/team.git" }),
    });
    expect(sourceControl.readGitPrefill).not.toHaveBeenCalled();
  });

  it("confirms before turning Source Control off", () => {
    sourceControlEnabled.current = true;
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    fireEvent.click(screen.getByTestId("settings-source-control-mode-off"));
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId("settings-source-control-disable-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("settings-source-control-disable-confirm-action"));
    expect(updateProjectSettings).toHaveBeenCalledWith({ sourceControl: expect.objectContaining({ mode: "off" }) });
  });

  it("picks the repository and branch from the signed-in GitHub account in Manual mode", async () => {
    await accounts.current!.save(TEST_GITHUB_CREDENTIAL);
    projectSourceControl.current = { mode: "manual", repositoryUrl: "https://github.com/haptic-test/game.git", branch: "main" };
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    await waitFor(() => expect(screen.getByTestId("settings-source-control-account-state").textContent).toBe("ada (GitHub)"));
    expect(screen.queryByTestId("settings-source-control-url")).toBeNull();
    expect(screen.getByTestId("settings-source-control-repository").textContent).toBe("haptic-test/game");
    // The branch is a picker of the host's branches.
    await waitFor(() => expect(screen.getByTestId("settings-source-control-branch").getAttribute("role")).toBe("combobox"));
    fireEvent.click(screen.getByTestId("settings-source-control-repository"));
    const picker = await screen.findByTestId("settings-source-control-repository-picker");
    fireEvent.click(await within(picker).findByText("haptic-test/prototype"));
    expect(updateProjectSettings).toHaveBeenLastCalledWith({
      sourceControl: expect.objectContaining({ repositoryUrl: "https://github.com/haptic-test/prototype.git", branch: "main" }),
    });
  });

  it("shows the URL field and Sign In in Manual mode without a credential for the repository's host", async () => {
    projectSourceControl.current = { mode: "manual", repositoryUrl: "https://github.com/org/game.git" };
    render(<SettingsModal open onOpenChange={() => {}} scope="project" />);
    fireEvent.click(screen.getByTestId("settings-modal-category-sourceControl"));
    expect((await screen.findByTestId("settings-source-control-account-state")).textContent).toBe("Not Signed In");
    expect(screen.getByTestId("settings-source-control-url")).toBeTruthy();
    fireEvent.click(screen.getByTestId("settings-source-control-sign-in"));
    expect((await screen.findByTestId("source-control-link-warning")).textContent).toContain("Link GitHub?");
    fireEvent.click(screen.getByTestId("source-control-link-decline"));
    await waitFor(() => expect(screen.queryByTestId("source-control-link-warning")).toBeNull());
    expect(await accounts.current!.list()).toEqual([]);
  });
});
