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
  vi.fn(async (_id: string, _scene: SerializedScene) => true),
);
const harness = vi.hoisted(() => ({
  scene: null as SerializedScene | null,
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
    assetRegistry: { list: () => [] },
    loadGraphDocument: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  applySceneChange.mockClear();
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
});
