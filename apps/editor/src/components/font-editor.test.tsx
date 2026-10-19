import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createFontPayload } from "@babylonslate/assets";
import { FontInspector, FontPreview } from "./font-editor";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const applyAssetDocumentChange = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
const fontHarness = vi.hoisted(() => ({
  content: null as Record<string, unknown> | null,
  importFile: vi.fn(async () => {}),
  pickImportFiles: vi.fn(async (): Promise<Array<{ name: string; bytes: Uint8Array }>> => []),
}));

vi.mock("@babylonslate/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babylonslate/vfs")>()),
  pickImportFiles: fontHarness.pickImportFiles,
}));
const readAssetChunk = vi.hoisted(() =>
  vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
);

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [
    {
      id: "font:assets/Display.font.babasset",
      ref: {
        kind: "font",
        path: "assets/Display.font.babasset",
        label: "Display Font",
      },
      content: fontHarness.content ?? createFontPayload("Display"),
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
        : guid === "font-1"
          ? {
              // A saved Font's header after an MSDF attach: the payload lives
              // in the document chunk, so only the attached flags are here.
              header: {
                guid: "font-1",
                name: "Display",
                type: "Font",
                payload: {
                  family: "Display",
                  representations: { msdfJson: true, msdfPng: true },
                },
              },
              path: "assets/Display.font.babasset",
            }
          : undefined,
    importFile: fontHarness.importFile,
  },
  readAssetChunk,
})));

afterEach(() => {
  cleanup();
  applyAssetDocumentChange.mockClear();
  fontHarness.content = null;
  fontHarness.importFile.mockClear();
  fontHarness.pickImportFiles.mockReset();
  fontHarness.pickImportFiles.mockResolvedValue([]);
});

const PATH = "assets/Display.font.babasset";
const payload = () => (fontHarness.content ?? createFontPayload("Display")) as unknown as Record<string, unknown>;
const commit = (next: Record<string, unknown>) => void applyAssetDocumentChange("font:assets/Display.font.babasset", next, undefined);

describe("Font editor", () => {
  it("reports an unavailable font source instead of claiming the preview is ready", async () => {
    readAssetChunk.mockResolvedValueOnce(new Uint8Array());
    render(<FontPreview path={PATH} payload={payload()} />);
    expect(await screen.findByText("Font Preview Unavailable")).toBeTruthy();
    expect(screen.getByTestId("font-sample-preview").getAttribute("data-fonts-ready")).toBe("false");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No fallback glyphs detected")).toBeNull();
  });
  it("removes its preview font face from the document when the Font document closes", async () => {
    const faces = new Set<unknown>();
    // FontRegistry waits on each registered face's own load().
    vi.stubGlobal("FontFace", class {
      family: string;
      constructor(family: string) { this.family = family; }
      load() { return Promise.resolve(this); }
    });
    const fonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        add: (face: unknown) => faces.add(face),
        delete: (face: unknown) => faces.delete(face),
      },
    });
    try {
      const { unmount } = render(<FontPreview path={PATH} payload={payload()} />);
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
    render(<FontInspector path={PATH} payload={payload()} onChange={commit} />);
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
  it("keeps the open Font's source and fallbacks when an MSDF atlas attaches", async () => {
    fontHarness.content = createFontPayload("Display", {
      fallbackGuids: ["font-2"],
      representations: { source: true },
    }) as unknown as Record<string, unknown>;
    fontHarness.pickImportFiles.mockResolvedValueOnce([
      { name: "Display.json", bytes: new TextEncoder().encode('{"chars":[],"common":{}}') },
      { name: "Display.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    render(<FontInspector path={PATH} payload={payload()} onChange={commit} />);
    fireEvent.click(screen.getByTestId("font-import-msdf"));
    await vi.waitFor(() => expect(applyAssetDocumentChange).toHaveBeenCalled());
    expect(fontHarness.importFile).toHaveBeenCalledWith(
      undefined,
      expect.any(String),
      "Display.json",
      expect.anything(),
      expect.objectContaining({ attachToGuid: "font-1" }),
    );
    expect(applyAssetDocumentChange).toHaveBeenLastCalledWith(
      "font:assets/Display.font.babasset",
      expect.objectContaining({
        fallbackGuids: ["font-2"],
        representations: expect.objectContaining({ source: true, msdf: true }),
      }),
      undefined,
    );
  });
});
