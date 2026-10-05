import { useEffect, useRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createDefaultScene, documentId } from "@babylonslate/core";
import type { EditorCameraSessionState } from "@babylonslate/render";
import { EditorSessionStateProvider } from "../context/editor-session-state-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing } from "../context/scene-editing-context";
import { useGraphSessionViewport } from "../lib/graph-session-viewport";
import {
  DocumentService,
  type DocumentIdentityListener,
} from "../services/document-service";
import type { ProjectService } from "../services/project-service";
import { DocumentWorkspace } from "./document-workspace";

const state = vi.hoisted(() => ({
  service: null as unknown as import("../services/document-service").DocumentService,
  /** Workspaces the P18 working set keeps mounted; null mounts every open tab. */
  mounted: null as Set<string> | null,
  passthrough: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => {
  const { tabOrder, activeDocumentId } = state.service.getState();
  return {
    tabOrder: [...tabOrder],
    activeDocumentId,
    openDocuments: state.service.getOpenDocumentsOrdered(),
    projectDocument: { metadata: { name: "Test" } },
    assetRegistry: null,
    sourceControl: { enabled: false },
    registerDockviewApi: () => {},
    captureLayoutForId: () => {},
    unregisterDockviewApi: () => {},
  };
}));
vi.mock("../lib/document-working-set", () => ({
  useDocumentWorkingSet: (tabIds: readonly string[]) =>
    state.mounted ?? new Set(tabIds),
}));
// Isolate the workspace from engine sessions and DockView mounting.
vi.mock("../context/audio-reverb-bake-context", () => ({
  AudioReverbBakeProvider: state.passthrough,
}));
vi.mock("../context/scene-tools-context", () => ({
  SceneToolsProvider: state.passthrough,
}));
vi.mock("../context/nav-bake-context", () => ({
  NavBakeProvider: state.passthrough,
}));
vi.mock("../context/prefab-editing-context", () => ({
  PrefabEditingProvider: state.passthrough,
}));
vi.mock("../context/graph-editing-context", () => ({
  GraphEditingProvider: state.passthrough,
}));
vi.mock("../context/project-search-context", () => ({
  useProjectSearch: () => ({ pendingTarget: null, clearPendingTarget: () => {} }),
}));
vi.mock("../shell/dockview-shell", () => ({
  DockviewShell: () => <ViewProbe />,
}));
vi.mock("./document-lock-banner", () => ({ DocumentLockBanner: () => null }));

const orbit: EditorCameraSessionState = {
  pose3d: { target: { x: 3, y: 4, z: 5 }, alpha: 1.2, beta: 0.8, radius: 10 },
  pose2d: null,
};
const topDown: EditorCameraSessionState = {
  pose3d: { target: { x: 0, y: 0, z: 0 }, alpha: 0, beta: 0.1, radius: 30 },
  pose2d: null,
};

/**
 * Stands in for a document's viewport and graph canvas: the editor camera is
 * imported when the engine starts after mount and exported when the engine is
 * released on unmount; graph pan/zoom is read at render and saved on move end.
 */
function ViewProbe() {
  const { documentId: id } = useDocumentWorkspace();
  const { saveEditorCameraPose, loadEditorCameraPose } = useSceneEditing();
  const { sessionViewport, onSessionViewportChange } = useGraphSessionViewport(id);
  const liveCamera = useRef<EditorCameraSessionState | null>(null);
  const [restored, setRestored] = useState<EditorCameraSessionState | null>(null);
  useEffect(() => {
    liveCamera.current = loadEditorCameraPose();
    setRestored(liveCamera.current);
    return () => {
      if (liveCamera.current) saveEditorCameraPose(liveCamera.current);
    };
  }, [loadEditorCameraPose, saveEditorCameraPose]);
  return (
    <div data-testid={`view:${id}`}>
      <span data-testid="camera">
        {restored ? `radius ${restored.pose3d?.radius}` : "default"}
      </span>
      <span data-testid="graph">
        {sessionViewport
          ? `${sessionViewport.x},${sessionViewport.y} @ ${sessionViewport.zoom}`
          : "fit"}
      </span>
      <button type="button" onClick={() => { liveCamera.current = orbit; }}>
        Orbit
      </button>
      <button type="button" onClick={() => { liveCamera.current = topDown; }}>
        Top Down
      </button>
      <button
        type="button"
        onClick={() => onSessionViewportChange({ x: 12, y: 34, zoom: 0.75 })}
      >
        Pan
      </button>
    </div>
  );
}

const project = {
  loadDocument: async (kind: string) =>
    kind === "scene" ? createDefaultScene() : { nodes: [], edges: [] },
} as unknown as ProjectService;

const subscribeDocumentIdentity = (listener: DocumentIdentityListener) =>
  state.service.onIdentityChange(listener);

/** One project session: EditorRoute's provider around the document workspace. */
function editor() {
  return (
    <EditorSessionStateProvider subscribeDocumentIdentity={subscribeDocumentIdentity}>
      <DocumentWorkspace />
    </EditorSessionStateProvider>
  );
}

function open(kind: "graph" | "scene", path: string) {
  return state.service.openDocument(project, { kind, path, label: path });
}

function view(id: string) {
  return within(screen.getByTestId(`view:${id}`));
}

const HERO = "assets/Hero.class.babasset";
const heroId = documentId({ kind: "graph", path: HERO });

beforeEach(() => {
  state.service = new DocumentService();
  state.mounted = null;
});

afterEach(() => {
  cleanup();
});

describe("document view state across workspace remounts", () => {
  it("restores a Class tab's camera and graph pan/zoom after its idle-unmounted workspace remounts", async () => {
    await open("graph", HERO);
    const { rerender } = render(editor());
    fireEvent.click(view(heroId).getByText("Orbit"));
    fireEvent.click(view(heroId).getByText("Pan"));

    state.mounted = new Set();
    rerender(editor());
    expect(screen.queryByTestId(`view:${heroId}`)).toBeNull();

    state.mounted = null;
    rerender(editor());
    expect(view(heroId).getByTestId("camera").textContent).toBe("radius 10");
    expect(view(heroId).getByTestId("graph").textContent).toBe("12,34 @ 0.75");
  });

  it("restores a Scene's camera after opening another Scene closed it", async () => {
    const levelA = "assets/LevelA.scene.babasset";
    const levelB = "assets/LevelB.scene.babasset";
    const levelAId = documentId({ kind: "scene", path: levelA });
    await open("scene", levelA);
    const { rerender } = render(editor());
    fireEvent.click(view(levelAId).getByText("Orbit"));

    await open("scene", levelB);
    rerender(editor());
    expect(screen.queryByTestId(`view:${levelAId}`)).toBeNull();
    expect(
      view(documentId({ kind: "scene", path: levelB })).getByTestId("camera").textContent,
    ).toBe("default");

    await open("scene", levelA);
    rerender(editor());
    expect(view(levelAId).getByTestId("camera").textContent).toBe("radius 10");
  });

  it("starts the next project session at defaults for the same document path", async () => {
    await open("graph", HERO);
    const { unmount } = render(editor());
    fireEvent.click(view(heroId).getByText("Orbit"));
    fireEvent.click(view(heroId).getByText("Pan"));
    unmount();

    state.service = new DocumentService();
    await open("graph", HERO);
    render(editor());
    expect(view(heroId).getByTestId("camera").textContent).toBe("default");
    expect(view(heroId).getByTestId("graph").textContent).toBe("fit");
  });

  it("moves view state with a renamed Class, including the old workspace's camera save as it unmounts", async () => {
    const renamed = "assets/Characters/Hero.class.babasset";
    const renamedId = documentId({ kind: "graph", path: renamed });
    await open("graph", HERO);
    const { rerender } = render(editor());
    fireEvent.click(view(heroId).getByText("Orbit"));
    fireEvent.click(view(heroId).getByText("Pan"));

    state.service.repathDocument("graph", HERO, renamed);
    rerender(editor());
    expect(screen.queryByTestId(`view:${heroId}`)).toBeNull();
    expect(view(renamedId).getByTestId("camera").textContent).toBe("radius 10");
    expect(view(renamedId).getByTestId("graph").textContent).toBe("12,34 @ 0.75");

    // A new Class at the old path starts clean and keeps its own view.
    await open("graph", HERO);
    rerender(editor());
    expect(view(heroId).getByTestId("camera").textContent).toBe("default");
    expect(view(heroId).getByTestId("graph").textContent).toBe("fit");
    fireEvent.click(view(heroId).getByText("Top Down"));
    state.service.closeDocument(heroId);
    rerender(editor());
    await open("graph", HERO);
    rerender(editor());
    expect(view(heroId).getByTestId("camera").textContent).toBe("radius 30");
  });
});
