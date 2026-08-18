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
  openLiveEditorUtility: vi.fn(),
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
    openLiveEditorUtility: docs.openLiveEditorUtility,
    isDockWindowOpen: docs.isDockWindowOpen,
    getOpenDockWindowCount: docs.getOpenDockWindowCount,
    assetRegistry: { list: () => docs.assets },
    sourceControl: { enabled: false },
    uiEditorMode: "designer",
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
  docs.openLiveEditorUtility.mockReset();
  docs.isDockWindowOpen.mockReset();
  docs.isDockWindowOpen.mockReturnValue(false);
  docs.getOpenDockWindowCount.mockReset();
  docs.getOpenDockWindowCount.mockReturnValue(3);
});

function openEditorUtilitiesMenu(): void {
  render(<WindowsMenu />);
  fireEvent.click(screen.getByTestId("windows-menu"));
  fireEvent.click(screen.getByTestId("windows-editor-utilities"));
}

describe("WindowsMenu Editor Utilities", () => {
  it("says the project has no Editor Utility Interfaces", () => {
    openEditorUtilitiesMenu();
    expect(screen.getByTestId("windows-editor-utilities-empty").textContent).toBe(
      "No Editor Utility Interfaces In This Project",
    );
  });

  it("says none match this document when EUIs exist for the other dock", () => {
    docs.assets = [
      {
        path: "assets/ClassTools.eui.babasset",
        header: {
          guid: "eui-class",
          name: "ClassTools",
          type: "EditorUtilityInterface",
          payload: { dockKind: "class" },
        },
      },
    ];
    openEditorUtilitiesMenu();
    expect(screen.getByTestId("windows-editor-utilities-empty").textContent).toBe(
      "None For This Document",
    );
  });

  it("lists project Editor Utility Interfaces on a UI authoring tab and opens live on the host", () => {
    docs.kind = "ui";
    docs.path = "assets/SceneTools.eui.babasset";
    docs.assets = [
      {
        path: "assets/SceneTools.eui.babasset",
        header: {
          guid: "eui-scene",
          name: "SceneTools",
          type: "EditorUtilityInterface",
          payload: { dockKind: "scene" },
        },
      },
    ];
    openEditorUtilitiesMenu();
    expect(screen.queryByTestId("windows-editor-utilities-empty")).toBeNull();
    fireEvent.click(screen.getByTestId("windows-menu-eui-eui-scene"));
    expect(docs.openLiveEditorUtility).toHaveBeenCalledWith("eui-scene");
    expect(docs.toggleDockWindow).not.toHaveBeenCalled();
  });

  it("toggles a matching Editor Utility on the Scene dock", () => {
    docs.assets = [
      {
        path: "assets/SceneTools.eui.babasset",
        header: {
          guid: "eui-scene",
          name: "SceneTools",
          type: "EditorUtilityInterface",
          payload: { dockKind: "scene" },
        },
      },
    ];
    openEditorUtilitiesMenu();
    fireEvent.click(screen.getByTestId("windows-menu-eui-eui-scene"));
    expect(docs.toggleDockWindow).toHaveBeenCalledWith("eui-eui-scene");
    expect(docs.openLiveEditorUtility).not.toHaveBeenCalled();
  });
});
