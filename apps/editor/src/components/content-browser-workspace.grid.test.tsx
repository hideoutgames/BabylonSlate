import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { IndexedAsset } from "@babylonslate/assets";
import { projectContentRoot } from "@babylonslate/assets";
import { ContentBrowserWorkspace } from "./content-browser-workspace";
import {
  CONTENT_BROWSER_GRID_GAP_PX,
  CONTENT_BROWSER_GRID_PAD_PX,
  CONTENT_BROWSER_TILE_HEIGHT_PX,
  CONTENT_BROWSER_TILE_WIDTH_PX,
} from "../lib/content-browser-grid";

const { docs, loadAssetThumbnail } = vi.hoisted(() => {
  const loadAssetThumbnail = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const docs = {
    projectDocument: { settings: { pluginOverrides: {} } },
    assetRegistry: null as unknown,
    registryVersion: 1,
    refreshAssetRegistry: vi.fn(),
    repathDocument: vi.fn(),
    openDocument: vi.fn(),
    openDocuments: [] as unknown[],
    setActiveDocument: vi.fn(),
    tabOrder: [] as string[],
    loadAssetThumbnail,
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
  return { docs, loadAssetThumbnail };
});

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

function installRegistry(assets: IndexedAsset[]) {
  const root = projectContentRoot();
  docs.assetRegistry = {
    getRoot: (id: string) => (id === "project" ? root : undefined),
    list: () => assets,
    folderTree: () => ({
      name: "assets",
      path: "assets",
      children: [],
      assets: assets.map((asset) => asset.header.guid),
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
  if (clientWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidthDescriptor);
  }
  if (clientHeightDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientHeight",
      clientHeightDescriptor,
    );
  }
});

describe("ContentBrowserWorkspace grid window", () => {
  beforeEach(() => {
    installRegistry(Array.from({ length: 80 }, (_, index) => texture(index)));
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
      document.querySelector('[data-testid="content-item-assets/tex-0.babasset"]'),
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
});
