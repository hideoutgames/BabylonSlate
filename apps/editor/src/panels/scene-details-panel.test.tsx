import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedScene } from "@babylonslate/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  createRichText2DComponent,
  createText2DComponent,
  identitySerializedTransform,
  normalizeScene,
} from "@babylonslate/core";
import { SceneDetailsPanel } from "./scene-details-panel";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const harness = vi.hoisted(() => ({
  selectedActorIds: [] as string[],
  scene: null as SerializedScene | null,
  documentKind: "scene" as "scene" | "scene-layer",
  documentId: "scene:assets/Main.scene.babasset",
  applySceneChange: vi.fn<(id: string, scene: SerializedScene) => Promise<boolean>>(
    async () => true,
  ),
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: harness.documentId }),
}));

vi.mock("../context/scene-editing-context", () => ({
  useSceneEditing: () => ({
    selectedActorIds: harness.selectedActorIds,
    setSelectedActorIds: vi.fn(),
  }),
  selectionAfterLockChange: (ids: string[]) => ids,
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: harness.documentId,
        ref: { kind: harness.documentKind, path: "assets/Main.scene.babasset", label: "Main Scene" },
        content: harness.scene,
        layout: null,
        dirty: false,
      },
    ],
    applySceneChange: harness.applySceneChange,
    projectDocument: {
      settings: {
        twoD: { sortingLayers: ["Background", "Default", "UI"] },
        gameInstanceClass: "MyGame",
      },
    },
    assetRegistry: {
      list: () => [
        {
          header: { guid: "mesh-1", name: "Rock", type: "Mesh", parentClass: null },
          path: "assets/Rock.mesh.babasset",
        },
        {
          header: { guid: "tex-1", name: "Atlas", type: "Texture", parentClass: null },
          path: "assets/Atlas.texture.babasset",
        },
        {
          header: {
            guid: "class-1",
            name: "MyGame",
            type: "Class",
            parentClass: "GameInstance",
          },
          path: "assets/MyGame.class.babasset",
        },
        {
          header: {
            guid: "pp-blur",
            name: "Blur",
            type: "Material",
            parentClass: null,
            payload: { domain: "postProcess" },
          },
          path: "assets/Blur.material.babasset",
        },
        {
          header: {
            guid: "mat-rock",
            name: "Rock",
            type: "Material",
            parentClass: null,
            payload: { domain: "surface" },
          },
          path: "assets/Rock.material.babasset",
        },
        {
          header: {
            guid: "layer-hud",
            name: "HUD",
            type: "SceneLayer",
            parentClass: null,
          },
          path: "assets/Hud.scenelayer.babasset",
        },
      ],
      getByGuid: (guid: string) =>
        guid === "mesh-1"
          ? {
              header: { guid: "mesh-1", name: "Rock", type: "Mesh" },
              path: "assets/Rock.mesh.babasset",
            }
          : undefined,
    },
  }),
}));

beforeEach(() => {
  harness.selectedActorIds = [];
  harness.documentKind = "scene";
  harness.documentId = "scene:assets/Main.scene.babasset";
  harness.scene = createDefaultScene();
  harness.applySceneChange.mockClear();
});

afterEach(() => {
  cleanup();
});

function scene() {
  if (!harness.scene) throw new Error("scene fixture missing");
  return harness.scene;
}

describe("SceneDetailsPanel authoring", () => {
  it("opens an AssetPicker for mesh assetGuid and shows the asset name", async () => {
    harness.selectedActorIds = ["actor-1"];
    scene().actors[0]!.components.push(createMeshComponent("component-1", "box"));
    scene().actors[0]!.components[0]!.properties.assetGuid = "mesh-1";
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    const button = screen.getByTestId("property-actor-1-component-1-assetGuid");
    expect(button.textContent).toContain("Rock");
    expect(button.textContent).toContain("Mesh");
    expect(button.textContent).not.toContain("mesh-1");
    expect(button.querySelector("[data-type-family]")?.getAttribute("data-type-family")).toBe(
      "model",
    );
    fireEvent.click(button);
    expect(await screen.findByTestId("search-item-mesh-1")).toBeTruthy();
    expect(screen.queryByTestId("search-item-tex-1")).toBeNull();
  });

  it("edits collider shape kind as an enum instead of object text", () => {
    scene().actors = [
      createActor("actor-1", "Body", {
        components: [
          {
            id: "col-1",
            classId: "ColliderComponent",
            properties: {
              shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
              friction: 0.5,
              restitution: 0,
              isTrigger: false,
              layer: 1,
              mask: 1,
            },
          },
        ],
      }),
    ];
    harness.selectedActorIds = ["actor-1"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("property-actor-1-col-1-shape-kind")).toBeTruthy();
    expect(screen.queryByTestId("property-actor-1-col-1-shape")).toBeNull();
    expect(screen.queryByDisplayValue("[object Object]")).toBeNull();
  });

  it("shows ColliderComponent local Transform rows", () => {
    scene().actors = [
      createActor("actor-1", "Body", {
        components: [
          {
            id: "col-1",
            classId: "ColliderComponent",
            properties: {
              shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
              friction: 0.5,
              restitution: 0,
              isTrigger: false,
              layer: 1,
              mask: 1,
            },
          },
        ],
      }),
    ];
    harness.selectedActorIds = ["actor-1"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("collider-transform-grid-col-1")).toBeTruthy();
    expect(screen.getByTestId("property-actor-1-col-1-position-x")).toBeTruthy();
    expect(screen.getByTestId("property-actor-1-col-1-rotation-x")).toBeTruthy();
    expect(screen.getByTestId("property-actor-1-col-1-scale-x")).toBeTruthy();
  });

  it("shows a Bake NavMesh action on NavMeshComponent details", () => {
    scene().actors = [
      createActor("nav", "NavMesh", {
        components: [
          {
            id: "navmesh",
            classId: "NavMeshComponent",
            properties: { cellSize: 0.2, tiled: false },
          },
        ],
      }),
    ];
    harness.selectedActorIds = ["nav"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("navmesh-bake-navmesh")).toBeTruthy();
  });

  it("renders scene settings for a sparse payload after normalizeScene", () => {
    harness.scene = normalizeScene({ name: "Legacy", actors: [] });
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("scene-settings-grid")).toBeTruthy();
    expect(screen.getByTestId("property-scene-environment-color")).toBeTruthy();
  });

  it("hides Fog Color Start and End until Fog is enabled", () => {
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("property-scene-fog")).toBeTruthy();
    expect(screen.queryByTestId("property-scene-fog-color")).toBeNull();
    expect(screen.queryByTestId("property-scene-fog-start")).toBeNull();
    expect(screen.queryByTestId("property-scene-fog-end")).toBeNull();
    scene().settings.fogEnabled = true;
    cleanup();
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("property-scene-fog-color")).toBeTruthy();
    expect(screen.getByTestId("property-scene-fog-start")).toBeTruthy();
    expect(screen.getByTestId("property-scene-fog-end")).toBeTruthy();
  });

  it("shows Position Z in 3D and omits Z-Order", () => {
    harness.selectedActorIds = ["actor-1"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("property-actor-position-z")).toBeTruthy();
    expect(screen.queryByTestId("property-actor-z-order")).toBeNull();
  });

  it("shows Z-Order instead of Position Z in 2D and writes position z", () => {
    scene().viewportMode = "2d";
    const actor = scene().actors[0];
    if (!actor) throw new Error("default scene actor missing");
    actor.transform.position = [1, 2, 3];
    harness.selectedActorIds = ["actor-1"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.queryByTestId("property-actor-position-z")).toBeNull();
    expect(screen.getByTestId("property-actor-position-x")).toBeTruthy();
    expect(screen.getByTestId("property-actor-position-y")).toBeTruthy();
    const zOrder = screen.getByTestId("property-actor-z-order");
    expect((zOrder as HTMLInputElement).value).toBe("3");
    fireEvent.change(zOrder, { target: { value: "7" } });
    expect(harness.applySceneChange).toHaveBeenCalled();
    const next = harness.applySceneChange.mock.calls[0]![1] as SerializedScene;
    expect(next.actors[0]?.transform.position).toEqual([1, 2, 7]);
  });

  it("titles Details with the actor count when more than one actor is selected", () => {
    scene().actors = [
      createActor("actor-1", "Cube"),
      createActor("actor-2", "Sphere"),
    ];
    harness.selectedActorIds = ["actor-1", "actor-2"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("actor-transform-grid").textContent).toContain(
      "2 Actors",
    );
    expect(screen.getByTestId("actor-transform-grid").textContent).not.toContain(
      "Cube",
    );
  });

  it("shows the project Game Instance as a read-only pointer", () => {
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    const trigger = screen.getByTestId("property-scene-game-instance-class");
    expect(trigger.textContent).toContain("MyGame");
    expect(trigger.textContent).toContain("Class");
    expect(trigger).toHaveProperty("disabled", true);
    fireEvent.click(trigger);
    expect(screen.queryByTestId("scene-game-instance-picker")).toBeNull();
    expect(harness.applySceneChange).not.toHaveBeenCalled();
  });

  it("authors an ordered post-process stack of Material assets", async () => {
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("scene-post-process-stack")).toBeTruthy();
    fireEvent.click(screen.getByTestId("scene-post-process-stack-add"));
    expect(await screen.findByTestId("search-item-pp-blur")).toBeTruthy();
    fireEvent.click(screen.getByTestId("search-item-pp-blur"));
    expect(harness.applySceneChange).toHaveBeenCalled();
    const next = harness.applySceneChange.mock.calls[0]![1] as SerializedScene;
    expect(next.settings.postProcessStack).toEqual([
      { materialGuid: "pp-blur", enabled: true },
    ]);
  });

  it("lists only post-process Materials in the stack picker", async () => {
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("scene-post-process-stack-add"));
    expect(await screen.findByTestId("search-item-pp-blur")).toBeTruthy();
    expect(screen.queryByTestId("search-item-mat-rock")).toBeNull();
  });

  it("adds a project Mesh as MeshComponent with assetGuid set", () => {
    harness.selectedActorIds = ["actor-1"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("details-add-component"));
    fireEvent.click(screen.getByTestId("add-component-catalog-item-asset-mesh-1"));
    expect(harness.applySceneChange).toHaveBeenCalled();
    const next = harness.applySceneChange.mock.calls[0]![1] as SerializedScene;
    const added = next.actors[0]?.components.at(-1);
    expect(added?.classId).toBe("MeshComponent");
    expect(added?.properties).toMatchObject({
      meshKind: "box",
      assetGuid: "mesh-1",
    });
  });

  it("reorders, disables, and removes a post-process pass", () => {
    scene().settings.postProcessStack = [
      { materialGuid: "pp-a", enabled: true },
      { materialGuid: "pp-b", enabled: true },
    ];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("scene-post-process-stack-1-move-up"));
    const reordered = harness.applySceneChange.mock.calls[0]![1] as SerializedScene;
    expect(reordered.settings.postProcessStack.map((entry) => entry.materialGuid)).toEqual(
      ["pp-b", "pp-a"],
    );
    fireEvent.click(screen.getByTestId("scene-post-process-0-enabled"));
    const toggled = harness.applySceneChange.mock.calls.at(-1)![1] as SerializedScene;
    expect(toggled.settings.postProcessStack[0]?.enabled).toBe(false);
    fireEvent.click(screen.getByTestId("scene-post-process-stack-0-remove"));
    const removed = harness.applySceneChange.mock.calls.at(-1)![1] as SerializedScene;
    expect(removed.settings.postProcessStack).toHaveLength(1);
  });

  it("authors a SceneLayer spawn list on world Scene Options", async () => {
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("scene-layers-stack")).toBeTruthy();
    fireEvent.click(screen.getByTestId("scene-layers-stack-add"));
    expect(await screen.findByTestId("search-item-layer-hud")).toBeTruthy();
    fireEvent.click(screen.getByTestId("search-item-layer-hud"));
    expect(harness.applySceneChange).toHaveBeenCalled();
    const next = harness.applySceneChange.mock.calls[0]![1] as SerializedScene;
    expect(next.settings.sceneLayers).toEqual([
      { assetGuid: "layer-hud", zOrder: 0, enabled: true },
    ]);
  });

  it("shows overlay Details with gravity and post-process only", () => {
    harness.documentKind = "scene-layer";
    harness.documentId = "scene-layer:assets/Hud.scenelayer.babasset";
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("scene-settings-grid")).toBeTruthy();
    expect(screen.getByTestId("property-row-scene-gravity")).toBeTruthy();
    expect(screen.getByTestId("scene-post-process-stack")).toBeTruthy();
    expect(screen.queryByTestId("property-scene-viewport-mode")).toBeNull();
    expect(screen.queryByTestId("property-scene-physics-world")).toBeNull();
    expect(screen.queryByTestId("property-scene-default-camera")).toBeNull();
    expect(screen.queryByTestId("property-scene-fog")).toBeNull();
    expect(screen.queryByTestId("property-scene-environment-texture")).toBeNull();
    expect(screen.queryByTestId("scene-layers-stack")).toBeNull();
    expect(screen.queryByTestId("property-scene-game-instance-class")).toBeNull();
    expect(screen.getByTestId("property-row-scene-camera-bounds-width")).toBeTruthy();
    expect(screen.getByText("Layer Width")).toBeTruthy();
    expect(screen.getByText("Layer Height")).toBeTruthy();
  });

  it("hosts a 9-slice still-frame overlay for 2D Panel", () => {
    scene().actors = [
      createActor("hud", "Panel", {
        components: [
          {
            id: "panel",
            classId: "2DPanelComponent",
            properties: {
              source: "texture",
              textureGuid: null,
              materialGuid: null,
              marginLeft: 0,
              marginRight: 0,
              marginTop: 0,
              marginBottom: 0,
              hitTest: "ignore",
            },
            parentId: null,
            transform: identitySerializedTransform(),
          },
        ],
      }),
    ];
    harness.selectedActorIds = ["hud"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("panel-nine-slice-preview")).toBeTruthy();
    expect(screen.getByTestId("property-hud-panel-marginLeft")).toBeTruthy();
    expect(screen.queryByTestId("panel-nine-slice-overlay")).toBeNull();
  });

  it("hosts 2D Text in a sibling textarea instead of a PropertyGrid text row", () => {
    scene().actors = [
      createActor("hud", "Label", {
        components: [createText2DComponent("label")],
      }),
    ];
    harness.selectedActorIds = ["hud"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.queryByTestId("property-hud-label-text")).toBeNull();
    const field = screen.getByTestId("text2d-text-label") as HTMLTextAreaElement;
    expect(field.value).toBe("Text");
    fireEvent.change(field, { target: { value: "Hello overlay" } });
    expect(harness.applySceneChange).toHaveBeenCalled();
    const next = harness.applySceneChange.mock.calls[0]![1] as SerializedScene;
    expect(next.actors[0]?.components[0]?.properties.text).toBe("Hello overlay");
  });

  it("hosts 2D Rich Text markup in a sibling textarea", () => {
    scene().actors = [
      createActor("hud", "Rich", {
        components: [createRichText2DComponent("rich")],
      }),
    ];
    harness.selectedActorIds = ["hud"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.queryByTestId("property-hud-rich-text")).toBeNull();
    const field = screen.getByTestId("text2d-text-rich") as HTMLTextAreaElement;
    expect(field.value).toContain("[color=green]");
  });

  it("opens markup tag suggestions for 2D Rich Text", () => {
    scene().actors = [
      createActor("hud", "Rich", {
        components: [createRichText2DComponent("rich")],
      }),
    ];
    harness.selectedActorIds = ["hud"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    const field = screen.getByTestId("text2d-text-rich") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "[" } });
    field.setSelectionRange(1, 1);
    fireEvent.select(field);
    expect(screen.getByTestId("text2d-text-rich-suggestions")).toBeTruthy();
    expect(screen.getByTestId("search-item-tag:b")).toBeTruthy();
  });
});
