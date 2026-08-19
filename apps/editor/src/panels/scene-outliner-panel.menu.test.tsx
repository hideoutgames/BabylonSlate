import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedScene } from "@babylonslate/core";
import { createActor, createDefaultScene } from "@babylonslate/core";
import { SceneOutlinerPanel } from "./scene-outliner-panel";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const applySceneChange = vi.hoisted(() =>
  vi.fn<(id: string, scene: SerializedScene) => Promise<boolean>>(async () => true),
);
const openDocument = vi.hoisted(() => vi.fn());
const harness = vi.hoisted(() => ({
  scene: null as SerializedScene | null,
  assets: [] as Array<{
    path: string;
    header: { type: string; name: string; guid?: string };
  }>,
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "scene:assets/Main.scene.babasset" }),
}));

vi.mock("../context/scene-editing-context", () => ({
  useSceneEditing: () => ({
    selectedActorIds: [],
    selectActor: vi.fn(),
    setSelectedActorIds: vi.fn(),
    frameActor: vi.fn(),
  }),
  selectionAfterLockChange: (ids: string[]) => ids,
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "scene:assets/Main.scene.babasset",
        ref: { kind: "scene", path: "assets/Main.scene.babasset", label: "Main" },
        content: harness.scene,
        layout: null,
        dirty: false,
      },
    ],
    applySceneChange,
    assetRegistry: { list: () => harness.assets },
    loadGraphDocument: vi.fn(),
    openDocument,
  }),
}));

afterEach(() => {
  cleanup();
  applySceneChange.mockClear();
  openDocument.mockClear();
  harness.assets = [];
});

describe("SceneOutlinerPanel menus", () => {
  it("opens Duplicate/Delete from the row menu button", () => {
    const scene = createDefaultScene();
    scene.actors = [createActor("actor-1", "Cube")];
    harness.scene = scene;
    render(<SceneOutlinerPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByTestId("outliner-delete-actor-1"));
    expect(applySceneChange).toHaveBeenCalled();
    const next = applySceneChange.mock.calls[0]?.[1] as SerializedScene;
    expect(next.actors.find((actor) => actor.id === "actor-1")).toBeUndefined();
  });

  it("omits Open Actor for engine Actor classes", () => {
    const scene = createDefaultScene();
    scene.actors = [createActor("actor-1", "Cube")];
    harness.scene = scene;
    render(<SceneOutlinerPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    expect(screen.queryByTestId("outliner-open-actor-actor-1")).toBeNull();
  });

  it("opens the project Class document from Open Actor", () => {
    const scene = createDefaultScene();
    scene.actors = [createActor("actor-1", "Hero", { classId: "Hero" })];
    harness.scene = scene;
    harness.assets = [
      {
        path: "assets/Hero.class.babasset",
        header: { type: "Class", name: "Hero", guid: "hero-guid" },
      },
    ];
    render(<SceneOutlinerPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByTestId("outliner-open-actor-actor-1"));
    expect(openDocument).toHaveBeenCalledWith({
      kind: "graph",
      path: "assets/Hero.class.babasset",
      label: "Hero",
    });
  });
});
