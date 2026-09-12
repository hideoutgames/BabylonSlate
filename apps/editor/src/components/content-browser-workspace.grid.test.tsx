import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { IndexedAsset } from "@babylonslate/assets";
import { createDefaultPluginSettings, projectContentRoot } from "@babylonslate/assets";
import { ContentBrowserWorkspace } from "./content-browser-workspace";
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
    projectDocument: { settings: {
      pluginOverrides: {},
      gameInstanceClass: null as string | null,
      editorUtilityObjects: [] as string[],
      startupSceneGuid: "",
    } },
    assetRegistry: null as unknown,
    registryVersion: 1,
    refreshAssetRegistry: vi.fn(),
    repathDocument: vi.fn(),
    openDocument: vi.fn(),
    closeDocumentsForPaths: vi.fn(),
    repairAfterAssetDelete: vi.fn(async () => {}),
    replaceClassReferencesBeforeDelete: vi.fn(async () => {}),
    openDocuments: [] as unknown[],
    setActiveDocument: vi.fn(),
    tabOrder: [] as string[],
    loadAssetThumbnail,
    loadAssetDocument: vi.fn(async () => ({})),
    thumbnailsEnabled: true,
    thumbnailVersions: {} as Record<string, number>,
    pluginDescriptors: [] as unknown[],
    showPluginContent: false,
    sourceControl: {
      enabled: false,
      requestRefresh: vi.fn(),
      lockStateForPath: () => null,
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

vi.mock("../context/document-context", () => ({
  useDocuments: () => docs,
}));

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
    path: `assets/tex-${index}.babasset`,
    header: {
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
  layout.phone = false;
  docs.openDocument.mockClear();
  docs.openDocuments = [];
  docs.pluginDescriptors = [];
  docs.showPluginContent = false;
  docs.projectDocument.settings.gameInstanceClass = null;
  docs.projectDocument.settings.editorUtilityObjects = [];
  docs.projectDocument.settings.startupSceneGuid = "";
  docs.loadAssetDocument.mockReset().mockResolvedValue({});
  docs.replaceClassReferencesBeforeDelete.mockReset().mockResolvedValue(undefined);
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
    actorClass.path = `${folder}/Hero.class.babasset`;
    actorClass.header = { ...actorClass.header, type: "Class", name: "Hero", guid: "hero" };
    const scene = texture(1);
    scene.path = "assets/main.scene.babasset";
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

  it("requires a second confirmation for a folder containing a Class used by a closed legacy scene", async () => {
    const { actorClass, scene } = classAndScene("assets/Actors");
    docs.loadAssetDocument.mockResolvedValue({ actors: [{ classId: "Hero" }] });
    installRegistry([actorClass, scene], ["Actors"]);
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-folder-assets/Actors"));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));

    await waitFor(() => {
      expect(screen.getByTestId("content-browser-delete-dialog").textContent).toContain("main");
    });
    expect((screen.getByTestId("content-browser-delete-confirm") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));
    expect(screen.getByTestId("content-browser-delete-references-confirmation")).toBeTruthy();
  });

  it("allows deleting a folder when its Class referrers are also selected for deletion", async () => {
    const { actorClass, scene } = classAndScene("assets/Actors");
    scene.path = "assets/Actors/main.scene.babasset";
    scene.header.dependencies = ["hero"];
    installRegistry([actorClass, scene], ["Actors"]);
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-folder-assets/Actors"));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));

    await waitFor(() => {
      expect((screen.getByTestId("content-browser-delete-confirm") as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("keeps referenced material deletion available", () => {
    const { actorClass: material, scene } = classAndScene();
    material.header.type = "Material";
    scene.header.dependencies = ["hero"];
    installRegistry([material, scene]);
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId(`content-item-${material.path}`));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));

    expect(screen.getByTestId("content-browser-delete-dialog").textContent).toContain("main");
    expect((screen.getByTestId("content-browser-delete-confirm") as HTMLButtonElement).disabled).toBe(false);
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
    const replacement = { ...actorClass, path: "assets/NPC.class.babasset", header: { ...actorClass.header, guid: "npc", name: "NPC" } };
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

  it("also confirms twice when the deleted asset is the project startup scene", () => {
    const { scene } = classAndScene();
    docs.projectDocument.settings.startupSceneGuid = scene.header.guid;
    installRegistry([scene]);
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId(`content-item-${scene.path}`));
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));
    expect(screen.getByTestId("content-browser-delete-dialog").textContent).toContain("Project Settings");
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));
    expect(screen.getByTestId("content-browser-delete-references-confirmation")).toBeTruthy();
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
      settingsPath: "plugins/tools/tools.plugin.babasset",
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

    fireEvent.pointerDown(base, { pointerId: 1, pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(base, { pointerId: 1, pointerType: "mouse", button: 0 });
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
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.babasset"));
    fireEvent.click(screen.getByTestId("content-item-assets/tex-1.babasset"), { ctrlKey: true });
    fireEvent.contextMenu(screen.getByTestId("content-item-assets/tex-1.babasset"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy to Folder…" }));
    const destination = within(screen.getByTestId("content-browser-move-dialog")).getByTestId("tree-row-assets/Characters");
    fireEvent.pointerDown(destination, { clientX: 8, clientY: 8 });
    fireEvent.pointerUp(destination, { clientX: 8, clientY: 8 });
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
      asset.path = "assets/Characters/tex-0.babasset";
      return asset;
    });
    docs.assetRegistry = { ...(docs.assetRegistry as object), moveAsset };
    render(<ContentBrowserWorkspace />);
    fireEvent.contextMenu(screen.getByTestId("content-item-assets/tex-0.babasset"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move…" }));
    const destination = within(screen.getByTestId("content-browser-move-dialog")).getByTestId("tree-row-assets/Characters");
    fireEvent.pointerDown(destination, { clientX: 8, clientY: 8 });
    fireEvent.pointerUp(destination, { clientX: 8, clientY: 8 });
    fireEvent.click(screen.getByTestId("content-browser-move-confirm"));
    expect(await screen.findByText("Destination is locked")).toBeTruthy();
    expect(screen.getByTestId("content-browser-move-destination").textContent).toContain("assets/Characters");
    fireEvent.click(screen.getByTestId("content-browser-move-confirm"));
    await waitFor(() => expect(screen.queryByTestId("content-browser-move-dialog")).toBeNull());
    expect(asset.path).toBe("assets/Characters/tex-0.babasset");
  });

  it("retains the new asset draft when the storage write fails", async () => {
    installRegistry([]);
    docs.assetRegistry = { ...(docs.assetRegistry as object), createAsset: vi.fn().mockRejectedValue(new Error("Project storage unavailable")) };
    render(<ContentBrowserWorkspace />);
    fireEvent.click(screen.getByTestId("content-browser-new-asset"));
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

  it("opens an asset directly from the references dialog", async () => {
    const asset = texture(0);
    const dependency = texture(1);
    asset.header.dependencies = [dependency.header.guid];
    installRegistry([asset, dependency]);
    render(<ContentBrowserWorkspace />);
    fireEvent.contextMenu(screen.getByTestId("content-item-assets/tex-0.babasset"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show References" }));
    fireEvent.click(screen.getByRole("button", { name: "tex-1" }));
    await waitFor(() => expect(docs.openDocument).toHaveBeenCalledWith({ kind: "asset-settings", path: "assets/tex-1.babasset", label: "Tex 1" }));
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

  it("clears an unsuccessful search without leaving the current folder", async () => {
    installRegistry([texture(1)]);
    render(<ContentBrowserWorkspace />);
    fireEvent.change(screen.getByTestId("content-browser-search"), { target: { value: "missing" } });
    fireEvent.click(await screen.findByRole("button", { name: "Clear Filters" }));
    expect((screen.getByTestId("content-browser-search") as HTMLInputElement).value).toBe("");
    expect(await screen.findByTestId("content-item-assets/tex-1.babasset")).toBeTruthy();
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
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.babasset"));
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
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.babasset"));
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
      new Set(), new Set(), expect.any(Function),
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
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.babasset"));
    fireEvent.click(screen.getByTestId("content-item-assets/tex-1.babasset"), { ctrlKey: true });
    fireEvent.click(screen.getByTestId("content-browser-delete-selected"));
    fireEvent.click(screen.getByTestId("content-browser-delete-confirm"));
    await waitFor(() => expect(screen.getByRole("alertdialog", { name: "Delete Failed" })).toBeTruthy());
    expect(docs.repairAfterAssetDelete).toHaveBeenCalledWith(new Set(["tex-0"]), new Set(), expect.any(Function));
  });

  it("mounts only viewport-near tiles for a large folder", () => {
    docs.thumbnailsEnabled = false;
    stubGridSize(
      CONTENT_BROWSER_GRID_PAD_PX * 2 +
        CONTENT_BROWSER_TILE_WIDTH_PX * 4 +
        CONTENT_BROWSER_GRID_GAP_PX * 3,
      CONTENT_BROWSER_GRID_PAD_PX * 2 +
        CONTENT_BROWSER_TILE_HEIGHT_PX * 2 +
        CONTENT_BROWSER_GRID_GAP_PX,
    );
    installRegistry(Array.from({ length: 300 }, (_, index) => texture(index)));
    render(<ContentBrowserWorkspace />);
    const tiles = document.querySelectorAll('[data-testid^="content-item-"]');
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(80);
    expect(
      document.querySelector(
        '[data-testid="content-item-assets/tex-0.babasset"]',
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '[data-testid="content-item-assets/tex-299.babasset"]',
      ),
    ).toBeNull();
  });

  it("does not decode thumbnails while CSS-hidden", async () => {
    loadAssetThumbnail.mockClear();
    render(<ContentBrowserWorkspace hidden />);
    await Promise.resolve();
    await Promise.resolve();
    expect(loadAssetThumbnail).not.toHaveBeenCalled();
  });

  it("shows Model and Animation thumbnails when background capture finishes, then replaces recaptures", async () => {
    const model = texture(0);
    model.header.type = "Model";
    const animation = texture(1);
    animation.header.type = "Animation";
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
      docs.thumbnailVersions = { ...docs.thumbnailVersions, [model.header.guid]: 2 };
      rerender(<ContentBrowserWorkspace />);
      await waitFor(() => {
        const image = screen.getByTestId(`content-item-${model.path}`).querySelector("img");
        expect(image).not.toBeNull();
        expect(image!.getAttribute("src")).not.toBe(oldUrl);
      });
      expect(revokeUrl).toHaveBeenCalledWith(oldUrl);
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
      expect(revokeUrl).toHaveBeenCalledWith(modelUrl);
      expect(revokeUrl).toHaveBeenCalledWith(animationUrl);
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
    const nested = { ...texture(1), path: "assets/Textures/tex-1.babasset" };
    installRegistry([texture(0), nested], ["Textures"]);
    render(<ContentBrowserWorkspace />);

    expect(screen.queryByTestId("content-browser-folder-tree")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Browse Folders" }));
    expect(screen.getByRole("dialog", { name: "Folders" })).toBeTruthy();
    const folder = screen.getByTestId("tree-row-assets/Textures");
    fireEvent.pointerDown(folder, {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
    });
    fireEvent.pointerUp(folder, {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Folders" })).toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "Browse Folders" }).textContent,
    ).toContain("Textures");
    expect(
      screen.getByTestId("content-item-assets/Textures/tex-1.babasset"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("content-item-assets/tex-0.babasset"),
    ).toBeNull();
  });

  it("keeps folder navigation alongside assets on larger screens", () => {
    docs.thumbnailsEnabled = false;
    render(<ContentBrowserWorkspace />);
    expect(screen.getByTestId("content-browser-folder-tree")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Browse Folders" })).toBeNull();
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
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.babasset"));
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
    fireEvent.click(screen.getByTestId("content-item-assets/tex-0.babasset"));
    fireEvent.click(screen.getByRole("button", { name: "Open Selected Item" }));

    await waitFor(() =>
      expect(docs.openDocument).toHaveBeenCalledWith({
        kind: "asset-settings",
        path: "assets/tex-0.babasset",
        label: "Tex 0",
      }),
    );
    fireEvent.click(screen.getByTestId("content-browser-deselect-all"));
    expect(
      screen.queryByRole("button", { name: "Open Selected Item" }),
    ).toBeNull();
  });
});
