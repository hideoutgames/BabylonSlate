import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SerializedScene } from "@babylonslate/core";
import { createActor, createDefaultScene } from "@babylonslate/core";
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
  applySceneChange: vi.fn(async () => true),
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "scene:assets/Main.scene.babasset" }),
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
        id: "scene:assets/Main.scene.babasset",
        ref: { kind: "scene", path: "assets/Main.scene.babasset", label: "Main Scene" },
        content: harness.scene,
        layout: null,
        dirty: false,
      },
    ],
    applySceneChange: harness.applySceneChange,
    projectDocument: {
      settings: { twoD: { sortingLayers: ["Background", "Default", "UI"] } },
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
    const mesh = scene().actors[0]?.components[0];
    if (mesh) mesh.properties.assetGuid = "mesh-1";
    render(<SceneDetailsPanel {...({} as never)} />);
    const button = screen.getByTestId("property-actor-1-component-1-assetGuid");
    expect(button.textContent).toContain("Rock");
    expect(button.textContent).not.toContain("mesh-1");
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
    render(<SceneDetailsPanel {...({} as never)} />);
    expect(screen.getByTestId("property-actor-1-col-1-shape-kind")).toBeTruthy();
    expect(screen.queryByTestId("property-actor-1-col-1-shape")).toBeNull();
    expect(screen.queryByDisplayValue("[object Object]")).toBeNull();
  });

  it("picks Game Instance from ClassPicker instead of a free text field", async () => {
    render(<SceneDetailsPanel {...({} as never)} />);
    const trigger = screen.getByTestId("property-scene-game-instance-class");
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    expect(await screen.findByTestId("search-item-GameInstance")).toBeTruthy();
    expect(screen.getByTestId("search-item-MyGame")).toBeTruthy();
    fireEvent.click(screen.getByTestId("search-item-MyGame"));
    expect(harness.applySceneChange).toHaveBeenCalled();
  });
});
