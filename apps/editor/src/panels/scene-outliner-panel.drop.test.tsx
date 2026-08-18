import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedScene } from "@babylonslate/core";
import { createDefaultScene } from "@babylonslate/core";
import { actorRowId } from "./scene-outliner-panel";
import { SceneOutlinerPanel } from "./scene-outliner-panel";

/** jsdom has no PointerEvent; a MouseEvent with pointer fields drives TreeView. */
function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: { clientX: number; clientY: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

const applySceneChange = vi.hoisted(() =>
  vi.fn<(id: string, scene: SerializedScene) => Promise<boolean>>(async () => true),
);
const selectActor = vi.hoisted(() => vi.fn());
const viewportDropApi = vi.hoisted(() => ({
  containsClientPoint: vi.fn((clientX: number) => clientX >= 200),
  worldPositionAtClient: vi.fn(
    (): [number, number, number] => [4, 5, 6],
  ),
  worldPositionAtViewCenter: vi.fn(
    (): [number, number, number] => [1, 2, 3],
  ),
}));
const harness = vi.hoisted(() => ({
  scene: null as SerializedScene | null,
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "scene:assets/Main.scene.babasset" }),
}));

vi.mock("../context/scene-editing-context", () => ({
  useSceneEditing: () => ({
    selectedActorIds: [],
    selectActor,
    setSelectedActorIds: vi.fn(),
    frameActor: vi.fn(),
    viewportDropApi,
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
  selectActor.mockClear();
  viewportDropApi.containsClientPoint.mockClear();
  viewportDropApi.worldPositionAtClient.mockClear();
});

function renderOutliner(scene: SerializedScene) {
  harness.scene = scene;
  render(<SceneOutlinerPanel {...({} as IDockviewPanelProps)} />);
  const tree = screen.getByTestId("outliner-tree");
  tree.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 180, bottom: 200, width: 180, height: 200 }) as DOMRect;
  return tree;
}

function dragRowOutside(row: Element) {
  act(() => {
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 20 });
    dispatchPointerEvent(row, "pointermove", { clientX: 260, clientY: 80 });
    dispatchPointerEvent(row, "pointerup", { clientX: 260, clientY: 80 });
  });
}

describe("SceneOutlinerPanel viewport drop", () => {
  it("duplicates an actor at the viewport world position", () => {
    const scene = createDefaultScene();
    renderOutliner(scene);
    dragRowOutside(screen.getByTestId(`tree-row-${actorRowId("actor-1")}`));
    expect(applySceneChange).toHaveBeenCalled();
    const next = applySceneChange.mock.calls[0]?.[1] as SerializedScene;
    const copy = next.actors.find((actor) => actor.name === "Cube Copy");
    expect(copy).toMatchObject({
      id: "actor-2",
      parentId: null,
      transform: { position: [4, 5, 6] },
    });
    expect(next.actors.some((actor) => actor.id === "actor-1")).toBe(true);
    expect(selectActor).toHaveBeenCalledWith("actor-2");
  });

  it("shows a +Name hint while dragging over the viewport", () => {
    renderOutliner(createDefaultScene());
    const row = screen.getByTestId(`tree-row-${actorRowId("actor-1")}`);
    act(() => {
      dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 20 });
      dispatchPointerEvent(row, "pointermove", { clientX: 260, clientY: 80 });
    });
    const hint = screen.getByTestId("outliner-drop-hint");
    expect(hint.getAttribute("data-allowed")).toBe("true");
    expect(hint.textContent).toContain("Cube");
  });

  it("does not duplicate when the pointer is not over the viewport", () => {
    viewportDropApi.containsClientPoint.mockImplementation(() => false);
    renderOutliner(createDefaultScene());
    dragRowOutside(screen.getByTestId(`tree-row-${actorRowId("actor-1")}`));
    expect(applySceneChange).not.toHaveBeenCalled();
    viewportDropApi.containsClientPoint.mockImplementation(
      (clientX: number) => clientX >= 200,
    );
  });

  it("does not duplicate a folder row dropped on the viewport", () => {
    const scene = createDefaultScene();
    scene.folders = [{ id: "props", name: "Props", parentFolderId: null }];
    renderOutliner(scene);
    const row = screen.getByTestId("tree-row-folder:props");
    act(() => {
      dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 20 });
      dispatchPointerEvent(row, "pointermove", { clientX: 260, clientY: 80 });
    });
    expect(screen.getByTestId("outliner-drop-hint").getAttribute("data-allowed")).toBe(
      "false",
    );
    act(() => {
      dispatchPointerEvent(row, "pointerup", { clientX: 260, clientY: 80 });
    });
    expect(applySceneChange).not.toHaveBeenCalled();
  });
});
