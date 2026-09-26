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
    ],
    applyAssetDocumentChange,
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
});

describe("AssetDocumentWorkspace authoring", () => {
  it("reports an unavailable font source instead of claiming the preview is ready", async () => {
    readAssetChunk.mockResolvedValueOnce(new Uint8Array());
    render(<AssetDocumentWorkspace documentId="font:assets/Display.font.babasset" />);
    expect(await screen.findByText("Font Preview Unavailable")).toBeTruthy();
    expect(screen.getByTestId("font-sample-preview").getAttribute("data-fonts-ready")).toBe("false");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No fallback glyphs detected")).toBeNull();
  });
  it("removes its preview font face from the document when the Font document closes", async () => {
    const faces = new Set<unknown>();
    vi.stubGlobal("FontFace", class {
      family: string;
      constructor(family: string) { this.family = family; }
    });
    const fonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        add: (face: unknown) => faces.add(face),
        delete: (face: unknown) => faces.delete(face),
        load: async () => [],
        check: () => true,
      },
    });
    try {
      const { unmount } = render(<AssetDocumentWorkspace documentId="font:assets/Display.font.babasset" />);
      await vi.waitFor(() => {
        expect(screen.getByTestId("font-sample-preview").getAttribute("data-fonts-ready")).toBe("true");
      });
      expect(faces.size).toBe(1);
      unmount();
      expect(faces.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      if (fonts) Object.defineProperty(document, "fonts", fonts);
      else delete (document as { fonts?: unknown }).fonts;
    }
  });
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

  it("lists Font representations and an Import MSDF Atlas action", () => {
    render(<AssetDocumentWorkspace documentId="font:assets/Display.font.babasset" />);
    expect(screen.getByTestId("font-representations")).toBeTruthy();
    expect(screen.getByTestId("font-rep-source").textContent).toMatch(/Missing|No/);
    expect(screen.getByTestId("font-rep-msdf-json").textContent).toMatch(/Missing/);
    expect(screen.getByTestId("font-rep-msdf-atlas").textContent).toMatch(/Missing/);
    expect(screen.getByTestId("font-import-msdf")).toBeTruthy();
  });

});
