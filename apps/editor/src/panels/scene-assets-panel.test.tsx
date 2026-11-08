import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createDefaultScene, type SerializedScene } from "@haptic/core";
import { EditorSessionStateProvider } from "../context/editor-session-state-context";
import { SceneAssetsPanel } from "./scene-assets-panel";

/**
 * jsdom has no PointerEvent; a MouseEvent with pointer fields drives the card
 * gestures. A release also delivers the click a browser dispatches after it.
 */
function dispatchPointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
  pointerType: "mouse" | "touch" = "mouse",
): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  target.dispatchEvent(event);
  if (type === "pointerup") document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
}

const DOC_ID = "scene:assets/Main.scene.hasset";
const ASSETS = [
  { rootId: "project", path: "assets/props/Crate.model.hasset", header: { guid: "crate", name: "Crate", type: "Model" } },
  { rootId: "project", path: "assets/gameplay/Door.class.hasset", header: { guid: "door", name: "Door", type: "Class", parentClass: "Actor" } },
  { rootId: "project", path: "assets/Game.class.hasset", header: { guid: "game", name: "Game", type: "Class", parentClass: "GameInstance" } },
  { rootId: "project", path: "assets/ui/Health Bar.class.hasset", header: { guid: "health", name: "Health Bar", type: "Class", parentClass: "SceneLayerActor" } },
  { rootId: "project", path: "assets/props/Stack.prefab.hasset", header: { guid: "stack", name: "Stack", type: "Prefab", payload: { components: [] } } },
  { rootId: "project", path: "assets/2d/Hero.sprite.hasset", header: { guid: "hero", name: "Hero", type: "Sprite" } },
  { rootId: "project", path: "assets/2d/Level.tilemap.hasset", header: { guid: "level", name: "Level", type: "Tilemap" } },
  { rootId: "plugin:kit", path: "plugins/kit/assets/Cone.model.hasset", header: { guid: "cone", name: "Cone", type: "Model" } },
];

const applySceneChange = vi.hoisted(() =>
  vi.fn<(id: string, scene: SerializedScene, options?: { mergeKey?: string }) => Promise<boolean>>(async () => true),
);
const setSelectedActorIds = vi.hoisted(() => vi.fn());
const viewportDropApi = vi.hoisted(() => ({
  containsClientPoint: vi.fn((clientX: number) => clientX >= 200),
  placementAtClient: vi.fn(
    (): { position: [number, number, number]; normal: [number, number, number] | null } =>
      ({ position: [4, 5, 6], normal: [0, 1, 0] }),
  ),
  placementAtViewCenter: vi.fn(
    (): { position: [number, number, number]; normal: [number, number, number] | null } =>
      ({ position: [1, 2, 3], normal: null }),
  ),
  restOnSurface: vi.fn(),
}));
const harness = vi.hoisted(() => ({
  scene: null as unknown,
  kind: "scene" as "scene" | "scene-layer",
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "scene:assets/Main.scene.hasset" }),
  useOptionalDocumentWorkspace: () => ({ documentId: "scene:assets/Main.scene.hasset" }),
}));

vi.mock("../context/scene-editing-context", () => ({
  FALLBACK_PLACE_POSITION: [0, 0, 0],
  useSceneEditing: () => ({ setSelectedActorIds, viewportDropApi }),
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  activeDocumentId: DOC_ID,
  openDocuments: [
    {
      id: DOC_ID,
      ref: { kind: harness.kind, path: "assets/Main.scene.hasset", label: "Main" },
      content: harness.scene,
      layout: null,
      dirty: false,
    },
  ],
  applySceneChange,
  assetRegistry: { list: () => ASSETS },
  pluginDescriptors: [{ pluginGuid: "kit", settings: { displayName: "Props Kit" } }],
  loadGraphDocument: vi.fn(async () => null),
})));

afterEach(() => {
  cleanup();
  harness.kind = "scene";
  applySceneChange.mockClear();
  viewportDropApi.restOnSurface.mockClear();
  setSelectedActorIds.mockClear();
});

function renderPanel(kind: "scene" | "scene-layer" = "scene") {
  const scene = createDefaultScene();
  harness.scene = scene;
  harness.kind = kind;
  render(<SceneAssetsPanel {...({} as IDockviewPanelProps)} />);
  return scene;
}

const card = (guid: string) => screen.getByTestId(`scene-assets-card-asset-${guid}`);
const cardIds = () =>
  within(screen.getByTestId("scene-assets-grid"))
    .getAllByRole("option")
    .map((element) => element.dataset.testid?.replace("scene-assets-card-", ""));

/** Actors the last scene change added, by name and position. */
function placedActors(scene: SerializedScene) {
  const next = applySceneChange.mock.calls.at(-1)?.[1] as SerializedScene;
  return next.actors.slice(scene.actors.length).map((actor) => [actor.name, actor.transform.position]);
}

describe("SceneAssetsPanel", () => {
  it("lists a Scene's Models, Actor Classes and Prefabs, and hides plugin content on request", async () => {
    renderPanel();
    expect(cardIds()).toEqual(["asset-cone", "asset-crate", "asset-door", "asset-stack"]);
    expect(within(card("cone")).getByRole("img", { name: "Plugin: Props Kit" })).toBeTruthy();

    fireEvent.click(screen.getByTestId("scene-assets-filter"));
    fireEvent.click(await screen.findByTestId("scene-assets-show-plugins"));
    await waitFor(() => expect(cardIds()).toEqual(["asset-crate", "asset-door", "asset-stack"]));
    expect(screen.getByTestId("scene-assets-count").textContent).toBe("3 of 6 Assets");

    fireEvent.click(screen.getByTestId("scene-assets-chip-plugins"));
    expect(cardIds()).toEqual(["asset-cone", "asset-crate", "asset-door", "asset-stack"]);
  });

  it("shows Sprites and Tilemaps when turned on in Asset Types and places them with their asset", async () => {
    const scene = renderPanel();
    expect(cardIds()).toEqual(["asset-cone", "asset-crate", "asset-door", "asset-stack"]);
    expect(screen.getByTestId("scene-assets-count").textContent).toBe("4 of 6 Assets");

    fireEvent.click(screen.getByTestId("scene-assets-filter"));
    fireEvent.click(await screen.findByTestId("scene-assets-filter-sprite"));
    fireEvent.click(screen.getByTestId("scene-assets-filter-tilemap"));
    fireEvent.click(screen.getByTestId("scene-assets-filter-model"));
    await waitFor(() => expect(cardIds()).toEqual(["asset-door", "asset-hero", "asset-level", "asset-stack"]));
    expect(screen.getByTestId("scene-assets-filter").getAttribute("aria-label")).toBe("Filter (3)");
    expect(screen.getByTestId("scene-assets-chip-kind-model").textContent).toBe("Models Hidden");
    expect(screen.getByTestId("scene-assets-chip-kind-sprite").textContent).toBe("Sprites Shown");

    // Removing a tag restores that type's default.
    fireEvent.click(screen.getByTestId("scene-assets-chip-kind-model"));
    expect(cardIds()).toEqual(["asset-cone", "asset-crate", "asset-door", "asset-hero", "asset-level", "asset-stack"]);

    fireEvent.click(card("hero"));
    fireEvent.click(card("level"), { ctrlKey: true });
    fireEvent.click(screen.getByTestId("scene-assets-place"));
    expect(applySceneChange).toHaveBeenCalledTimes(1);
    const placed = applySceneChange.mock.calls[0]![1].actors.slice(scene.actors.length);
    expect(placed.map((actor) => [actor.name, actor.components.map((component) => [
      component.classId,
      component.properties.assetGuid,
    ])])).toEqual([
      ["Hero", [["SpriteComponent", "hero"]]],
      ["Level", [["TilemapComponent", "level"]]],
    ]);
  });

  it("clears type filters back to the default types", async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("scene-assets-filter"));
    fireEvent.click(await screen.findByTestId("scene-assets-filter-sprite"));
    for (const kind of ["model", "actor", "prefab"]) fireEvent.click(screen.getByTestId(`scene-assets-filter-${kind}`));
    await waitFor(() => expect(cardIds()).toEqual(["asset-hero"]));
    fireEvent.click(screen.getByTestId("scene-assets-filter-sprite"));
    await screen.findByTestId("scene-assets-no-matches");

    fireEvent.click(screen.getByRole("button", { name: "Clear Filters" }));
    expect(cardIds()).toEqual(["asset-cone", "asset-crate", "asset-door", "asset-stack"]);
  });

  it("keeps the shown types for every Assets panel of the session", async () => {
    harness.scene = createDefaultScene();
    const session = (panel: boolean) => (
      <EditorSessionStateProvider>
        {panel ? <SceneAssetsPanel {...({} as IDockviewPanelProps)} /> : null}
      </EditorSessionStateProvider>
    );
    const { rerender } = render(session(true));
    fireEvent.click(screen.getByTestId("scene-assets-filter"));
    fireEvent.click(await screen.findByTestId("scene-assets-filter-tilemap"));
    await waitFor(() => expect(cardIds()).toContain("asset-level"));

    // A panel mounted afresh in the same session, as in another Scene tab, reads the choice.
    rerender(session(false));
    expect(screen.queryByTestId("scene-assets-panel")).toBeNull();
    rerender(session(true));
    expect(cardIds()).toEqual(["asset-cone", "asset-crate", "asset-door", "asset-level", "asset-stack"]);
  });

  it("places into a 2D Scene from Next Z-Order upward when Stack New Actors is on", () => {
    viewportDropApi.placementAtViewCenter.mockReturnValueOnce({ position: [1, 2, 0], normal: null });
    const scene = createDefaultScene("2d");
    scene.settings = { ...scene.settings, stackZOrder2D: true, nextZOrder2D: 2 };
    harness.scene = scene;
    render(<SceneAssetsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(card("crate"));
    fireEvent.click(card("stack"), { ctrlKey: true });
    fireEvent.click(screen.getByTestId("scene-assets-place"));
    const next = applySceneChange.mock.calls[0]![1];
    // Two entries spread across X/Y around the view centre, at Z-Order 2 and 3.
    expect(next.actors.slice(scene.actors.length).map((actor) => [actor.name, actor.transform.position])).toEqual([
      ["Crate", [0, 2, -2]],
      ["Stack", [2, 2, -3]],
    ]);
    expect(next.settings.nextZOrder2D).toBe(4);
  });

  it("lists a Scene Layer's built-in 2D elements before its Layer Actor Classes and Models", () => {
    renderPanel("scene-layer");
    const ids = cardIds();
    expect(ids[0]).toBe("2d-panel");
    expect(ids.slice(-3)).toEqual(["asset-cone", "asset-crate", "asset-health"]);
    expect(ids).not.toContain("asset-door");
    expect(ids).not.toContain("asset-stack");
  });

  it("builds a selection with Ctrl and Shift and places it around the view centre as one change", async () => {
    const scene = renderPanel();
    fireEvent.click(card("crate"));
    fireEvent.click(card("stack"), { ctrlKey: true });
    expect(card("crate").getAttribute("aria-selected")).toBe("true");
    expect(card("door").getAttribute("aria-selected")).toBe("false");
    fireEvent.click(card("cone"));
    fireEvent.click(card("crate"), { shiftKey: true });
    expect(["cone", "crate", "door", "stack"].map((guid) => card(guid).getAttribute("aria-selected")))
      .toEqual(["true", "true", "false", "false"]);

    fireEvent.click(card("door"), { ctrlKey: true });
    expect(screen.getByTestId("scene-assets-selection").textContent).toContain("3 Selected");
    fireEvent.click(screen.getByTestId("scene-assets-place"));

    // Door is a Class: placing waits for its graph, then adds all three at once.
    await waitFor(() => expect(applySceneChange).toHaveBeenCalledTimes(1));
    expect(placedActors(scene)).toEqual([
      ["Cone", [0, 2, 2]],
      ["Crate", [2, 2, 2]],
      ["Door", [0, 2, 4]],
    ]);
    const next = applySceneChange.mock.calls[0]![1];
    expect(setSelectedActorIds).toHaveBeenCalledWith(next.actors.slice(scene.actors.length).map((actor) => actor.id));
  });

  it("drags the selection onto the viewport and places it at the drop point", () => {
    const scene = renderPanel();
    fireEvent.click(card("crate"));
    fireEvent.click(card("stack"), { ctrlKey: true });

    act(() => {
      dispatchPointer(card("crate"), "pointerdown", 10, 20);
      dispatchPointer(window, "pointermove", 260, 80);
    });
    const hint = screen.getByTestId("scene-assets-drop-hint");
    expect(hint.dataset.allowed).toBe("true");
    expect(hint.textContent).toContain("2 Assets");
    act(() => dispatchPointer(window, "pointerup", 260, 80));

    expect(applySceneChange).toHaveBeenCalledTimes(1);
    expect(placedActors(scene)).toEqual([
      ["Crate", [3, 5, 6]],
      ["Stack", [5, 5, 6]],
    ]);
    // Each placed actor rests on the surface the drop hit, in the placement's Undo step.
    const next = applySceneChange.mock.calls[0]![1];
    const [crate, stack] = next.actors.slice(-2).map((actor) => actor.id);
    expect(applySceneChange.mock.calls[0]![2]).toEqual({ mergeKey: `place:${crate}` });
    expect(viewportDropApi.restOnSurface).toHaveBeenCalledWith(
      [
        { actorId: crate, point: [3, 5, 6], normal: [0, 1, 0] },
        { actorId: stack, point: [5, 5, 6], normal: [0, 1, 0] },
      ],
      `place:${crate}`,
    );
    expect(screen.queryByTestId("scene-assets-drop-hint")).toBeNull();
  });

  it("drags an unselected card alone and places nothing outside the viewport", () => {
    const scene = renderPanel();
    fireEvent.click(card("stack"));
    act(() => {
      dispatchPointer(card("crate"), "pointerdown", 10, 20);
      dispatchPointer(window, "pointermove", 120, 80);
    });
    expect(screen.getByTestId("scene-assets-drop-hint").dataset.allowed).toBe("false");
    act(() => dispatchPointer(window, "pointerup", 120, 80));
    expect(applySceneChange).not.toHaveBeenCalled();

    act(() => {
      dispatchPointer(card("crate"), "pointerdown", 10, 20);
      dispatchPointer(window, "pointermove", 260, 80);
      dispatchPointer(window, "pointerup", 260, 80);
    });
    expect(placedActors(scene)).toEqual([["Crate", [4, 5, 6]]]);
  });

  it("drags a card at once when touch leaves the grid sideways, while a vertical move only scrolls", () => {
    const scene = renderPanel();
    const touchMove = (clientX: number, clientY: number) => {
      const event = new TouchEvent("touchmove", {
        bubbles: true,
        cancelable: true,
        touches: [{ identifier: 0, clientX, clientY } as Touch],
      });
      act(() => card("crate").dispatchEvent(event));
      return event.defaultPrevented;
    };

    // Vertical: native scrolling keeps the gesture and nothing is placed.
    act(() => dispatchPointer(card("crate"), "pointerdown", 10, 20, "touch"));
    expect(touchMove(12, 60)).toBe(false);
    act(() => {
      dispatchPointer(window, "pointermove", 12, 90, "touch");
      dispatchPointer(window, "pointerup", 260, 80, "touch");
    });
    expect(applySceneChange).not.toHaveBeenCalled();

    // Sideways: no hold, the first move already drags and stops native panning.
    act(() => dispatchPointer(card("crate"), "pointerdown", 10, 20, "touch"));
    expect(touchMove(40, 24)).toBe(true);
    act(() => dispatchPointer(window, "pointermove", 260, 80, "touch"));
    expect(screen.getByTestId("scene-assets-drop-hint").dataset.allowed).toBe("true");
    act(() => dispatchPointer(window, "pointerup", 260, 80, "touch"));
    expect(placedActors(scene)).toEqual([["Crate", [4, 5, 6]]]);
  });

  it("offers Select on a hold of an unselected card, adding it to the selection it replaced", async () => {
    renderPanel();
    fireEvent.click(card("crate"));
    fireEvent.contextMenu(card("stack"), { clientX: 40, clientY: 40 });
    expect(card("stack").getAttribute("aria-selected")).toBe("true");
    expect(card("crate").getAttribute("aria-selected")).toBe("false");
    fireEvent.click(await screen.findByTestId("scene-assets-menu-select"));
    await waitFor(() => expect(card("crate").getAttribute("aria-selected")).toBe("true"));
    expect(card("stack").getAttribute("aria-selected")).toBe("true");

    fireEvent.contextMenu(card("stack"), { clientX: 40, clientY: 40 });
    expect((await screen.findByTestId("scene-assets-menu-place")).textContent).toContain("Place 2 Assets");
    fireEvent.click(screen.getByTestId("scene-assets-menu-deselect"));
    await waitFor(() => expect(card("stack").getAttribute("aria-selected")).toBe("false"));
    expect(card("crate").getAttribute("aria-selected")).toBe("true");
  });

  it("switches to a list whose rows keep the same entries", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("scene-assets-view-list"));
    const rows = within(screen.getByTestId("scene-assets-list")).getAllByRole("treeitem");
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "tree-row-asset-cone",
      "tree-row-asset-crate",
      "tree-row-asset-door",
      "tree-row-asset-stack",
    ]);
    expect(rows[2]!.textContent).toContain("Actor Class");
  });
});
