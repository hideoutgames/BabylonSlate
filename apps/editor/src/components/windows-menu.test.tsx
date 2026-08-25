import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WindowsMenu } from "./windows-menu";

const docs = vi.hoisted(() => ({
  kind: "scene" as string,
  path: "assets/main.scene.babasset",
  assets: [] as Array<{
    path: string;
    header: {
      guid: string;
      name: string;
      type: string;
      payload?: Record<string, unknown>;
    };
  }>,
  toggleDockWindow: vi.fn(),
  isDockWindowOpen: vi.fn(() => false),
  getOpenDockWindowCount: vi.fn(() => 3),
}));

vi.mock("../lib/content-browser-helpers", () => ({
  classDocumentShowsPrefab: () => true,
  classParentLookup: () => new Map(),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    projectName: "Demo",
    openDocuments: [
      {
        id: `${docs.kind}:${docs.path}`,
        ref: { kind: docs.kind, path: docs.path },
      },
    ],
    activeDocumentId: `${docs.kind}:${docs.path}`,
    toggleDockWindow: docs.toggleDockWindow,
    isDockWindowOpen: docs.isDockWindowOpen,
    getOpenDockWindowCount: docs.getOpenDockWindowCount,
    assetRegistry: { list: () => docs.assets },
    sourceControl: { enabled: false },
    animEditorMode: "stateMachine",
  }),
  useDockWindowTick: () => 0,
}));

afterEach(() => {
  cleanup();
  docs.kind = "scene";
  docs.path = "assets/main.scene.babasset";
  docs.assets = [];
  docs.toggleDockWindow.mockReset();
  docs.isDockWindowOpen.mockReset();
  docs.isDockWindowOpen.mockReturnValue(false);
  docs.getOpenDockWindowCount.mockReset();
  docs.getOpenDockWindowCount.mockReturnValue(3);
});

describe("WindowsMenu", () => {
  it("does not list Editor Utilities", () => {
    render(<WindowsMenu />);
    fireEvent.click(screen.getByTestId("windows-menu"));
    expect(screen.queryByTestId("windows-editor-utilities")).toBeNull();
  });
});
