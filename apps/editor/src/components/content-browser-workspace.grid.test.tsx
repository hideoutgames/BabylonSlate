import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { IndexedAsset } from "@babylonslate/assets";
import { projectContentRoot } from "@babylonslate/assets";
import { ContentBrowserWorkspace } from "./content-browser-workspace";
import {
  CONTENT_BROWSER_GRID_GAP_PX,
  CONTENT_BROWSER_GRID_PAD_PX,
  CONTENT_BROWSER_TILE_HEIGHT_PX,
  CONTENT_BROWSER_TILE_WIDTH_PX,
} from "../lib/content-browser-grid";

const { docs, loadAssetThumbnail, layout } = vi.hoisted(() => {
  const loadAssetThumbnail = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const docs = {
    projectDocument: { settings: {
      pluginOverrides: {},
      gameInstanceClass: null as string | null,
      editorUtilityObjects: [] as string[],
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
  layout.phone = false;
  docs.openDocument.mockClear();
  docs.openDocuments = [];
  docs.projectDocument.settings.gameInstanceClass = null;
  docs.projectDocument.settings.editorUtilityObjects = [];
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
});

describe("ContentBrowserWorkspace grid window", () => {
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
