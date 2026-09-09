import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedScene } from "@babylonslate/core";
import { createActor, createDefaultScene } from "@babylonslate/core";
import { SceneOutlinerPanel } from "./scene-outliner-panel";
import { SceneEditingProvider } from "../context/scene-editing-context";

if (
  typeof window !== "undefined" &&
  typeof window.PointerEvent === "undefined"
) {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const applySceneChange = vi.hoisted(() =>
  vi.fn<(id: string, scene: SerializedScene) => Promise<boolean>>(
    async () => true,
  ),
);
const openDocument = vi.hoisted(() => vi.fn());
const frameActor = vi.hoisted(() => vi.fn());
const harness = vi.hoisted(() => ({
  phone: false,
  scene: null as SerializedScene | null,
  assets: [] as Array<{
    path: string;
    header: { type: string; name: string; guid?: string };
  }>,
}));

vi.mock("../shell/use-platform-layout", () => ({
  usePhoneLayout: () => harness.phone,
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "scene:assets/Main.scene.babasset",
  }),
}));

vi.mock("../context/scene-editing-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../context/scene-editing-context")>();
  return {
    ...actual,
    useSceneEditing: () => ({ ...actual.useSceneEditing(), frameActor }),
  };
});

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "scene:assets/Main.scene.babasset",
        ref: {
          kind: "scene",
          path: "assets/Main.scene.babasset",
          label: "Main",
        },
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
  frameActor.mockClear();
  harness.assets = [];
  harness.phone = false;
});

describe("SceneOutlinerPanel menus", () => {
  it("toggles an actor from the menu without replacing other selected actors", async () => {
    const scene = createDefaultScene();
    scene.actors = [
      createActor("actor-1", "Cube"),
      createActor("actor-2", "Sphere"),
    ];
    harness.scene = scene;
    render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByTestId("outliner-menu-actor-2"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(
      screen
        .getAllByRole("treeitem")
        .map((row) => row.getAttribute("aria-selected")),
    ).toEqual(["true", "true"]);
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Deselect" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(
      screen
        .getAllByRole("treeitem")
        .map((row) => row.getAttribute("aria-selected")),
    ).toEqual(["false", "true"]);
    fireEvent.click(screen.getByTestId("outliner-menu-actor-2"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Deselect" }));
    expect(
      screen
        .getAllByRole("treeitem")
        .map((row) => row.getAttribute("aria-selected")),
    ).toEqual(["false", "false"]);
    expect(applySceneChange).not.toHaveBeenCalled();
  });
  it("frames the actor from its row menu and exposes visibility state", () => {
    harness.scene = createDefaultScene();
    harness.scene.actors = [createActor("actor-1", "Cube", { visible: false })];
    render(<SceneEditingProvider><SceneOutlinerPanel {...({} as IDockviewPanelProps)} /></SceneEditingProvider>);
    expect(
      screen
        .getByTestId("outliner-visibility-actor-1")
        .getAttribute("aria-pressed"),
    ).toBe("false");
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Frame Selection" }));
    expect(frameActor).toHaveBeenCalledWith("actor-1");
  });

  it("keeps phone row targets separate and restores compact row placement on iPad", () => {
    const scene = createDefaultScene();
    scene.actors = [
      createActor("actor-1", "Cube"),
      createActor("actor-2", "Sphere"),
    ];
    harness.scene = scene;
    harness.phone = true;
    const { rerender } = render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    let rows = screen.getAllByRole("treeitem");
    expect(rows[0]!.style.height).toBe("44px");
    expect(rows[1]!.style.top).toBe("44px");
    harness.phone = false;
    rerender(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    rows = screen.getAllByRole("treeitem");
    expect(rows[0]!.style.height).toBe("28px");
    expect(rows[1]!.style.top).toBe("28px");
  });

  it("opens Duplicate/Delete from the row menu button", () => {
    const scene = createDefaultScene();
    scene.actors = [createActor("actor-1", "Cube")];
    harness.scene = scene;
    render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
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
    render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
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
    render(
      <SceneEditingProvider>
        <SceneOutlinerPanel {...({} as IDockviewPanelProps)} />
      </SceneEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("outliner-menu-actor-1"));
    fireEvent.click(screen.getByTestId("outliner-open-actor-actor-1"));
    expect(openDocument).toHaveBeenCalledWith({
      kind: "graph",
      path: "assets/Hero.class.babasset",
      label: "Hero",
    });
  });
});
