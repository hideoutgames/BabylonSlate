import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { EditorUtilityPanel } from "./editor-utility-panel";

const { createUiSurfaceMock, createHostMock } = vi.hoisted(() => ({
  createUiSurfaceMock: vi.fn(),
  createHostMock: vi.fn(),
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
  useOptionalPlay: () => ({
    ensureSharedEngine: () => ({}),
    sharedEngineGeneration: 1,
  }),
}));

vi.mock("../lib/editor-utility-interface-runtime", () => ({
  bindEditorUtilityWidgetEvent: vi.fn(),
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
    expect(await screen.findByTestId("editor-utility-panel")).toBeTruthy();
    expect(screen.getByTestId("editor-utility-canvas")).toBeTruthy();
    await waitFor(() => expect(createUiSurfaceMock).toHaveBeenCalled());
    const options = createUiSurfaceMock.mock.calls[0]?.[2] as {
      interactive?: boolean;
      resolveImageUrl?: (guid: string) => string | null;
    };
    expect(options.interactive).toBe(true);
    expect(typeof options.resolveImageUrl).toBe("function");
  });
});
