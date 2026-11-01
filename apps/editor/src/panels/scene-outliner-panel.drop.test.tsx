import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedScene } from "@haptic/core";
import { createDefaultScene, createTimelineClip } from "@haptic/core";
import { actorRowId } from "../lib/outliner-drop";
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
  tools: null as null | {
    timelineClipId: string;
    timelineDropTarget: { containsClientPoint: (x: number) => boolean; clipName: () => string; addActors: (ids: readonly string[]) => void };
  },
}));

vi.mock("../context/scene-tools-context", () => ({ useOptionalSceneTools: () => harness.tools }));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "scene:assets/Main.scene.hasset" }),
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

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [
    {
      id: "scene:assets/Main.scene.hasset",
      ref: { kind: "scene", path: "assets/Main.scene.hasset", label: "Main" },
      content: harness.scene,
      layout: null,
      dirty: false,
    },
  ],
  applySceneChange,
  assetRegistry: { list: () => [] },
  loadGraphDocument: vi.fn(),
})));

afterEach(() => {
  cleanup();
  harness.tools = null;
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
    const copy = next.actors.find((actor) => actor.name === "Actor Copy");
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
    expect(hint.textContent).toContain("Actor");
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

describe("SceneOutlinerPanel in Timeline mode", () => {
  it("adds an actor dropped on the Timeline window to its clip, and badges the clip's actors", () => {
    const addActors = vi.fn();
    harness.tools = {
      timelineClipId: "intro",
      timelineDropTarget: { containsClientPoint: (x) => x >= 200, clipName: () => "Intro", addActors },
    };
    const scene = createDefaultScene();
    const withClip = {
      ...scene,
      timelineClips: [{ ...createTimelineClip("intro", "Intro"), objects: [{ id: "o1", actorId: "actor-1", tracks: [] }] }],
    };
    renderOutliner(withClip);
    const badge = screen.getByTestId("outliner-timeline-badge-actor-1");
    expect(badge.getAttribute("aria-label")).toBe("In Intro");
    // With the row's actions, which never shrink, not in the preview slot that gives way to a narrow Outliner.
    expect(badge.closest('[id$="-preview"]')).toBeNull();
    expect(badge.parentElement?.className).toContain("shrink-0");
    dragRowOutside(screen.getByTestId(`tree-row-${actorRowId("actor-1")}`));
    expect(addActors).toHaveBeenCalledWith(["actor-1"]);
    // The drop joined the clip instead of duplicating into the viewport.
    expect(applySceneChange).not.toHaveBeenCalled();
  });
});
