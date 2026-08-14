import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createFontPayload } from "@babylonslate/assets";
import { AssetDocumentWorkspace } from "./asset-document-workspace";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const applyAssetDocumentChange = vi.hoisted(() => vi.fn(async () => true));
const retryTextureEncoding = vi.hoisted(() => vi.fn(async () => true));
const readAssetChunk = vi.hoisted(() =>
  vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
);

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "font:assets/Display.font.babasset",
        ref: {
          kind: "font",
          path: "assets/Display.font.babasset",
          label: "Display Font",
        },
        content: createFontPayload("Display"),
        layout: null,
        dirty: false,
      },
      {
        id: "asset-settings:assets/Stats.structure.babasset",
        ref: {
          kind: "asset-settings",
          path: "assets/Stats.structure.babasset",
          label: "Stats",
        },
        content: {
          kind: "structure",
          guid: "s1",
          name: "Stats",
          fields: [{ name: "Health", typeId: "float" }],
        },
        layout: null,
        dirty: false,
      },
      {
        id: "asset-settings:assets/albedo.babasset",
        ref: {
          kind: "asset-settings",
          path: "assets/albedo.babasset",
          label: "albedo",
        },
        content: { usage: "albedo", compressionState: "pending" },
        layout: null,
        dirty: false,
      },
      {
        id: "asset-settings:assets/sprite.babasset",
        ref: {
          kind: "asset-settings",
          path: "assets/sprite.babasset",
          label: "sprite",
        },
        content: { usage: "pixelArt", compressionState: "none" },
        layout: null,
        dirty: false,
      },
    ],
    applyAssetDocumentChange,
    retryTextureEncoding,
    projectDocument: {
      settings: {
        fonts: { defaultFontGuid: null, globalFallback: "sans-serif" },
        textures: { maxTextureDimension: 2048 },
      },
    },
    assetRegistry: {
      list: () => [
        {
          header: {
            guid: "font-1",
            name: "Display",
            type: "Font",
            payload: { family: "Display" },
          },
          path: "assets/Display.font.babasset",
        },
        {
          header: {
            guid: "font-2",
            name: "Body",
            type: "Font",
            payload: { family: "Body" },
          },
          path: "assets/Body.font.babasset",
        },
        {
          header: { guid: "s1", name: "Stats", type: "Structure", payload: {} },
          path: "assets/Stats.structure.babasset",
        },
        {
          header: {
            guid: "tex-albedo",
            name: "albedo",
            type: "Texture",
            payload: { usage: "albedo" },
          },
          path: "assets/albedo.babasset",
        },
        {
          header: {
            guid: "tex-sprite",
            name: "sprite",
            type: "Texture",
            payload: { usage: "pixelArt" },
          },
          path: "assets/sprite.babasset",
        },
      ],
      getByGuid: (guid: string) =>
        guid === "font-2"
          ? {
              header: {
                guid: "font-2",
                name: "Body",
                type: "Font",
                payload: { family: "Body" },
              },
              path: "assets/Body.font.babasset",
            }
          : undefined,
    },
    readAssetChunk,
  }),
}));

afterEach(() => {
  cleanup();
  applyAssetDocumentChange.mockClear();
  retryTextureEncoding.mockClear();
});

describe("AssetDocumentWorkspace authoring", () => {
  it("picks Font fallbacks instead of typing guids", async () => {
    render(<AssetDocumentWorkspace documentId="font:assets/Display.font.babasset" />);
    fireEvent.click(screen.getByTestId("font-fallbacks-add"));
    expect(await screen.findByTestId("search-item-font-2")).toBeTruthy();
    expect(screen.queryByTestId("search-item-font-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-font-2"));
    expect(applyAssetDocumentChange).toHaveBeenCalledWith(
      "font:assets/Display.font.babasset",
      expect.objectContaining({ fallbackGuids: ["font-2"] }),
      undefined,
    );
  });

  it("shows a Texture preview and Max Dimension without extra filter toggles", () => {
    render(
      <AssetDocumentWorkspace documentId="asset-settings:assets/albedo.babasset" />,
    );
    expect(screen.getByTestId("texture-preview")).toBeTruthy();
    expect(screen.getByTestId("property-maxDimension")).toBeTruthy();
    expect(screen.getByTestId("property-usage")).toBeTruthy();
    expect(screen.queryByTestId("property-mipmap")).toBeNull();
    expect(screen.queryByTestId("property-nearest")).toBeNull();
  });

  it("shows a Texture preview for Pixel Art without encode controls beyond Usage", () => {
    render(
      <AssetDocumentWorkspace documentId="asset-settings:assets/sprite.babasset" />,
    );
    expect(screen.getByTestId("texture-preview")).toBeTruthy();
    expect(screen.getByTestId("property-maxDimension")).toBeTruthy();
    expect(screen.getByTestId("property-usage")).toBeTruthy();
  });
});
