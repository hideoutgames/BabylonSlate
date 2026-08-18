import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { EditorUtilityPanel } from "./editor-utility-panel";

const { createUiSurfaceMock, createHostMock, play } = vi.hoisted(() => ({
  createUiSurfaceMock: vi.fn(),
  createHostMock: vi.fn(),
  play: {
    ensureSharedEngine: () => ({}),
    sharedEngineGeneration: 1,
  },
}));

const docs = vi.hoisted(() => ({
  assetRegistry: {
    list: () => [
      {
        path: "assets/Tools.eui.babasset",
        header: { guid: "tools-guid", type: "EditorUtilityInterface" },
      },
    ],
  },
  openDocuments: [] as Array<{ ref: { path: string }; content: unknown }>,
  loadAssetDocument: vi.fn(async () => ({
    rootId: "canvas",
    widgets: { canvas: { id: "canvas", kind: "Canvas", children: [] } },
  })),
}));

vi.mock("@babylonslate/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/render")>();
  return {
    ...actual,
    createUiSurface: (...args: unknown[]) => createUiSurfaceMock(...args),
  };
});

vi.mock("../context/document-context", () => ({
  useDocuments: () => docs,
}));

vi.mock("../context/play-context", () => ({
  useOptionalPlay: () => play,
}));

vi.mock("../lib/editor-utility-interface-runtime", () => ({
  bindEditorUtilityWidgetEvent: vi.fn(),
  collectNestedUtilityLogicSources: () => [],
  nestedUtilitySlots: () => [],
  compileEditorUtilityInterfaceLogic: () => [],
  createEditorUtilityInterfaceHost: (...args: unknown[]) =>
    createHostMock(...args),
}));

afterEach(() => {
  cleanup();
  createUiSurfaceMock.mockReset();
  createHostMock.mockReset();
  docs.loadAssetDocument.mockClear();
  docs.openDocuments = [];
});

describe("EditorUtilityPanel", () => {
  it("creates an interactive surface and ignores a cancelled stale load", async () => {
    createUiSurfaceMock.mockReturnValue({
      present: vi.fn(),
      setFrozen: vi.fn(),
      dispose: vi.fn(),
      host: {
        measureControls: () => ({}),
        clear: vi.fn(),
        addControl: vi.fn(),
        markAsDirty: vi.fn(),
        setVisible: vi.fn(),
      },
      resizeDesign: vi.fn(),
      resizeGizmos: vi.fn(),
      presentGizmos: vi.fn(),
      designAdt: { markAsDirty: vi.fn() },
      gizmoAdt: null,
    });
    const beginPlay = vi.fn();
    const tick = vi.fn();
    createHostMock.mockReturnValue({
      loadAll: async () => {},
      beginPlay,
      tick,
      dispose: vi.fn(),
      host: { classIds: () => [], invokeEvent: vi.fn() },
    });
    render(
      <EditorUtilityPanel
        api={
          {
            id: "eui-tools-guid",
            isVisible: true,
            onDidVisibilityChange: () => ({ dispose: () => {} }),
          } as never
        }
        containerApi={{} as never}
        params={{}}
      />,
    );
    expect(await screen.findByTestId("editor-utility-panel")).toBeTruthy();
    expect(screen.getByTestId("editor-utility-canvas")).toBeTruthy();
    expect(createUiSurfaceMock).not.toHaveBeenCalled();
    await waitFor(() => expect(createUiSurfaceMock).toHaveBeenCalled());
    const options = createUiSurfaceMock.mock.calls[0]?.[2] as {
      interactive?: boolean;
      resolveImageUrl?: (guid: string) => string | null;
    };
    expect(options.interactive).toBe(true);
    expect(typeof options.resolveImageUrl).toBe("function");
    await waitFor(() => expect(beginPlay).toHaveBeenCalled());
    expect(tick).not.toHaveBeenCalled();
  });

  it("collects nested UserInterface image guids for the live utility surface", async () => {
    docs.openDocuments = [
      {
        ref: { path: "assets/Tools.eui.babasset" },
        content: {
          rootId: "canvas",
          widgets: {
            canvas: { id: "canvas", kind: "Canvas", children: ["host"] },
            host: {
              id: "host",
              kind: "UserInterface",
              nestedUiGuid: "chip-guid",
              children: [],
            },
          },
        },
      },
    ];
    const list = docs.assetRegistry.list;
    docs.assetRegistry.list = () => [
      ...list(),
      {
        path: "assets/Chip.ui.babasset",
        header: {
          guid: "chip-guid",
          type: "UserInterface",
          payload: {
            rootId: "canvas",
            widgets: {
              canvas: { id: "canvas", kind: "Canvas", children: ["art"] },
              art: {
                id: "art",
                kind: "Image",
                children: [],
                props: { imageGuid: "tex-nested" },
              },
            },
          },
        },
      },
      {
        path: "assets/Icon.texture.babasset",
        header: {
          guid: "tex-nested",
          type: "Texture",
          chunks: [{ id: "pixels" }],
        },
      },
    ];
    createUiSurfaceMock.mockReturnValue({
      present: vi.fn(),
      setFrozen: vi.fn(),
      dispose: vi.fn(),
      host: {
        measureControls: () => ({}),
        clear: vi.fn(),
        addControl: vi.fn(),
        markAsDirty: vi.fn(),
        setVisible: vi.fn(),
      },
      resizeDesign: vi.fn(),
      resizeGizmos: vi.fn(),
      presentGizmos: vi.fn(),
      designAdt: { markAsDirty: vi.fn() },
      gizmoAdt: null,
    });
    createHostMock.mockReturnValue({
      loadAll: async () => {},
      beginPlay: vi.fn(),
      tick: vi.fn(),
      dispose: vi.fn(),
      host: { classIds: () => [], invokeEvent: vi.fn() },
    });
    render(
      <EditorUtilityPanel
        api={
          {
            id: "eui-tools-guid",
            isVisible: true,
            onDidVisibilityChange: () => ({ dispose: () => {} }),
          } as never
        }
        containerApi={{} as never}
        params={{}}
      />,
    );
    await waitFor(() => expect(createUiSurfaceMock).toHaveBeenCalled());
    try {
      expect(await screen.findByTestId("ui-image-issue")).toBeTruthy();
    } finally {
      docs.assetRegistry.list = list;
    }
  });
});
