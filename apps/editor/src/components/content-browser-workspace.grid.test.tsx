import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { IndexedAsset } from "@haptic/assets";
import { AssetRegistry, createDefaultPluginSettings, projectContentRoot } from "@haptic/assets";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { ContentBrowserWorkspace } from "./content-browser-workspace";
import { KeybindProvider } from "../context/keybind-context";
import { subscribeModelThumbnailJobs, type ModelThumbnailJob } from "../lib/model-thumbnail-queue";
import {
  CONTENT_BROWSER_GRID_GAP_PX,
  CONTENT_BROWSER_GRID_PAD_PX,
  CONTENT_BROWSER_TILE_HEIGHT_PX,
  CONTENT_BROWSER_TILE_WIDTH_PX,
} from "../lib/content-browser-grid";

const { docs, loadAssetThumbnail, layout } = vi.hoisted(() => {
  const loadAssetThumbnail = vi.fn<(guid: string) => Promise<Uint8Array | null>>()
    .mockResolvedValue(new Uint8Array([1, 2, 3]));
  const docs = {
    projectGuid: "thumbnail-project",
    projectDocument: { settings: {
      pluginOverrides: {},
      gameInstanceClass: null as string | null,
      editorUtilityObjects: [] as string[],
      startupSceneGuid: "",
    } },
    assetRegistry: null as unknown,
    registryEpoch: 1,
    encodingTextures: new Set<string>(),
    refreshAssetRegistry: vi.fn(),
    noteAssetsCreated: vi.fn(),
    renameAsset: (guid: string, name: string): Promise<IndexedAsset> =>
      (docs.assetRegistry as { renameAsset: (guid: string, name: string) => Promise<IndexedAsset> }).renameAsset(guid, name),
    repathDocument: vi.fn(),
    repathProjectFolder: vi.fn(),
    openDocument: vi.fn(),
    closeDocumentsForPaths: vi.fn(),
    repairAfterAssetDelete: vi.fn(async () => {}),
    replaceClassReferencesBeforeDelete: vi.fn(async () => {}),
    openDocuments: [] as unknown[],
    setActiveDocument: vi.fn(),
    tabOrder: [] as string[],
    loadAssetThumbnail,
    thumbnailsEnabled: true,
    thumbnailVersions: {} as Record<string, number>,
    pluginDescriptors: [] as unknown[],
    showPluginContent: false,
    sourceControl: {
      enabled: false,
      requestRefresh: vi.fn(),
      lockStateForPath: vi.fn<() => "mine" | null>().mockReturnValue(null),
      transferLock: vi.fn(async () => {}),
      lockForPath: () => null,
      refuseIfTheirs: () => null,
    },
    activeDocumentId: "content-browser",
  };
  return { docs, loadAssetThumbnail, layout: { phone: false } };
});

vi.mock("../shell/use-platform-layout", () => ({
  usePhoneLayout: () => layout.phone,
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => docs));

vi.mock("../context/project-search-context", () => ({
  useProjectSearch: () => ({
    pendingTarget: null,
    clearPendingTarget: vi.fn(),
  }),
}));

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({ diagnostics: [] }),
}));

function texture(index: number): IndexedAsset {
  return {
    rootId: "project",
    path: `assets/tex-${index}.hasset`,
    header: {
      dependencyMetadataVersion: 1, requiredDependencies: [],
      guid: `tex-${index}`,
      type: "Texture",
      name: `tex-${index}`,
      engineVersion: "0.0.0",
      version: 1,
      mode: "thin",
      dependencies: [],
      parentClass: null,
      payload: {},
      chunks: [],
    },
  };
}

function installRegistry(assets: IndexedAsset[], folders: string[] = []) {
  const root = projectContentRoot();
  docs.assetRegistry = {
    getRoot: (id: string) => (id === "project" ? root : undefined),
    list: () => assets,
    folderTree: () => ({
      name: "assets",
      path: "assets",
      children: folders.map((name) => ({
        name,
        path: `assets/${name}`,
        children: [],
        assets: assets
          .filter((asset) => asset.path.startsWith(`assets/${name}/`))
          .map((asset) => asset.header.guid),
      })),
      assets: assets
        .filter(
          (asset) =>
            !folders.some((name) => asset.path.startsWith(`assets/${name}/`)),
        )
        .map((asset) => asset.header.guid),
    }),
    getByGuid: (guid: string) =>
      assets.find((asset) => asset.header.guid === guid),
  };
}

/** jsdom has no PointerEvent; preserve the fields used by row gestures. */
function tapTreeRow(row: Element, pointerType: "mouse" | "touch" = "mouse") {
  for (const type of ["pointerdown", "pointerup"]) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 8,
      clientY: 8,
    });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      pointerType: { value: pointerType },
      isPrimary: { value: true },
    });
    fireEvent(row, event);
  }
}

const clientWidthDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientWidth",
);
const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight",
);

function stubGridSize(width: number, height: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      if (
        (this as HTMLElement).getAttribute?.("data-testid") ===
        "content-browser-asset-grid"
      ) {
        return width;
      }
      return clientWidthDescriptor?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if (
        (this as HTMLElement).getAttribute?.("data-testid") ===
        "content-browser-asset-grid"
      ) {
        return height;
      }
      return clientHeightDescriptor?.get?.call(this) ?? 0;
    },
  });
}

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  await Promise.resolve();
  loadAssetThumbnail.mockClear();
  docs.thumbnailsEnabled = true;
  docs.thumbnailVersions = {};
  docs.encodingTextures = new Set();
  layout.phone = false;
  docs.openDocument.mockClear();
  docs.repathDocument.mockClear();
  docs.repathProjectFolder.mockClear();
  docs.refreshAssetRegistry.mockClear();
  docs.noteAssetsCreated.mockReset();
  docs.registryEpoch = 1;
  docs.sourceControl.enabled = false;
  docs.sourceControl.lockStateForPath.mockReset().mockReturnValue(null);
  docs.sourceControl.transferLock.mockReset().mockResolvedValue(undefined);
  docs.openDocuments = [];
  docs.pluginDescriptors = [];
  docs.showPluginContent = false;
  docs.projectDocument.settings.gameInstanceClass = null;
  docs.projectDocument.settings.editorUtilityObjects = [];
  docs.projectDocument.settings.startupSceneGuid = "";
  docs.replaceClassReferencesBeforeDelete.mockReset().mockResolvedValue(undefined);
  docs.repairAfterAssetDelete.mockClear();
  if (clientWidthDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientWidth",
      clientWidthDescriptor,
    );
  }
  if (clientHeightDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientHeight",
      clientHeightDescriptor,
    );
  }
});

describe("ContentBrowserWorkspace referenced Class deletion", () => {
  function classAndScene(folder = "assets") {
    const actorClass = texture(0);
    actorClass.path = `${folder}/Hero.class.hasset`;
    actorClass.header = { ...actorClass.header, type: "Class", name: "Hero", guid: "hero" };
    const scene = texture(1);
    scene.path = "assets/main.scene.hasset";
    scene.header = { ...scene.header, type: "Scene", name: "main", guid: "main" };
    return { actorClass, scene };
  }

  beforeEach(() => {
    docs.thumbnailsEnabled = false;
  });

  it("requires a second confirmation for unsaved Class usages and preserves both assets on Back", async () => {
    const { actorClass, scene } = classAndScene();
    const content = { actors: [{ classId: "Hero", components: [] }] };
    docs.openDocuments = [{ ref: { path: scene.path }, content }];
    installRegistry([actorClass, scene]);
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId(`content-item-${actorClass.path}`));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));

    await waitFor(() => {
      expect((screen.getByTestId("content-browser-delete-confirm") as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByTestId("content-browser-delete-dialog").textContent).toContain("main");
    });
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));
    expect(screen.getByTestId("content-browser-delete-references-confirmation").textContent).toContain("Hero → None");
    expect(docs.replaceClassReferencesBeforeDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByTestId("content-browser-delete-cancel"));
    expect(screen.getByTestId(`content-item-${actorClass.path}`)).toBeTruthy();
    expect(content.actors).toEqual([{ classId: "Hero", components: [] }]);
  });

  it("lists a usage added in an open tab while the delete dialog is showing", async () => {
    const { actorClass, scene } = classAndScene();
    installRegistry([actorClass, scene]);
    const view = render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId(`content-item-${actorClass.path}`));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));
    await waitFor(() => expect((screen.getByTestId("content-browser-delete-confirm") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId("content-browser-delete-dialog").textContent).not.toContain("main");

    docs.openDocuments = [{ ref: { path: scene.path }, content: { actors: [{ classId: "Hero", components: [] }] } }];
    view.rerender(<ContentBrowserWorkspace />);
    await waitFor(() => expect(screen.getByTestId("content-browser-delete-dialog").textContent).toContain("main"));
  });

  it("allows deleting a folder when its Class referrers are also selected for deletion", async () => {
    const { actorClass, scene } = classAndScene("assets/Actors");
    scene.path = "assets/Actors/main.scene.hasset";
    scene.header.dependencies = ["hero"];
    installRegistry([actorClass, scene], ["Actors"]);
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-folder-assets/Actors"));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));

    await waitFor(() => {
      expect((screen.getByTestId("content-browser-delete-confirm") as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.getByRole("alertdialog", { name: "Delete Actors?" })).toBeTruthy();
    const rows = screen.getByTestId("content-browser-delete-list").querySelectorAll("li");
    expect(Array.from(rows).map((row) => row.textContent)).toEqual(["Actorsassets/Actors2 Assets"]);
  });

  it.each(["Material", "Prefab"])("deletes a referenced %s after one confirmation and updates its references", async (type) => {
    const { actorClass: asset, scene } = classAndScene();
    asset.header.type = type;
    scene.header.dependencies = ["hero"];
    installRegistry([asset, scene]);
    const deleteAsset = vi.fn(async () => {});
    Object.assign(docs.assetRegistry as object, { deleteAsset });
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId(`content-item-${asset.path}`));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));

    expect(screen.getByTestId("content-browser-delete-dialog").textContent).toContain("main");
    expect((screen.getByTestId("content-browser-delete-confirm") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));

    // No Class is deleted, so there is nothing to replace and no second step.
    expect(screen.queryByTestId("content-browser-delete-references-confirmation")).toBeNull();
    await waitFor(() => expect(deleteAsset).toHaveBeenCalledWith("hero"));
    expect(docs.replaceClassReferencesBeforeDelete).not.toHaveBeenCalled();
    await waitFor(() => expect(docs.repairAfterAssetDelete).toHaveBeenCalledWith(new Set(["hero"]), new Set(), expect.any(Function), []));
  });

  it.each(["gameInstanceClass", "editorUtilityObjects"] as const)(
    "requires a second confirmation for a Class assigned in Project Settings %s",
    async (setting) => {
      const { actorClass } = classAndScene();
      if (setting === "gameInstanceClass") docs.projectDocument.settings.gameInstanceClass = "Hero";
      else docs.projectDocument.settings.editorUtilityObjects = ["Hero"];
      installRegistry([actorClass]);
      render(<ContentBrowserWorkspace />);
      fireEvent.click(screen.getByTestId(`content-item-${actorClass.path}`));
      fireEvent.click(screen.getByTestId("content-browser-delete-selected"));

      await waitFor(() => {
        expect(screen.getByTestId("content-browser-delete-dialog").textContent).toContain("Project Settings");
      });
      await waitFor(() => expect((screen.getByTestId("content-browser-delete-confirm") as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));
      expect(screen.getByTestId("content-browser-delete-references-confirmation")).toBeTruthy();
    },
  );

  it("chooses one replacement for two usages and stops deletion if updating references fails", async () => {
    const { actorClass, scene } = classAndScene();
    const replacement = { ...actorClass, path: "assets/NPC.class.hasset", header: { ...actorClass.header, guid: "npc", name: "NPC" } };
    docs.openDocuments = [{ ref: { path: scene.path }, content: { actors: [
      { id: "one", classId: "Hero", components: [] }, { id: "two", classId: "Hero", components: [] },
    ] } }];
    installRegistry([actorClass, replacement, scene]);
    const deleteAsset = vi.fn();
    Object.assign(docs.assetRegistry as object, { deleteAsset });
    docs.replaceClassReferencesBeforeDelete.mockRejectedValue(new Error("Reference write failed"));
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId(`content-item-${actorClass.path}`));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Replace Hero" })).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Replace Hero" }));
    fireEvent.click(await screen.findByTestId("search-item-npc"));
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));
    expect(screen.getByTestId("content-browser-delete-references-confirmation").textContent).toContain("Hero → NPC");
    expect(deleteAsset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("content-browser-delete-references-confirm"));
    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "Delete Failed" }).textContent).toContain("Reference write failed"));
    expect(docs.replaceClassReferencesBeforeDelete).toHaveBeenCalledWith([
      { guid: "hero", classId: "Hero", replacement: { guid: "npc", classId: "NPC" } },
    ], new Set(["hero"]), expect.any(Function));
    expect(deleteAsset).not.toHaveBeenCalled();
    expect(screen.getByTestId(`content-item-${actorClass.path}`)).toBeTruthy();
  });

  it("deletes the project startup scene after one confirmation that lists Project Settings", async () => {
    const { scene } = classAndScene();
    docs.projectDocument.settings.startupSceneGuid = scene.header.guid;
    installRegistry([scene]);
    const deleteAsset = vi.fn(async () => {});
    Object.assign(docs.assetRegistry as object, { deleteAsset });
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId(`content-item-${scene.path}`));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));
    expect(screen.getByTestId("content-browser-delete-dialog").textContent).toContain("Project Settings");
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));
    expect(screen.queryByTestId("content-browser-delete-references-confirmation")).toBeNull();
    await waitFor(() => expect(deleteAsset).toHaveBeenCalledWith(scene.header.guid));
  });
});

describe("ContentBrowserWorkspace grid window", () => {
  it("uses the plugin icon only on its base folder and keeps nested folders unchanged", () => {
    docs.thumbnailsEnabled = false;
    docs.showPluginContent = true;
    const plugin = {
      pluginGuid: "tools",
      source: "project",
      folderName: "tools",
      readOnly: false,
      folderPath: "plugins/tools",
      contentPath: "plugins/tools/assets",
      settingsPath: "plugins/tools/tools.plugin.hasset",
      settings: {
        ...createDefaultPluginSettings({ pluginGuid: "tools", displayName: "Tool Pack" }),
        enabledByDefault: true,
        iconKey: "Star",
      },
    };
    docs.pluginDescriptors = [plugin];
    const root = projectContentRoot();
    docs.assetRegistry = {
      getRoot: (id: string) => id === "project" ? root : { ...root, id, pathPrefix: plugin.contentPath },
      list: () => [],
      folderTree: (id: string) => id === "project" ? {
        name: "assets", path: "assets", children: [], assets: [],
      } : {
        name: "assets", path: plugin.contentPath, assets: [],
        children: [{ name: "Nested", path: `${plugin.contentPath}/Nested`, children: [], assets: [] }],
      },
    };
    const { rerender } = render(<ContentBrowserWorkspace />);
    const base = screen.getByTestId("tree-row-plugins/tools/assets");
    expect(base.querySelector("svg.lucide-star")).not.toBeNull();
    expect(base.querySelector("svg.lucide-folder")).toBeNull();
    expect(screen.getByTestId("tree-row-assets").querySelector("svg.lucide-folder")).not.toBeNull();
    const nested = screen.getByTestId("tree-row-plugins/tools/assets/Nested");
    expect(nested.querySelector("svg.lucide-folder")).not.toBeNull();
    expect(nested.querySelector("svg.lucide-star")).toBeNull();

    tapTreeRow(base);
    const tile = screen.getByTestId("content-folder-plugins/tools/assets/Nested");
    expect(tile.querySelector("svg.lucide-folder")).not.toBeNull();
    expect(tile.querySelector("svg.lucide-star")).toBeNull();

    docs.pluginDescriptors = [{ ...plugin, settings: { ...plugin.settings, iconKey: "Unrecognized" } }];
    rerender(<ContentBrowserWorkspace />);
    expect(screen.getByTestId("tree-row-plugins/tools/assets").querySelector("svg.lucide-folder")).not.toBeNull();
  });

  it("reports a selected file read failure and releases the import busy state", async () => {
    installRegistry([]);
    let failRead!: (error: Error) => void;
    const read = new Promise<ArrayBuffer>((_resolve, reject) => { failRead = reject; });
    const file = new File([new Uint8Array([1])], "unreadable.png");
    Object.defineProperty(file, "arrayBuffer", { value: () => read });
    render(<ContentBrowserWorkspace />);
    fireEvent.change(screen.getByTestId("content-browser-import-input"), { target: { files: [file] } });
    const busyWhileReading = screen.getByTestId("content-browser-import").hasAttribute("disabled");
    await act(async () => { failRead(new Error("File access expired")); });
    expect(await screen.findByText(/unreadable.png: File access expired/)).toBeTruthy();
    expect(busyWhileReading).toBe(true);
    expect(screen.getByTestId("content-browser-import").hasAttribute("disabled")).toBe(false);
  });
  it("blocks other actions while a Duplicate runs and reports its failure", async () => {
    installRegistry([texture(0)]);
    let failDuplicate!: (error: Error) => void;
    const duplicateAsset = vi.fn(() => new Promise<IndexedAsset>((_resolve, reject) => { failDuplicate = reject; }));
    docs.assetRegistry = { ...(docs.assetRegistry as object), duplicateAsset };
    render(<ContentBrowserWorkspace />);
    fireEvent.contextMenu(screen.getByTestId("content-item-assets/tex-0.hasset"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect(screen.getByTestId("content-browser-import").hasAttribute("disabled")).toBe(true));
    await act(async () => { failDuplicate(new Error("Asset already exists: assets/tex-0_1.hasset")); });
    expect(await screen.findByText("Asset already exists: assets/tex-0_1.hasset")).toBeTruthy();
    expect(screen.getByTestId("content-browser-import").hasAttribute("disabled")).toBe(false);
  });
  it("retries only the remaining items after a partially completed copy", async () => {
    installRegistry([texture(0), texture(1)], ["Characters"]);
    const copied: string[] = [];
    let failed = false;
    docs.assetRegistry = { ...(docs.assetRegistry as object), copyAsset: async (guid: string) => {
      if (guid === "tex-1" && !failed) { failed = true; throw new Error("Storage busy"); }
      copied.push(guid);
      return texture(copied.length);
    } };
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.hasset"));
    fireEvent.click(screen.getByTestId("content-item-assets/tex-1.hasset"), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByTestId("content-item-assets/tex-1.hasset"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy to Folder…" }));
    const destination = within(screen.getByTestId("content-browser-move-dialog")).getByTestId("tree-row-assets/Characters");
    tapTreeRow(destination);
    fireEvent.click(screen.getByTestId("content-browser-move-confirm"));
    expect(await screen.findByText(/Storage busy/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("content-browser-move-confirm"));
    await waitFor(() => expect(screen.queryByTestId("content-browser-move-dialog")).toBeNull());
    expect(copied).toEqual(["tex-0", "tex-1"]);
  });
  it("keeps the chosen move destination after a failure so the move can be retried", async () => {
    const asset = texture(0);
    installRegistry([asset], ["Characters"]);
    const moveAsset = vi.fn().mockRejectedValueOnce(new Error("Destination is locked")).mockImplementation(async () => {
      asset.path = "assets/Characters/tex-0.hasset";
      return asset;
    });
    docs.assetRegistry = { ...(docs.assetRegistry as object), moveAsset };
    render(<ContentBrowserWorkspace />);
    fireEvent.contextMenu(screen.getByTestId("content-item-assets/tex-0.hasset"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move…" }));
    const destination = within(screen.getByTestId("content-browser-move-dialog")).getByTestId("tree-row-assets/Characters");
    tapTreeRow(destination);
    fireEvent.click(screen.getByTestId("content-browser-move-confirm"));
    expect(await screen.findByText("Destination is locked")).toBeTruthy();
    expect(screen.getByTestId("content-browser-move-destination").textContent).toContain("assets/Characters");
    fireEvent.click(screen.getByTestId("content-browser-move-confirm"));
    await waitFor(() => expect(screen.queryByTestId("content-browser-move-dialog")).toBeNull());
    expect(asset.path).toBe("assets/Characters/tex-0.hasset");
  });

  it("repairs open paths and refreshes a successful rename even when the lock transfer fails", async () => {
    const asset = texture(0);
    installRegistry([asset]);
    const renamed = { ...asset, path: "assets/Renamed.texture.hasset" };
    docs.assetRegistry = { ...(docs.assetRegistry as object), renameAsset: vi.fn(async () => renamed) };
    docs.sourceControl.enabled = true;
    docs.sourceControl.lockStateForPath.mockReturnValue("mine");
    docs.sourceControl.transferLock.mockImplementation(async () => {
      expect(docs.repathDocument).toHaveBeenCalledWith("texture", asset.path, renamed.path);
      expect(docs.refreshAssetRegistry).toHaveBeenCalled();
      throw new Error("Lock service unavailable");
    });
    render(<ContentBrowserWorkspace />);
    fireEvent.contextMenu(screen.getByTestId(`content-item-${asset.path}`));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByTestId("content-browser-name-input"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("content-browser-name-confirm"));
    expect(await screen.findByText("Lock service unavailable")).toBeTruthy();
    expect(docs.sourceControl.transferLock).toHaveBeenCalledWith(asset.path, renamed.path);
    expect(screen.queryByTestId("content-browser-name-dialog")).toBeNull();
  });

  it("replaces an unrelated selection before a context-menu delete", async () => {
    installRegistry([texture(0), texture(1)], ["Characters"]);
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-folder-assets/Characters"));
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.hasset"), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByTestId("content-item-assets/tex-1.hasset"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const list = screen.getByTestId("content-browser-delete-list");
    expect(list.textContent).toContain("tex-1");
    expect(list.textContent).not.toContain("tex-0");
    expect(list.textContent).not.toContain("Characters");
  });

  it("offers folder Rename after an unrelated asset selection and submits it with Enter", async () => {
    installRegistry([texture(0)], ["Characters"]);
    const moveFolder = vi.fn().mockResolvedValue(undefined);
    docs.assetRegistry = { ...(docs.assetRegistry as object), moveFolder };
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.hasset"));
    fireEvent.contextMenu(screen.getByTestId("content-folder-assets/Characters"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByTestId("content-browser-name-input");
    fireEvent.change(input, { target: { value: "Heroes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("content-browser-name-dialog")).toBeNull());
    expect(moveFolder).toHaveBeenCalledWith("project", "Characters", "", "Heroes");
    expect(docs.repathProjectFolder).toHaveBeenCalledWith("assets/Characters", "assets/Heroes");
  });

  it("rewrites project settings that name a folder when the folder moves", async () => {
    installRegistry([], ["Characters", "Archive"]);
    const moveFolder = vi.fn().mockResolvedValue(undefined);
    docs.assetRegistry = { ...(docs.assetRegistry as object), moveFolder };
    render(<ContentBrowserWorkspace />);
    fireEvent.contextMenu(screen.getByTestId("content-folder-assets/Characters"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move…" }));
    tapTreeRow(within(screen.getByTestId("content-browser-move-dialog")).getByTestId("tree-row-assets/Archive"));
    fireEvent.click(screen.getByTestId("content-browser-move-confirm"));
    await waitFor(() => expect(screen.queryByTestId("content-browser-move-dialog")).toBeNull());
    expect(moveFolder).toHaveBeenCalledWith("project", "Characters", "Archive");
    expect(docs.repathProjectFolder).toHaveBeenCalledWith("assets/Characters", "assets/Archive/Characters");
  });

  it("leaves project settings alone when a folder move fails", async () => {
    installRegistry([], ["Characters", "Archive"]);
    const moveFolder = vi.fn().mockRejectedValue(new Error("Folder is locked"));
    docs.assetRegistry = { ...(docs.assetRegistry as object), moveFolder };
    render(<ContentBrowserWorkspace />);
    fireEvent.contextMenu(screen.getByTestId("content-folder-assets/Characters"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move…" }));
    tapTreeRow(within(screen.getByTestId("content-browser-move-dialog")).getByTestId("tree-row-assets/Archive"));
    fireEvent.click(screen.getByTestId("content-browser-move-confirm"));
    expect(await screen.findByText("Folder is locked")).toBeTruthy();
    expect(docs.repathProjectFolder).not.toHaveBeenCalled();
  });

  it("renames an asset inline from a tree label double-tap", async () => {
    const asset = texture(0);
    installRegistry([asset]);
    const renameAsset = vi.fn(async () => ({ ...asset, path: "assets/Renamed.hasset" }));
    docs.assetRegistry = { ...(docs.assetRegistry as object), renameAsset };
    render(<ContentBrowserWorkspace />);
    const tree = screen.getByTestId("content-browser-folder-tree");
    const label = within(tree).getByTestId(`tree-row-${asset.path}`).querySelector("[data-tree-label]")!;
    tapTreeRow(label, "touch");
    tapTreeRow(label, "touch");
    expect(docs.openDocument).not.toHaveBeenCalled();
    const input = within(tree).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("tex-0");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(renameAsset).toHaveBeenCalledWith(asset.header.guid, "Renamed"));
  });

  it("renames the selected asset with F2 once its clicked tile has focus", async () => {
    const asset = texture(0);
    installRegistry([asset]);
    render(<KeybindProvider><ContentBrowserWorkspace /></KeybindProvider>);
    const tile = screen.getByTestId(`content-item-${asset.path}`);
    fireEvent.click(tile);
    // A browser click focuses the tile: still inside the workspace's focus gate.
    tile.focus();
    fireEvent.keyDown(tile, { key: "F2", code: "F2" });
    expect(await screen.findByTestId("content-browser-name-dialog")).toBeTruthy();
    expect((screen.getByTestId("content-browser-name-input") as HTMLInputElement).value).toBe("tex-0");
  });

  it("opens the selected asset from the toolbar Open action", async () => {
    installRegistry([texture(0)]);
    render(<ContentBrowserWorkspace />);
    expect(screen.queryByTestId("content-browser-open-selected")).toBeNull();
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.hasset"));
    expect(screen.getByTestId("content-browser-deselect-all").textContent).toBe("Deselect");
    fireEvent.click(screen.getByTestId("content-browser-open-selected"));
    await waitFor(() =>
      expect(docs.openDocument).toHaveBeenCalledWith({ kind: "texture", path: "assets/tex-0.hasset", label: "Tex 0" }),
    );
  });

  it("rejects duplicate typed asset names before submitting a rename", () => {
    const assets = [texture(0), texture(1)];
    assets[0]!.path = "assets/Hero.class.hasset";
    assets[0]!.header.name = "Hero.class";
    assets[1]!.path = "assets/Villain.class.hasset";
    installRegistry(assets);
    const renameAsset = vi.fn();
    docs.assetRegistry = { ...(docs.assetRegistry as object), renameAsset };
    render(<ContentBrowserWorkspace />);
    fireEvent.contextMenu(screen.getByTestId(`content-item-${assets[0]!.path}`));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByTestId("content-browser-name-input") as HTMLInputElement;
    expect(input.value).toBe("Hero");
    fireEvent.change(input, { target: { value: "Villain" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("content-browser-name-confirm").hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameAsset).not.toHaveBeenCalled();
  });

  it("validates a single folder name and creates in the viewed folder with Enter", async () => {
    installRegistry([], ["Characters"]);
    const createFolder = vi.fn().mockResolvedValue(undefined);
    docs.assetRegistry = { ...(docs.assetRegistry as object), createFolder };
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-folder-assets/Characters"));
    fireEvent.click(screen.getByTestId("content-browser-new-folder"));
    const input = screen.getByTestId("content-browser-name-input");
    for (const name of ["..", "a/b", "a\\b", ""]) {
      fireEvent.change(input, { target: { value: name } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByTestId("content-browser-name-confirm").hasAttribute("disabled")).toBe(true);
    }
    expect(createFolder).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Hero 🤖 Ünïcødé" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("content-browser-name-dialog")).toBeNull());
    expect(createFolder).toHaveBeenCalledWith("project", "Hero 🤖 Ünïcødé");
  });

  it("refuses a Class name whose class id another Class uses, in New Asset and Rename", () => {
    const rain = texture(0);
    rain.path = "assets/Weather/Rain_Weather.class.hasset";
    rain.header = { ...rain.header, type: "Class", name: "Rain_Weather", guid: "rain" };
    const hero = texture(1);
    hero.path = "assets/Hero.class.hasset";
    hero.header = { ...hero.header, type: "Class", name: "Hero", guid: "hero" };
    installRegistry([rain, hero], ["Weather"]);
    const renameAsset = vi.fn();
    docs.assetRegistry = { ...(docs.assetRegistry as object), renameAsset };
    render(<ContentBrowserWorkspace />);
    const taken = 'Another Class already uses the class id "Rain_Weather".';

    fireEvent.click(screen.getByTestId("content-browser-new-asset"));
    fireEvent.click(screen.getByTestId("search-item-Class"));
    fireEvent.change(screen.getByTestId("new-asset-name"), { target: { value: "Rain-Weather" } });
    expect(screen.getByTestId("new-asset-name-taken").textContent).toBe(taken);
    expect(screen.getByTestId("content-browser-new-asset-create").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.contextMenu(screen.getByTestId(`content-item-${hero.path}`));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByTestId("content-browser-name-input");
    fireEvent.change(input, { target: { value: "Rain Weather" } });
    expect(screen.getByTestId("content-browser-name-taken").textContent).toBe(taken);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameAsset).not.toHaveBeenCalled();
  });

  it("retains the new asset draft when the storage write fails", async () => {
    installRegistry([]);
    docs.assetRegistry = { ...(docs.assetRegistry as object), createAsset: vi.fn().mockRejectedValue(new Error("Project storage unavailable")) };
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-browser-new-asset"));
    fireEvent.click(screen.getByTestId("search-item-Scene"));
    const input = screen.getByTestId("new-asset-name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Main Scene" } });
    fireEvent.click(screen.getByTestId("content-browser-new-asset-create"));
    expect(await screen.findByText("Project storage unavailable")).toBeTruthy();
    expect(input.value).toBe("Main Scene");
    expect(screen.getByTestId("content-browser-new-asset-create").hasAttribute("disabled")).toBe(false);
  });

  it("shows a partial import summary without losing the successful assets", async () => {
    const assets: IndexedAsset[] = [];
    installRegistry(assets);
    docs.assetRegistry = { ...(docs.assetRegistry as object), importFile: vi.fn().mockImplementation(async (_root: string, _folder: string, name: string) => {
      if (name === "broken.png") throw new Error("Unsupported image");
      const asset = texture(0);
      assets.push(asset);
      return [asset];
    }) };
    render(<ContentBrowserWorkspace />);
    const files = ["good.png", "broken.png"].map((name) => {
      const file = new File([new Uint8Array([1])], name);
      Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1]).buffer });
      return file;
    });
    fireEvent.change(screen.getByTestId("content-browser-import-input"), { target: { files } });
    expect(await screen.findByText("Import Partially Completed")).toBeTruthy();
    expect(screen.getByTestId("import-result-summary").textContent).toMatch(/1.*imported/i);
    expect(screen.getByText(/broken.png: Unsupported image/)).toBeTruthy();
    expect(assets).toHaveLength(1);
  });

  it("opens the connected reference graph focused on the target and navigates to a selected asset", async () => {
    const asset = texture(0);
    const dependency = texture(1);
    asset.header.dependencies = [dependency.header.guid];
    installRegistry([asset, dependency]);
    render(<ContentBrowserWorkspace />);
    fireEvent.contextMenu(screen.getByTestId("content-item-assets/tex-0.hasset"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show References" }));
    const dialog = screen.getByTestId("content-browser-refs-dialog");
    const root = within(dialog).getByTestId("asset-reference-node-tex-0");
    await waitFor(() => expect(root.getAttribute("data-selected")).toBe("true"));
    expect(within(dialog).queryByTestId("graph-add-node")).toBeNull();
    fireEvent.click(within(dialog).getByTestId("asset-reference-node-tex-1"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Open Asset" }));
    await waitFor(() => expect(docs.openDocument).toHaveBeenCalledWith({ kind: "texture", path: "assets/tex-1.hasset", label: "Tex 1" }));
  });
  it("preserves a folder name and explains a failed create so it can be retried", async () => {
    installRegistry([]);
    const createFolder = vi.fn().mockRejectedValueOnce(new Error("Storage is read-only")).mockResolvedValue(undefined);
    docs.assetRegistry = { ...(docs.assetRegistry as object), createFolder };
    render(<ContentBrowserWorkspace />);
    fireEvent.click(await screen.findByTestId("content-browser-new-folder"));
    const input = screen.getByTestId("content-browser-name-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Characters" } });
    fireEvent.click(screen.getByTestId("content-browser-name-confirm"));
    expect(await screen.findByText("Storage is read-only")).toBeTruthy();
    expect(input.value).toBe("Characters");
    expect(screen.getByTestId("content-browser-name-confirm").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByTestId("content-browser-name-confirm"));
    await waitFor(() => expect(screen.queryByTestId("content-browser-name-input")).toBeNull());
    expect(createFolder).toHaveBeenLastCalledWith("project", "Characters");
  });
  it("navigates back to Content with the location bar after opening a folder", async () => {
    installRegistry([], ["Characters"]);
    render(<ContentBrowserWorkspace />);
    fireEvent.doubleClick(await screen.findByTestId("content-folder-assets/Characters"));
    const location = await screen.findByRole("navigation", { name: "Folder Location" });
    expect(location.querySelector('[aria-current="page"]')?.textContent).toBe("Characters");
    fireEvent.click(screen.getByRole("button", { name: "Parent Folder" }));
    expect(await screen.findByTestId("content-folder-assets/Characters")).toBeTruthy();
    expect(location.querySelector('[aria-current="page"]')?.textContent).toBe("Content");
    expect(screen.getByRole("button", { name: "Parent Folder" }).hasAttribute("disabled")).toBe(true);
  });

  it("enters a selected folder with Enter, as the Open action does", async () => {
    installRegistry([], ["Characters"]);
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-folder-assets/Characters"));
    fireEvent.keyDown(screen.getByTestId("content-browser-asset-grid"), { key: "Enter" });
    const location = await screen.findByRole("navigation", { name: "Folder Location" });
    expect(location.querySelector('[aria-current="page"]')?.textContent).toBe("Characters");
  });

  it("disables the empty-grid New Folder, New Asset and Import in a read-only root", () => {
    docs.thumbnailsEnabled = false;
    docs.showPluginContent = true;
    const plugin = {
      pluginGuid: "starter", source: "engine", folderName: "starter", readOnly: true,
      folderPath: "plugins/starter", contentPath: "plugins/starter/assets",
      settingsPath: "plugins/starter/starter.plugin.hasset",
      settings: { ...createDefaultPluginSettings({ pluginGuid: "starter", displayName: "Starter" }), enabledByDefault: true },
    };
    docs.pluginDescriptors = [plugin];
    const root = projectContentRoot();
    docs.assetRegistry = {
      getRoot: (id: string) => id === "project" ? root : { ...root, id, pathPrefix: plugin.contentPath, readOnly: true },
      list: () => [],
      folderTree: (id: string) => ({ name: "assets", path: id === "project" ? "assets" : plugin.contentPath, children: [], assets: [] }),
    };
    render(<ContentBrowserWorkspace />);
    tapTreeRow(screen.getByTestId("tree-row-plugins/starter/assets"));
    fireEvent.contextMenu(screen.getByTestId("content-browser-asset-grid"));
    for (const id of ["new-folder", "new-asset", "import"]) {
      expect((screen.getByTestId(`context-menu-item-${id}`) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("clears an unsuccessful search without leaving the current folder", async () => {
    installRegistry([texture(1)]);
    render(<ContentBrowserWorkspace />);
    fireEvent.change(screen.getByTestId("content-browser-search"), { target: { value: "missing" } });
    fireEvent.click(await screen.findByRole("button", { name: "Clear Filters" }));
    expect((screen.getByTestId("content-browser-search") as HTMLInputElement).value).toBe("");
    expect(await screen.findByTestId("content-item-assets/tex-1.hasset")).toBeTruthy();
  });

  beforeEach(() => {
    docs.repairAfterAssetDelete.mockReset().mockResolvedValue(undefined);
    installRegistry(Array.from({ length: 80 }, (_, index) => texture(index)));
  });

  it("blocks editing with progress until deletion and reference cleanup finish", async () => {
    docs.thumbnailsEnabled = false;
    installRegistry([texture(0)]);
    let finishDelete!: () => void;
    let finishRepair!: () => void;
    const deleting = new Promise<void>((resolve) => { finishDelete = resolve; });
    const repairing = new Promise<void>((resolve) => { finishRepair = resolve; });
    const deleteAsset = vi.fn(() => deleting);
    Object.assign(docs.assetRegistry as object, { deleteAsset });
    docs.repairAfterAssetDelete.mockImplementation(() => repairing);
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.hasset"));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));

    const progress = screen.getByRole("dialog", { name: "Deleting Assets" });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    expect(deleteAsset).not.toHaveBeenCalled();
    fireEvent.keyDown(progress, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Deleting Assets" })).toBeTruthy();
    await waitFor(() => expect(deleteAsset).toHaveBeenCalledWith("tex-0"));

    await act(async () => { finishDelete(); });
    await waitFor(() => expect(docs.repairAfterAssetDelete).toHaveBeenCalled());
    expect(screen.getByRole("dialog", { name: "Deleting Assets" }).textContent).toContain("Updating References");
    await act(async () => { finishRepair(); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Deleting Assets" })).toBeNull());
    expect((screen.getByTestId("content-browser-new-asset") as HTMLButtonElement).disabled).toBe(false);
  });

  it("unblocks editing and reports a deletion failure", async () => {
    docs.thumbnailsEnabled = false;
    installRegistry([texture(0)]);
    Object.assign(docs.assetRegistry as object, {
      deleteAsset: async () => { throw new Error("Storage unavailable"); },
    });
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.hasset"));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));
    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "Delete Failed" })).toBeTruthy());
    expect(screen.getByRole("alertdialog", { name: "Delete Failed" }).textContent).toContain("Storage unavailable");
    expect(screen.queryByRole("dialog", { name: "Deleting Assets" })).toBeNull();
  });

  it("refreshes the project after deleting an empty folder", async () => {
    docs.thumbnailsEnabled = false;
    installRegistry([], ["Empty"]);
    Object.assign(docs.assetRegistry as object, { deleteFolder: async () => {} });
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-folder-assets/Empty"));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));
    await waitFor(() => expect(docs.repairAfterAssetDelete).toHaveBeenCalledWith(
      new Set(), new Set(), expect.any(Function), ["assets/Empty"],
    ));
  });

  it("repairs only removed Class assets when a later deletion fails", async () => {
    docs.thumbnailsEnabled = false;
    const textureAsset = texture(0);
    const classAsset = texture(1);
    textureAsset.header.name = "Enemy";
    classAsset.header.name = "Enemy";
    classAsset.header.type = "Class";
    installRegistry([textureAsset, classAsset]);
    Object.assign(docs.assetRegistry as object, {
      deleteAsset: async (guid: string) => {
        if (guid === "tex-1") throw new Error("Class is locked");
      },
    });
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.hasset"));
    fireEvent.click(screen.getByTestId("content-item-assets/tex-1.hasset"), { ctrlKey: true });
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));
    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "Delete Failed" })).toBeTruthy());
    expect(docs.repairAfterAssetDelete).toHaveBeenCalledWith(new Set(["tex-0"]), new Set(), expect.any(Function), []);
  });

  it("keeps the tabs of assets a failed deletion did not reach", async () => {
    docs.thumbnailsEnabled = false;
    docs.closeDocumentsForPaths.mockClear();
    installRegistry([texture(0), texture(1), texture(2)]);
    Object.assign(docs.assetRegistry as object, {
      deleteAsset: async (guid: string) => {
        if (guid === "tex-1") throw new Error("Storage unavailable");
      },
    });
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.hasset"));
    fireEvent.click(screen.getByTestId("content-item-assets/tex-1.hasset"), { ctrlKey: true });
    fireEvent.click(screen.getByTestId("content-item-assets/tex-2.hasset"), { ctrlKey: true });
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));
    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "Delete Failed" })).toBeTruthy());
    const closed = docs.closeDocumentsForPaths.mock.calls.flatMap(([paths]) => [...paths as Iterable<string>]);
    expect(closed).toContain("assets/tex-0.hasset");
    expect(closed).not.toContain("assets/tex-2.hasset");
  });

  it("repairs a deleted Class by its compile id, not its display name", async () => {
    docs.thumbnailsEnabled = false;
    const classAsset = texture(0);
    classAsset.path = "assets/Rain-Weather.class.hasset";
    classAsset.header = { ...classAsset.header, type: "Class", name: "Actor", guid: "rain" };
    installRegistry([classAsset]);
    Object.assign(docs.assetRegistry as object, { deleteAsset: async () => {} });
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId(`content-item-${classAsset.path}`));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));
    await waitFor(() => expect((screen.getByTestId("content-browser-delete-confirm") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));
    await waitFor(() => expect(docs.repairAfterAssetDelete).toHaveBeenCalledWith(
      new Set(["rain"]), new Set(["Rain_Weather"]), expect.any(Function), [],
    ));
  });

  it("mounts no tiles while hidden and shows the current folder again when visible", () => {
    docs.thumbnailsEnabled = false;
    stubGridSize(
      CONTENT_BROWSER_GRID_PAD_PX * 2 +
        CONTENT_BROWSER_TILE_WIDTH_PX * 4 +
        CONTENT_BROWSER_GRID_GAP_PX * 3,
      CONTENT_BROWSER_GRID_PAD_PX * 2 +
        CONTENT_BROWSER_TILE_HEIGHT_PX * 2 +
        CONTENT_BROWSER_GRID_GAP_PX,
    );
    const textures = Array.from({ length: 300 }, (_, index) => texture(index));
    installRegistry(textures);
    const tiles = () => document.querySelectorAll("[data-asset-path]");
    const { rerender } = render(<ContentBrowserWorkspace />);
    expect(tiles().length).toBeGreaterThan(0);

    rerender(<ContentBrowserWorkspace hidden />);
    expect(tiles()).toHaveLength(0);

    // A registry change while hidden appears once the browser is shown.
    const added = { ...texture(0), path: "assets/added.hasset" };
    added.header = { ...added.header, guid: "added", name: "added" };
    installRegistry([added, ...textures]);
    rerender(<ContentBrowserWorkspace hidden />);
    expect(tiles()).toHaveLength(0);

    rerender(<ContentBrowserWorkspace />);
    expect(screen.getByTestId("content-item-assets/added.hasset")).toBeTruthy();
    expect(screen.getByTestId("content-item-assets/tex-0.hasset")).toBeTruthy();
    expect(screen.queryByTestId("content-item-assets/tex-299.hasset")).toBeNull();
  });

  it("badges a Texture as Encoding when its encode starts, though its indexed header did not change", () => {
    docs.thumbnailsEnabled = false;
    const assets = [texture(0), texture(1)];
    installRegistry(assets);
    const { rerender } = render(<ContentBrowserWorkspace />);
    expect(screen.queryByTestId("texture-compression-tex-0")).toBeNull();

    // An encode runs in memory: only the registry epoch and the running set tell the grid.
    docs.encodingTextures = new Set(["tex-0"]);
    docs.registryEpoch += 1;
    rerender(<ContentBrowserWorkspace />);
    expect(screen.getByTestId("texture-compression-tex-0").textContent).toBe("Encoding");
    expect(screen.queryByTestId("texture-compression-tex-1")).toBeNull();

    docs.encodingTextures = new Set();
    docs.registryEpoch += 1;
    rerender(<ContentBrowserWorkspace />);
    expect(screen.queryByTestId("texture-compression-tex-0")).toBeNull();
  });

  it("filters the sorted grid in full sort order, including name ties", () => {
    docs.thumbnailsEnabled = false;
    const named = (guid: string, name: string, path: string): IndexedAsset => {
      const asset = { ...texture(0), path };
      asset.header = { ...asset.header, guid, name };
      return asset;
    };
    installRegistry([
      named("guid-b", "Rock", "assets/Rock.hasset"),
      named("guid-e", "Pebble", "assets/pebble.hasset"),
      named("guid-f", "Rockface", "assets/Rockface.hasset"),
      named("guid-a", "rock", "assets/rock-2.hasset"),
      named("guid-c", "Rock.png", "assets/Rock-png.hasset"),
      named("guid-d", "Boulder", "assets/boulder-rock.hasset"),
    ]);
    render(<ContentBrowserWorkspace />);
    const order = () =>
      Array.from(document.querySelectorAll("[data-asset-guid]"), (tile) =>
        tile.getAttribute("data-asset-guid"),
      );
    expect(order()).toEqual(["guid-d", "guid-e", "guid-a", "guid-b", "guid-c", "guid-f"]);

    fireEvent.change(screen.getByTestId("content-browser-search"), {
      target: { value: "ROCK" },
    });
    // "Rock" and "rock" tie on name and fall back to guid; "Rock.png" shows
    // as "Rock" but its full name sorts after them.
    expect(order()).toEqual(["guid-d", "guid-a", "guid-b", "guid-c", "guid-f"]);
  });

  it("shows thumbnails a batch at a time while the later ones are still loading", async () => {
    const assets = Array.from({ length: 6 }, (_, index) => texture(index));
    installRegistry(assets);
    const stalled = new Promise<Uint8Array>(() => {});
    // The first batch of four reads at once; the rest never finishes.
    loadAssetThumbnail.mockImplementation((guid) =>
      Number(guid.slice("tex-".length)) < 4
        ? Promise.resolve(new Uint8Array([137, 80, 78, 71]))
        : stalled);
    let sequence = 0;
    const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:batch-${++sequence}`);
    const imageFor = (asset: IndexedAsset) =>
      screen.getByTestId(`content-item-${asset.path}`).querySelector("img");
    try {
      render(<ContentBrowserWorkspace />);
      await waitFor(() => expect(imageFor(assets[3]!)).not.toBeNull());
      expect(imageFor(assets[0]!)).not.toBeNull();
      expect(imageFor(assets[4]!)).toBeNull();
      expect(imageFor(assets[5]!)).toBeNull();
    } finally {
      createUrl.mockRestore();
      loadAssetThumbnail.mockResolvedValue(new Uint8Array([1, 2, 3]));
    }
  });

  it("reads thumbnails once for changes that arrive together instead of once per change", async () => {
    installRegistry([texture(0)]);
    const { rerender } = render(<ContentBrowserWorkspace />);
    await waitFor(() => expect(loadAssetThumbnail).toHaveBeenCalledTimes(1));
    loadAssetThumbnail.mockClear();

    // Two captures land back to back, as a scroll changes the mounted tiles row after row.
    docs.thumbnailVersions = { "tex-0": 1 };
    rerender(<ContentBrowserWorkspace />);
    docs.thumbnailVersions = { "tex-0": 2 };
    rerender(<ContentBrowserWorkspace />);

    await waitFor(() => expect(loadAssetThumbnail).toHaveBeenCalledWith("tex-0"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(loadAssetThumbnail).toHaveBeenCalledTimes(1);
  });

  it("does not decode thumbnails while CSS-hidden", async () => {
    loadAssetThumbnail.mockClear();
    render(<ContentBrowserWorkspace hidden />);
    await Promise.resolve();
    await Promise.resolve();
    expect(loadAssetThumbnail).not.toHaveBeenCalled();
  });

  it("generates only explicitly selected thumbnails without capturing merely browsed assets", async () => {
    const selected = [texture(0), texture(1)];
    selected[0]!.header.type = "Material";
    selected[1]!.header.type = "Class";
    selected[1]!.header.parentClass = "Actor";
    const unselected = texture(2);
    unselected.header.type = "Model";
    installRegistry([...selected, unselected]);
    loadAssetThumbnail.mockResolvedValue(null);
    const jobs: ModelThumbnailJob[] = [];
    const unsubscribe = subscribeModelThumbnailJobs((batch) => jobs.push(...batch));
    try {
      render(<ContentBrowserWorkspace />);
      await waitFor(() => expect(loadAssetThumbnail).toHaveBeenCalledWith(unselected.header.guid));
      expect(jobs).toEqual([]);
      fireEvent.click(screen.getByTestId(`content-item-${selected[0]!.path}`));
      fireEvent.click(screen.getByTestId(`content-item-${selected[1]!.path}`), { ctrlKey: true });
      fireEvent.contextMenu(screen.getByTestId(`content-item-${selected[1]!.path}`));
      fireEvent.click(screen.getByRole("menuitem", { name: "Generate Thumbnails" }));
      await waitFor(() => expect(jobs).toHaveLength(2));
      expect(jobs.map(({ guid }) => guid)).toEqual(selected.map(({ header }) => header.guid));
      expect(jobs.every((job) => job.projectGuid === docs.projectGuid && job.cacheKey?.includes(".preview-v1."))).toBe(true);
    } finally {
      unsubscribe();
      loadAssetThumbnail.mockResolvedValue(new Uint8Array([1, 2, 3]));
    }
  });

  it.each([["Model", "Animation"], ["Material", "Class"]])("shows %s and %s thumbnails when capture finishes, then replaces recaptures", async (firstType, secondType) => {
    const model = texture(0);
    model.header.type = firstType!;
    const animation = texture(1);
    animation.header.type = secondType!;
    if (secondType === "Class") animation.header.parentClass = "Actor";
    installRegistry([model, animation]);
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL");
    let available = false;
    let sequence = 0;
    createUrl.mockImplementation(() => `blob:thumbnail-${++sequence}`);
    loadAssetThumbnail.mockImplementation(async () => available ? new Uint8Array([137, 80, 78, 71]) : null);
    try {
      const { rerender } = render(<ContentBrowserWorkspace />);
      await waitFor(() => expect(loadAssetThumbnail).toHaveBeenCalledWith(animation.header.guid));
      expect(screen.getByTestId(`content-item-${model.path}`).querySelector("img")).toBeNull();
      available = true;
      docs.thumbnailVersions = { [model.header.guid]: 1, [animation.header.guid]: 1 };
      rerender(<ContentBrowserWorkspace />);
      await waitFor(() => expect(screen.getByTestId(`content-item-${animation.path}`).querySelector("img")).not.toBeNull());
      const oldUrl = screen.getByTestId(`content-item-${model.path}`).querySelector("img")!.getAttribute("src");
      let srcWhenRevoked: string | null | undefined;
      revokeUrl.mockImplementation((url) => {
        if (url === oldUrl) {
          srcWhenRevoked = screen.getByTestId(`content-item-${model.path}`).querySelector("img")?.getAttribute("src");
        }
      });
      docs.thumbnailVersions = { ...docs.thumbnailVersions, [model.header.guid]: 2 };
      rerender(<ContentBrowserWorkspace />);
      await waitFor(() => {
        const image = screen.getByTestId(`content-item-${model.path}`).querySelector("img");
        expect(image).not.toBeNull();
        expect(image!.getAttribute("src")).not.toBe(oldUrl);
      });
      // The replaced URL is revoked once the new one has rendered, not while the old image still shows it.
      await waitFor(() => expect(revokeUrl).toHaveBeenCalledWith(oldUrl));
      expect(srcWhenRevoked).toBeTruthy();
      expect(srcWhenRevoked).not.toBe(oldUrl);
    } finally {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      loadAssetThumbnail.mockResolvedValue(new Uint8Array([1, 2, 3]));
    }
  });

  it("keeps existing images mounted through consecutive captures and a delayed replacement", async () => {
    const model = texture(0);
    model.header.type = "Model";
    const animation = texture(1);
    animation.header.type = "Animation";
    const unchanged = texture(2);
    installRegistry([model, animation, unchanged]);
    let sequence = 0;
    const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:stable-${++sequence}`);
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL");
    const imageFor = (path: string) => screen.getByTestId(`content-item-${path}`).querySelector("img");
    try {
      const { rerender } = render(<ContentBrowserWorkspace />);
      await waitFor(() => expect(imageFor(unchanged.path)).not.toBeNull());
      const modelImage = imageFor(model.path)!;
      const modelUrl = modelImage.getAttribute("src");
      const animationImage = imageFor(animation.path)!;
      const animationUrl = animationImage.getAttribute("src");
      const textureImage = imageFor(unchanged.path)!;
      const textureUrl = textureImage.getAttribute("src");
      let resolveReplacement!: (bytes: Uint8Array) => void;
      const replacement = new Promise<Uint8Array>((resolve) => { resolveReplacement = resolve; });
      loadAssetThumbnail.mockImplementation((guid) => guid === model.header.guid
        ? replacement : Promise.resolve(new Uint8Array([1, 2, 3])));
      loadAssetThumbnail.mockClear();
      docs.thumbnailVersions = { [model.header.guid]: 1 };
      rerender(<ContentBrowserWorkspace />);
      await waitFor(() => expect(loadAssetThumbnail).toHaveBeenCalledWith(model.header.guid));
      expect(imageFor(model.path)).toBe(modelImage);
      expect(modelImage.getAttribute("src")).toBe(modelUrl);
      expect(imageFor(animation.path)).toBe(animationImage);
      expect(animationImage.getAttribute("src")).toBe(animationUrl);
      expect(revokeUrl).not.toHaveBeenCalled();

      // Another completion supersedes the pending refresh without blanking any tile.
      docs.thumbnailVersions = { ...docs.thumbnailVersions, [animation.header.guid]: 1 };
      rerender(<ContentBrowserWorkspace />);
      expect(imageFor(model.path)).toBe(modelImage);
      expect(modelImage.getAttribute("src")).toBe(modelUrl);
      expect(imageFor(unchanged.path)).toBe(textureImage);
      await act(async () => { resolveReplacement(new Uint8Array([137, 80, 78, 71])); });
      await waitFor(() => expect(modelImage.getAttribute("src")).not.toBe(modelUrl));
      expect(imageFor(animation.path)).toBe(animationImage);
      expect(animationImage.getAttribute("src")).not.toBe(animationUrl);
      expect(imageFor(unchanged.path)).toBe(textureImage);
      expect(textureImage.getAttribute("src")).toBe(textureUrl);
      expect(loadAssetThumbnail).not.toHaveBeenCalledWith(unchanged.header.guid);
      await waitFor(() => {
        expect(revokeUrl).toHaveBeenCalledWith(modelUrl);
        expect(revokeUrl).toHaveBeenCalledWith(animationUrl);
      });
      expect(revokeUrl).not.toHaveBeenCalledWith(textureUrl);
    } finally {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      loadAssetThumbnail.mockResolvedValue(new Uint8Array([1, 2, 3]));
    }
  });

  it("abandons a deferred thumbnail when a newer capture replaces it", async () => {
    const model = texture(0);
    model.header.type = "Model";
    installRegistry([model]);
    let resolveOld!: (bytes: Uint8Array) => void;
    const oldLoad = new Promise<Uint8Array>((resolve) => { resolveOld = resolve; });
    loadAssetThumbnail.mockImplementationOnce(() => oldLoad);
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:current");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL");
    try {
      const { rerender } = render(<ContentBrowserWorkspace />);
      await waitFor(() => expect(loadAssetThumbnail).toHaveBeenCalledWith(model.header.guid));
      docs.thumbnailVersions = { [model.header.guid]: 1 };
      rerender(<ContentBrowserWorkspace />);
      await waitFor(() => {
        expect(screen.getByTestId(`content-item-${model.path}`).querySelector("img")?.getAttribute("src")).toBe("blob:current");
      });
      await act(async () => { resolveOld(new Uint8Array([1, 2, 3])); });
      expect(createUrl).toHaveBeenCalledTimes(1);
      expect(revokeUrl).not.toHaveBeenCalledWith("blob:current");
      expect(screen.getByTestId(`content-item-${model.path}`).querySelector("img")?.getAttribute("src")).toBe("blob:current");
    } finally {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });

  it("uses an on-demand folder drawer on phones and returns to the chosen folder", async () => {
    layout.phone = true;
    docs.thumbnailsEnabled = false;
    const nested = { ...texture(1), path: "assets/Textures/tex-1.hasset" };
    installRegistry([texture(0), nested], ["Textures"]);
    render(<ContentBrowserWorkspace />);

    expect(screen.queryByTestId("content-browser-folder-tree")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Browse Folders" }));
    expect(screen.getByRole("dialog", { name: "Folders" })).toBeTruthy();
    const folder = screen.getByTestId("tree-row-assets/Textures");
    tapTreeRow(folder, "touch");

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Folders" })).toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "Browse Folders" }).textContent,
    ).toContain("Textures");
    expect(
      screen.getByTestId("content-item-assets/Textures/tex-1.hasset"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("content-item-assets/tex-0.hasset"),
    ).toBeNull();
  });

  it("extends a keyboard range in the tree from the row where it started", () => {
    docs.thumbnailsEnabled = false;
    installRegistry([texture(0), texture(1), texture(2)]);
    render(<ContentBrowserWorkspace />);
    const tree = screen.getByTestId("content-browser-folder-tree");
    tapTreeRow(screen.getByTestId("tree-row-assets/tex-1.hasset"));
    fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(tree, { key: "ArrowUp", shiftKey: true });

    const selected = (index: number) =>
      screen.getByTestId(`content-item-assets/tex-${index}.hasset`).getAttribute("data-selected");
    expect([selected(0), selected(1), selected(2)]).toEqual(["false", "true", "false"]);
  });

  it("keeps folder navigation alongside assets on larger screens", () => {
    docs.thumbnailsEnabled = false;
    render(<ContentBrowserWorkspace />);
    expect(screen.getByTestId("content-browser-folder-tree")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Browse Folders" })).toBeNull();
  });

  it("restores the folder pane when a phone window widens", () => {
    // StrictMode re-registers the returning pane after the assets pane; the
    // resizable group must not keep that order and crash on its separator.
    layout.phone = true;
    docs.thumbnailsEnabled = false;
    const { rerender } = render(<StrictMode><ContentBrowserWorkspace /></StrictMode>);
    layout.phone = false;
    rerender(<StrictMode><ContentBrowserWorkspace /></StrictMode>);
    expect(screen.getByTestId("content-browser-folder-tree")).toBeTruthy();
  });

  it("dismisses folder navigation when the Content Browser becomes hidden", async () => {
    layout.phone = true;
    docs.thumbnailsEnabled = false;
    const { rerender } = render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Browse Folders" }));
    expect(screen.getByRole("dialog", { name: "Folders" })).toBeTruthy();
    rerender(<ContentBrowserWorkspace hidden />);
    rerender(<ContentBrowserWorkspace />);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Folders" })).toBeNull();
    });
  });

  it("does not offer Open for an asset without a document editor", () => {
    layout.phone = true;
    docs.thumbnailsEnabled = false;
    const mesh = texture(0);
    mesh.header.type = "Mesh";
    installRegistry([mesh]);
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.hasset"));
    expect(screen.queryByRole("button", { name: "Open Selected Item" })).toBeNull();
    expect(screen.getByTestId("content-browser-delete-selected")).toBeTruthy();
  });

  it("offers a direct Open action for the selected asset on phones", async () => {
    layout.phone = true;
    docs.thumbnailsEnabled = false;
    installRegistry([texture(0)]);
    render(<ContentBrowserWorkspace />);

    expect(
      screen.queryByRole("button", { name: "Open Selected Item" }),
    ).toBeNull();
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.hasset"));
    fireEvent.click(screen.getByRole("button", { name: "Open Selected Item" }));

    await waitFor(() =>
      expect(docs.openDocument).toHaveBeenCalledWith({
        kind: "texture",
        path: "assets/tex-0.hasset",
        label: "Tex 0",
      }),
    );
    fireEvent.click(screen.getByTestId("content-browser-deselect-all"));
    expect(
      screen.queryByRole("button", { name: "Open Selected Item" }),
    ).toBeNull();
  });
});

describe("ContentBrowserWorkspace creating assets", () => {
  /**
   * A real registry over memory storage. `noteAssetsCreated` advances the epoch
   * and re-renders as the provider does, so what the grid and dialogs show
   * after a create is exactly what the mounted registry indexed on write.
   */
  async function mountProject() {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("test.hproject");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    docs.assetRegistry = registry;
    docs.thumbnailsEnabled = false;
    const view = render(<ContentBrowserWorkspace />);
    docs.noteAssetsCreated.mockImplementation(() => {
      docs.registryEpoch += 1;
      act(() => view.rerender(<ContentBrowserWorkspace />));
    });
    return registry;
  }

  async function createAsset(type: string, name: string) {
    fireEvent.click(screen.getByTestId("content-browser-new-asset"));
    fireEvent.click(screen.getByTestId(`search-item-${type}`));
    fireEvent.change(screen.getByTestId("new-asset-name"), { target: { value: name } });
    fireEvent.click(screen.getByTestId("content-browser-new-asset-create"));
    await waitFor(() => expect(screen.queryByTestId("content-browser-new-asset-dialog")).toBeNull());
  }

  it("lists a created Class and offers it as a parent without remounting the registry", async () => {
    await mountProject();
    await createAsset("Class", "Hero");

    expect(await screen.findByTestId("content-item-assets/Hero.class.hasset")).toBeTruthy();
    fireEvent.click(screen.getByTestId("content-browser-new-asset"));
    fireEvent.click(screen.getByTestId("search-item-Class"));
    expect(screen.getByTestId("tree-row-Hero")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(docs.noteAssetsCreated).toHaveBeenCalledTimes(1);
    expect(docs.refreshAssetRegistry).not.toHaveBeenCalled();
  });

  it("picks the type from a menu opened by double-tapping empty grid space", async () => {
    await mountProject();
    fireEvent.doubleClick(screen.getByTestId("content-browser-asset-grid"), { clientX: 120, clientY: 80 });
    expect(screen.queryByTestId("content-browser-new-asset-dialog")).toBeNull();
    fireEvent.change(screen.getByTestId("new-asset-type-menu-query"), { target: { value: "water" } });
    fireEvent.click(screen.getByTestId("search-item-Water"));
    await waitFor(() => expect(screen.queryByTestId("new-asset-type-menu")).toBeNull());
    expect(screen.getByTestId("new-asset-type-description").textContent).toMatch(/water appearance/);
    fireEvent.change(screen.getByTestId("new-asset-name"), { target: { value: "Lagoon" } });
    fireEvent.click(screen.getByTestId("content-browser-new-asset-create"));
    expect(await screen.findByTestId("content-item-assets/Lagoon.water.hasset")).toBeTruthy();
  });

  it("opens a created Scene without remounting the registry", async () => {
    await mountProject();
    await createAsset("Scene", "Level");

    await waitFor(() =>
      expect(docs.openDocument).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "scene", path: "assets/Level.scene.hasset" }),
      ),
    );
    expect(docs.refreshAssetRegistry).not.toHaveBeenCalled();
  });

  it("enters a new folder and lists a Material Instance beside its parent without remounting the registry", async () => {
    const registry = await mountProject();
    fireEvent.click(screen.getByTestId("content-browser-new-folder"));
    fireEvent.change(screen.getByTestId("content-browser-name-input"), { target: { value: "Looks" } });
    fireEvent.click(screen.getByTestId("content-browser-name-confirm"));
    const location = await screen.findByRole("navigation", { name: "Folder Location" });
    await waitFor(() => expect(location.querySelector('[aria-current="page"]')?.textContent).toBe("Looks"));
    expect(screen.getByTestId("tree-row-assets/Looks")).toBeTruthy();

    await createAsset("Material", "Rock");
    const rock = registry.list().find((asset) => asset.header.name === "Rock")!;
    fireEvent.contextMenu(await screen.findByTestId(`content-item-${rock.path}`));
    fireEvent.click(screen.getByRole("menuitem", { name: "Create Material Instance" }));

    await waitFor(() => expect(registry.list().some((asset) => asset.header.type === "MaterialInstance")).toBe(true));
    const instance = registry.list().find((asset) => asset.header.type === "MaterialInstance")!;
    expect(instance.path.startsWith("assets/Looks/")).toBe(true);
    expect(await screen.findByTestId(`content-item-${instance.path}`)).toBeTruthy();
    expect(docs.noteAssetsCreated).toHaveBeenCalledTimes(3);
    expect(docs.refreshAssetRegistry).not.toHaveBeenCalled();
  });
});
