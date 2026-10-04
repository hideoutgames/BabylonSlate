import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedComponent, SerializedScene, ShadowSettings, RenderPath } from "@babylonslate/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  createRichText2DComponent,
  createText2DComponent,
  createText3DComponent,
  createSceneStreamingActor,
  eulerDegreesToQuaternion,
  identitySerializedTransform,
  normalizeScene,
  normalizeShadowSettings,
  quaternionToEulerDegrees,
} from "@babylonslate/core";
import { AssetCreateProvider } from "@babylonslate/editor-kit";
import { SceneDetailsPanel } from "./scene-details-panel";
import { diffSceneCommands, EditSession } from "@babylonslate/edit";
import type { SceneShapeEditTarget } from "../context/scene-editing-context";

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

const harness = vi.hoisted(() => ({
  selectedActorIds: [] as string[],
  shapeEditTarget: null as SceneShapeEditTarget | null,
  setShapeEditTarget: vi.fn<(target: SceneShapeEditTarget | null) => void>(),
  scene: null as SerializedScene | null,
  prefabComponents: [] as SerializedComponent[],
  documentKind: "scene" as "scene" | "scene-layer",
  documentId: "scene:assets/Main.scene.babasset",
  render: { mode: "pbr" as "pbr" | "cel", cel: { shadowBands: 4 }, shadows: undefined as ShadowSettings | undefined, renderPath: undefined as RenderPath | undefined },
  applySceneChange: vi.fn<
    (id: string, scene: SerializedScene) => Promise<boolean>
  >(async () => true),
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: harness.documentId }),
}));

vi.mock("../context/scene-editing-context", () => ({
  useSceneEditing: () => ({
    selectedActorIds: harness.selectedActorIds,
    setSelectedActorIds: vi.fn(),
    shapeEditTarget: harness.shapeEditTarget,
    setShapeEditTarget: harness.setShapeEditTarget,
  }),
  selectionAfterLockChange: (ids: string[]) => ids,
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: harness.documentId,
        ref: {
          kind: harness.documentKind,
          path: "assets/Main.scene.babasset",
          label: "Main Scene",
        },
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
        render: harness.render,
      },
    },
    assetRegistry: {
      list: () => [
        ...(harness.prefabComponents.length ? [{
          header: {
            guid: "class-rich-label", name: "RichLabel", type: "Class", parentClass: "Actor",
            payload: { components: harness.prefabComponents },
          },
          path: "assets/RichLabel.class.babasset",
        }] : []),
        {
          header: { guid: "scene-cave", name: "Cave", type: "Scene", parentClass: null },
          path: "assets/Cave.scene.babasset",
        },
        {
          header: {
            guid: "mesh-1",
            name: "Rock",
            type: "Mesh",
            parentClass: null,
          },
          path: "assets/Rock.mesh.babasset",
        },
        {
          header: {
            guid: "tex-1",
            name: "Atlas",
            type: "Texture",
            parentClass: null,
          },
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
              header: {
                guid: "mesh-1", name: "Rock", type: "Mesh",
                payload: { materialSlots: [{ index: 0, name: "Rock", materialGuid: "mat-rock" }] },
              },
              path: "assets/Rock.mesh.babasset",
            }
          : undefined,
    },
  }),
}));

beforeEach(() => {
  harness.selectedActorIds = [];
  harness.shapeEditTarget = null;
  harness.setShapeEditTarget.mockReset();
  harness.documentKind = "scene";
  harness.documentId = "scene:assets/Main.scene.babasset";
  harness.render.mode = "pbr";
  harness.render.shadows = undefined;
  harness.render.renderPath = undefined;
  harness.scene = createDefaultScene();
  harness.prefabComponents = [];
  harness.applySceneChange.mockClear();
});

afterEach(() => {
  cleanup();
});

function scene() {
  if (!harness.scene) throw new Error("scene fixture missing");
  return harness.scene;
}

describe("scene shape editing", () => {
  it("targets a later spline independently of component disclosure without changing the scene", () => {
    scene().actors = [createActor("paths", "Paths", { components: [
      { id: "river", classId: "WaterRiverComponent", properties: {} },
      { id: "curve", classId: "SplineComponent", properties: {} },
      createMeshComponent("mesh", "box"),
    ] })];
    harness.selectedActorIds = ["paths"];
    const panel = () => <SceneDetailsPanel {...({} as IDockviewPanelProps)} />;
    const view = render(panel());
    const riverHeader = screen.getByRole("button", { name: /^Water River$/ });
    fireEvent.click(riverHeader);
    expect(riverHeader.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("button", { name: /^Edit .* In Viewport$/ })).toHaveLength(2);
    expect(screen.getByTestId("component-shape-edit-river").getAttribute("aria-pressed")).toBe("true");
    const curveTarget = screen.getByTestId("component-shape-edit-curve");
    fireEvent.click(curveTarget);
    expect(harness.setShapeEditTarget).toHaveBeenLastCalledWith({ actorId: "paths", componentId: "curve" });
    harness.shapeEditTarget = harness.setShapeEditTarget.mock.lastCall![0];
    view.rerender(panel());
    expect(curveTarget.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("component-shape-edit-river").getAttribute("aria-pressed")).toBe("false");
    expect(riverHeader.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("component-shape-edit-river"));
    expect(harness.setShapeEditTarget).toHaveBeenLastCalledWith({ actorId: "paths", componentId: "river" });
    expect(harness.applySceneChange).not.toHaveBeenCalled();
  });

  it("disables shape targeting for locked actors and multiple selected actors", () => {
    const actor = createActor("path", "Path", { components: [{ id: "curve", classId: "SplineComponent", properties: {} }], locked: true });
    scene().actors = [actor, createActor("other", "Other")];
    harness.selectedActorIds = [actor.id];
    const panel = () => <SceneDetailsPanel {...({} as IDockviewPanelProps)} />;
    const view = render(panel());
    expect(screen.getByTestId("component-shape-edit-curve").hasAttribute("disabled")).toBe(true);
    actor.locked = false;
    harness.selectedActorIds = [actor.id, "other"];
    view.rerender(panel());
    fireEvent.click(screen.getByTestId("component-shape-edit-curve"));
    expect(harness.setShapeEditTarget).not.toHaveBeenCalled();
  });
});

describe("constraint target authoring", () => {
  it("allows cable attachment to an actor without physics and clears the previous component target", async () => {
    const owner = createActor("cable-owner", "Cable", { components: [
      { id: "cable", classId: "CableComponent", properties: { targetActorId: null, targetComponentId: "old-hook" } },
    ] });
    scene().actors = [owner, createActor("attachment", "Empty Hook")];
    harness.selectedActorIds = [owner.id];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("property-cable-owner-cable-targetActorId"));
    fireEvent.click(screen.getByRole("option", { name: /Empty Hook/ }));
    await waitFor(() => expect(harness.applySceneChange).toHaveBeenCalled());
    const saved = normalizeScene(JSON.parse(JSON.stringify(harness.applySceneChange.mock.calls.at(-1)![1])));
    // The end attaches at the picked actor's origin rather than the old local offset.
    expect(saved.actors[0]!.components[0]!.properties).toMatchObject({ targetActorId: "attachment", targetComponentId: null, endPosition: [0, 0, 0] });
  });

  it("selects a physical actor by name and persists the target through the scene change path", async () => {
    const owner = createActor("joint-owner", "Pendulum", { components: [
      { id: "body", classId: "RigidBodyComponent", properties: {} },
      { id: "joint", classId: "PhysicsConstraintComponent", properties: { kind: "hinge", targetActorId: "" } },
    ] });
    const anchor = createActor("anchor", "Ceiling", { components: [createMeshComponent("anchor-mesh", "box")] });
    const decoration = createActor("decoration", "Decoration", { components: [{ ...createMeshComponent("decor-mesh", "box"), properties: { collisionMode: "none" } }] });
    const terrain = createActor("terrain", "Terrain", { components: [{ id: "landscape", classId: "LandscapeComponent", properties: { collisionsEnabled: true } }] });
    const floating = createActor("float", "Float", { components: [{ id: "buoyancy", classId: "WaterBuoyancyComponent", properties: {} }] });
    scene().actors = [owner, anchor, decoration, terrain, floating, createActor("empty", "Empty")];
    harness.selectedActorIds = [owner.id];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("property-joint-owner-joint-targetActorId"));
    expect(screen.queryByRole("option", { name: /Pendulum/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Decoration/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /^Empty/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Terrain/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Float/ })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search Physics Actors"), { target: { value: "Ceil" } });
    fireEvent.click(screen.getByRole("option", { name: /Ceiling/ }));
    await waitFor(() => expect(harness.applySceneChange).toHaveBeenCalled());
    const next = harness.applySceneChange.mock.calls.at(-1)![1];
    const saved = normalizeScene(JSON.parse(JSON.stringify(next)));
    expect(saved.actors[0]!.components.find((component) => component.id === "joint")!.properties).toMatchObject({ kind: "hinge", targetActorId: "anchor" });
    expect(saved.actors[1]).toEqual(anchor);
  });
});

describe("shared actor Details", () => {
  beforeEach(() => {
    scene().actors = [
      createActor("a", "Alpha", {
        transform: {
          position: [1, 2, 3],
          rotation: eulerDegreesToQuaternion([10, 20, 30]),
          scale: [1, 2, 3],
        },
      }),
      createActor("b", "Beta", {
        transform: {
          position: [4, 5, 6],
          rotation: eulerDegreesToQuaternion([15, 25, 35]),
          scale: [4, 5, 6],
        },
      }),
      createActor("control", "Control"),
    ];
    harness.selectedActorIds = ["a", "b"];
  });

  it.each([
    [
      "position",
      "x",
      "1.0",
      [
        [1, 2, 3],
        [1, 5, 6],
      ],
    ],
    [
      "position",
      "y",
      "9",
      [
        [1, 9, 3],
        [4, 9, 6],
      ],
    ],
    [
      "scale",
      "z",
      "7",
      [
        [1, 2, 7],
        [4, 5, 7],
      ],
    ],
  ] as const)(
    "edits only the shared %s %s axis, including the primary actor's existing value",
    (property, axis, value, expected) => {
      render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
      fireEvent.change(
        screen.getByTestId(`property-actor-${property}-${axis}`),
        { target: { value } },
      );
      const next = harness.applySceneChange.mock.calls.at(-1)![1];
      expect(
        next.actors.slice(0, 2).map((actor) => actor.transform[property]),
      ).toEqual(expected);
      expect(next.actors[2]).toEqual(scene().actors[2]);
    },
  );

  it("keeps each actor's other Euler axes when editing shared rotation", () => {
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.change(screen.getByTestId("property-actor-rotation-x"), {
      target: { value: "40" },
    });
    const next = harness.applySceneChange.mock.calls.at(-1)![1];
    for (const [index, expected] of [
      [40, 20, 30],
      [40, 25, 35],
    ].entries()) {
      const rotation = quaternionToEulerDegrees(
        next.actors[index]!.transform.rotation,
      );
      expected.forEach((value, axis) =>
        expect(rotation[axis]).toBeCloseTo(value),
      );
    }
  });

  it("shows differing axes as Mixed and resets the whole selected property", () => {
    scene().actors[0]!.transform.position = [0, 0, 0];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(
      (screen.getByTestId("property-actor-position-x") as HTMLInputElement)
        .placeholder,
    ).toBe("Mixed");
    const reset = screen.getByTestId(
      "property-actor-position-reset",
    ) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    const next = harness.applySceneChange.mock.calls.at(-1)![1];
    expect(
      next.actors.slice(0, 2).map((actor) => actor.transform.position),
    ).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });

  it("edits shared 2D Z-Order without copying XY from the primary actor", () => {
    scene().viewportMode = "2d";
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.change(screen.getByTestId("property-actor-z-order"), {
      target: { value: "8" },
    });
    const next = harness.applySceneChange.mock.calls.at(-1)![1];
    expect(
      next.actors.slice(0, 2).map((actor) => actor.transform.position),
    ).toEqual([
      [1, 2, 8],
      [4, 5, 8],
    ]);
  });

  it("treats shared 2D scale as default when only hidden Z differs", () => {
    scene().viewportMode = "2d";
    scene().actors[0]!.transform.scale = [1, 1, 3];
    scene().actors[1]!.transform.scale = [1, 1, 6];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(
      (screen.getByTestId("property-actor-scale-reset") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("edits shared visibility without renaming other selected actors", () => {
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("property-actor-visible"));
    const next = harness.applySceneChange.mock.calls.at(-1)![1];
    expect(next.actors.map((actor) => actor.visible)).toEqual([
      false,
      false,
      true,
    ]);
    fireEvent.change(screen.getByTestId("property-actor-name"), {
      target: { value: "Renamed" },
    });
    expect(
      harness.applySceneChange.mock.calls
        .at(-1)![1]
        .actors.map((actor) => actor.name),
    ).toEqual(["Renamed", "Beta", "Control"]);
  });

  it("shows mixed visibility and applies the checked state to the selection", () => {
    scene().actors[1]!.visible = false;
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    const visible = screen.getByTestId("property-actor-visible");
    expect(visible.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(visible);
    expect(
      harness.applySceneChange.mock.calls
        .at(-1)![1]
        .actors.map((actor) => actor.visible),
    ).toEqual([true, true, true]);
  });

  it("keeps component removal restricted to the primary actor", () => {
    scene().actors[0]!.components = [createMeshComponent("mesh-a", "box")];
    scene().actors[1]!.components = [createMeshComponent("mesh-b", "sphere")];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("primary-actor-grid").textContent).toContain(
      "Primary Actor: Alpha",
    );
    fireEvent.click(screen.getByTestId("component-remove-mesh-a"));
    const next = harness.applySceneChange.mock.calls.at(-1)![1];
    expect(next.actors[0]!.components).toEqual([]);
    expect(next.actors[1]!.components).toEqual(scene().actors[1]!.components);
  });
});

describe("SceneDetailsPanel authoring", () => {
  it("edits an Outliner anchor's offsets without exposing a transform or visibility", () => {
    scene().actors = [createActor("pin", "2D Anchor", { components: [
      { id: "anchor", classId: "2DAnchorComponent", properties: { anchor: "topLeft", offsetX: 0, offsetY: 0 } },
    ] })];
    scene().viewportMode = "2d";
    harness.documentKind = "scene-layer";
    harness.selectedActorIds = ["pin"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    for (const id of ["actor-position-x", "actor-rotation-z", "actor-scale-x", "actor-z-order", "actor-visible"]) {
      expect(screen.queryByTestId(`property-${id}`)).toBeNull();
    }
    fireEvent.change(screen.getByTestId("property-pin-anchor-offsetX"), { target: { value: "3" } });
    expect(harness.applySceneChange.mock.calls.at(-1)![1].actors[0]!.components[0]!.properties.offsetX).toBe(3);
  });

  it("excludes Outliner anchors from mixed-selection transform and visibility edits", () => {
    scene().actors = [
      createActor("pin", "2D Anchor", { components: [{ id: "anchor", classId: "2DAnchorComponent", properties: {} }] }),
      createActor("visual", "Visual"),
    ];
    scene().actors[0]!.visible = false;
    harness.selectedActorIds = ["pin", "visual"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.change(screen.getByTestId("property-actor-position-x"), { target: { value: "9" } });
    const next = harness.applySceneChange.mock.calls.at(-1)![1];
    expect(next.actors[0]!.transform).toEqual(identitySerializedTransform());
    expect(next.actors[1]!.transform.position).toEqual([9, 0, 0]);
    const visible = screen.getByTestId("property-actor-visible");
    expect(visible.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(visible);
    expect(harness.applySceneChange.mock.calls.at(-1)![1].actors.map((actor) => actor.visible)).toEqual([false, false]);
  });

  it("shows inherited model materials and lets None persist and reset through the Material picker", async () => {
    harness.selectedActorIds = ["actor-1"];
    const mesh = createMeshComponent("mesh", "box");
    mesh.properties.assetGuid = "mesh-1";
    scene().actors[0]!.components = [mesh];
    const view = render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    const materialButton = () => screen.getByTestId("property-actor-1-mesh-materialGuid");
    expect(materialButton().textContent).toContain("Rock");
    fireEvent.click(materialButton());
    fireEvent.click(await screen.findByTestId("search-item-__none__"));
    harness.scene = harness.applySceneChange.mock.calls.at(-1)![1];
    view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(materialButton().textContent).toContain("None");
    expect(scene().actors[0]!.components[0]!.properties).toMatchObject({
      materialGuid: null, materialSource: "override",
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset Material" }));
    harness.scene = harness.applySceneChange.mock.calls.at(-1)![1];
    view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(materialButton().textContent).toContain("Rock");
    expect(scene().actors[0]!.components[0]!.properties).toMatchObject({
      materialGuid: null,
    });
    expect(scene().actors[0]!.components[0]!.properties).not.toHaveProperty("materialSource");
  });

  it("starts rendering override categories closed and restores manual collapse state after search", () => {
    harness.render.mode = "cel";
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    const shadows = () => screen.getByRole("button", { name: "Shadows" });
    const cel = () => screen.getByRole("button", { name: "CEL Shading" });
    const environment = () => screen.getByRole("button", { name: "Environment Lighting" });
    const search = (value: string) => fireEvent.change(screen.getByRole("textbox", { name: "Filter Properties" }), { target: { value } });
    expect(shadows().getAttribute("aria-expanded")).toBe("false");
    expect(cel().getAttribute("aria-expanded")).toBe("false");
    expect(environment().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("property-scene-environment-texture")).toBeNull();
    search("environment rotation");
    expect(environment().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Environment Rotation")).toBeTruthy();
    expect(screen.getByTestId("property-scene-environment-texture")).toBeTruthy();
    search("");
    expect(environment().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Shadow Distance")).toBeNull();
    search("normal bias");
    expect(shadows().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Shadow Normal Bias")).toBeTruthy();
    expect(screen.queryByTestId("scene-post-process-stack")).toBeNull();
    search("");
    expect(shadows().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(shadows());
    search("shadow distance");
    fireEvent.click(shadows());
    expect(shadows().getAttribute("aria-expanded")).toBe("false");
    search("");
    expect(shadows().getAttribute("aria-expanded")).toBe("true");
    expect(cel().getAttribute("aria-expanded")).toBe("false");
    expect(harness.applySceneChange).not.toHaveBeenCalled();
  });

  it("keeps disclosure separate from override data and resets to live project shadows", () => {
    harness.render.shadows = normalizeShadowSettings({ distance: 200 });
    const view = render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByRole("button", { name: "Shadows" }));
    fireEvent.click(screen.getByRole("button", { name: "Override Shadow Distance" }));
    harness.scene = harness.applySceneChange.mock.calls.at(-1)![1];
    expect(scene().settings.shadowOverrides).toEqual({ distance: 200 });
    fireEvent.click(screen.getByRole("button", { name: "Shadows" }));
    harness.render.shadows = normalizeShadowSettings({ distance: 350 });
    view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByRole("button", { name: "Shadows" }));
    expect(screen.getByLabelText("Shadow Distance")).toHaveProperty("value", "200");
    fireEvent.click(screen.getByRole("button", { name: "Reset Shadow Distance" }));
    harness.scene = harness.applySceneChange.mock.calls.at(-1)![1];
    view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(scene().settings.shadowOverrides).toEqual({});
    expect(screen.getByLabelText("Shadow Distance")).toHaveProperty("value", "350");
  });

  it("filters properties and reveals matching collapsed component fields", () => {
    harness.selectedActorIds = ["actor-1"];
    scene().actors[0]!.components = [createMeshComponent("mesh-a", "box")];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    const toggle = screen.getByRole("button", { name: "Mesh" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("property-actor-1-mesh-a-meshKind")).toBeNull();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Filter Properties" }),
      {
        target: { value: "mesh kind" },
      },
    );
    expect(screen.getByTestId("property-actor-1-mesh-a-meshKind")).toBeTruthy();
    expect(screen.queryByTestId("property-actor-name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mesh" }));
    expect(
      screen.getByRole("textbox", { name: "Filter Properties" }),
    ).toHaveProperty("value", "mesh kind");
    expect(screen.queryByTestId("property-actor-1-mesh-a-meshKind")).toBeNull();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Filter Properties" }),
      {
        target: { value: "not a property" },
      },
    );
    expect(screen.queryByTestId("component-card-mesh-a")).toBeNull();
    expect(screen.getByText("No Matching Properties")).toBeTruthy();
  });

  it("opens an AssetPicker for mesh assetGuid and shows the asset name", async () => {
    harness.selectedActorIds = ["actor-1"];
    scene().actors[0]!.components.push(
      createMeshComponent("component-1", "box"),
    );
    scene().actors[0]!.components[0]!.properties.assetGuid = "mesh-1";
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    const button = screen.getByTestId("property-actor-1-component-1-assetGuid");
    expect(button.textContent).toContain("Rock");
    expect(button.textContent).toContain("Mesh");
    expect(button.textContent).not.toContain("mesh-1");
    expect(
      button
        .querySelector("[data-type-family]")
        ?.getAttribute("data-type-family"),
    ).toBe("model");
    fireEvent.click(button);
    expect(await screen.findByTestId("search-item-mesh-1")).toBeTruthy();
    expect(screen.queryByTestId("search-item-tex-1")).toBeNull();
  });

  it("creates a Render Target from the capture picker and assigns it in one scene edit", async () => {
    const createAsset = vi.fn(async () => "rt-new");
    scene().actors = [createActor("cam", "Capture", { components: [
      { id: "capture", classId: "RenderTargetCaptureComponent", properties: {} },
    ] })];
    harness.selectedActorIds = ["cam"];
    render(
      <AssetCreateProvider
        value={{
          canCreate: (type) => type === "RenderTarget",
          typeLabel: () => "Render Target",
          createAsset,
        }}
      >
        <SceneDetailsPanel {...({} as IDockviewPanelProps)} />
      </AssetCreateProvider>,
    );
    fireEvent.click(screen.getByTestId("property-cam-capture-renderTargetGuid"));
    const create = await screen.findByTestId("search-item-__create__RenderTarget");
    expect(create.textContent).toContain("Create New Render Target");
    fireEvent.click(create);
    await waitFor(() => expect(harness.applySceneChange).toHaveBeenCalledTimes(1));
    expect(createAsset).toHaveBeenCalledWith({ type: "RenderTarget" });
    const saved = harness.applySceneChange.mock.calls[0]![1];
    expect(saved.actors[0]!.components[0]!.properties.renderTargetGuid).toBe("rt-new");
    await waitFor(() => expect(screen.queryByTestId("details-asset-picker")).toBeNull());
  });

  it("selects and clears a streaming scene and its read-only name in one document edit", async () => {
    scene().actors = [createSceneStreamingActor("stream")];
    harness.selectedActorIds = ["stream"];
    const view = render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    const target = () => screen.getByTestId("property-stream-stream-scene-streaming-sceneGuid");
    expect(screen.getByTestId("component-transform-grid-stream-scene-streaming")).toBeTruthy();
    expect(screen.getByTestId("property-stream-stream-scene-streaming-position-x")).toBeTruthy();
    expect(screen.getByTestId("text3d-text-stream-scene-name")).toHaveProperty("disabled", true);
    fireEvent.click(target());
    expect(await screen.findByTestId("search-item-scene-cave")).toBeTruthy();
    expect(screen.queryByTestId("search-item-mesh-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-scene-cave"));
    expect(harness.applySceneChange).toHaveBeenCalledTimes(1);
    const selected = harness.applySceneChange.mock.calls[0]![1];
    expect(selected.actors[0]?.components[0]?.properties).toEqual({ sceneGuid: "scene-cave", sceneName: "Cave" });
    expect(selected.actors[0]?.components[1]?.properties.text).toBe("Cave");
    harness.scene = selected;
    view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(target());
    fireEvent.click(await screen.findByTestId("search-item-__none__"));
    expect(harness.applySceneChange).toHaveBeenCalledTimes(2);
    const cleared = harness.applySceneChange.mock.calls[1]![1];
    expect(cleared.actors[0]?.components[0]?.properties).toEqual({ sceneGuid: "", sceneName: "" });
    expect(cleared.actors[0]?.components[1]?.properties.text).toBe("No Scene");
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
    expect(
      screen.getByTestId("property-actor-1-col-1-shape-kind"),
    ).toBeTruthy();
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
    expect(
      screen.getByTestId("property-actor-1-col-1-position-x"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("property-actor-1-col-1-rotation-x"),
    ).toBeTruthy();
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

  it("reveals mode-specific controls when fog is enabled and keeps volumetric guidance searchable", () => {
    const view = render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("property-scene-fog")).toBeTruthy();
    expect(screen.queryByTestId("property-scene-fog-mode")).toBeNull();
    expect(screen.queryByTestId("property-scene-fog-color")).toBeNull();
    expect(screen.queryByTestId("property-scene-fog-start")).toBeNull();
    expect(screen.queryByTestId("property-scene-fog-end")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Properties" }), {
      target: { value: "volumetric" },
    });
    expect(screen.getByTestId("property-scene-fog")).toBeTruthy();
    expect(screen.queryByTestId("property-scene-name")).toBeNull();
    expect(harness.applySceneChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Properties" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("property-scene-fog"));
    harness.scene = harness.applySceneChange.mock.calls.at(-1)![1];
    view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(scene().settings.fogEnabled).toBe(true);
    expect(screen.getByTestId("property-scene-fog-mode").textContent).toContain("Linear");
    expect(screen.getByTestId("property-scene-fog-color")).toBeTruthy();
    expect(screen.getByTestId("property-scene-fog-start")).toBeTruthy();
    expect(screen.getByTestId("property-scene-fog-end")).toBeTruthy();
    expect(screen.queryByTestId("property-scene-fog-density")).toBeNull();
  });

  it("switches exponential fog modes and resets individual controls without losing authored values", async () => {
    Object.assign(scene().settings, {
      fogEnabled: true,
      fogStart: 25,
      fogEnd: 350,
      fogDensity: 0.00125,
      fogColor: [0.2, 0.3, 0.4],
    });
    const view = render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    const applyChange = () => {
      harness.scene = harness.applySceneChange.mock.calls.at(-1)![1];
      view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    };
    fireEvent.click(screen.getByTestId("property-scene-fog-mode"));
    const exponential = await screen.findByRole("option", { name: "Exponential" });
    fireEvent.pointerDown(exponential);
    fireEvent.click(exponential);
    applyChange();
    expect(scene().settings.fogMode).toBe("exponential");
    expect(screen.queryByTestId("property-scene-fog-start")).toBeNull();
    expect(screen.queryByTestId("property-scene-fog-end")).toBeNull();
    expect(screen.getByTestId("property-scene-fog-density")).toHaveProperty("value", "0.00125");
    fireEvent.change(screen.getByTestId("property-scene-fog-density"), {
      target: { value: "0.000125" },
    });
    applyChange();
    fireEvent.blur(screen.getByTestId("property-scene-fog-density"));
    expect(screen.getByTestId("property-scene-fog-density")).toHaveProperty("value", "0.000125");

    fireEvent.click(screen.getByTestId("property-scene-fog-mode"));
    const exponentialSquared = await screen.findByRole("option", { name: "Exponential Squared" });
    fireEvent.pointerDown(exponentialSquared);
    fireEvent.click(exponentialSquared);
    applyChange();
    expect(scene().settings).toMatchObject({
      fogMode: "exponentialSquared",
      fogStart: 25,
      fogEnd: 350,
      fogDensity: 0.000125,
      fogColor: [0.2, 0.3, 0.4],
    });
    expect(screen.queryByTestId("property-scene-fog-start")).toBeNull();
    expect(screen.getByTestId("property-scene-fog-density")).toHaveProperty("value", "0.000125");
    fireEvent.click(screen.getByRole("button", { name: "Reset Fog Density" }));
    applyChange();
    expect(scene().settings).toMatchObject({ fogDensity: 0.01, fogMode: "exponentialSquared" });

    fireEvent.click(screen.getByRole("button", { name: "Reset Fog Mode" }));
    applyChange();
    expect(scene().settings).toMatchObject({ fogMode: "linear", fogDensity: 0.01 });
    expect(screen.getByTestId("property-scene-fog-start")).toHaveProperty("value", "25");
    expect(screen.getByTestId("property-scene-fog-end")).toHaveProperty("value", "350");
    fireEvent.click(screen.getByTestId("property-scene-fog"));
    applyChange();
    expect(screen.queryByTestId("property-scene-fog-mode")).toBeNull();
    expect(scene().settings).toMatchObject({
      fogEnabled: false, fogMode: "linear", fogStart: 25, fogEnd: 350,
      fogDensity: 0.01, fogColor: [0.2, 0.3, 0.4],
    });
  });

  it("keeps linear fog distances ordered when either distance crosses the other", () => {
    Object.assign(scene().settings, { fogEnabled: true, fogStart: 10, fogEnd: 20 });
    const view = render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.change(screen.getByTestId("property-scene-fog-start"), {
      target: { value: "30" },
    });
    harness.scene = harness.applySceneChange.mock.calls.at(-1)![1];
    expect(scene().settings.fogStart).toBe(30);
    expect(scene().settings.fogEnd).toBeCloseTo(30.01);
    view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.change(screen.getByTestId("property-scene-fog-end"), {
      target: { value: "5" },
    });
    harness.scene = harness.applySceneChange.mock.calls.at(-1)![1];
    expect(scene().settings.fogStart).toBeCloseTo(4.99);
    expect(scene().settings.fogEnd).toBe(5);
    view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.change(screen.getByTestId("property-scene-fog-end"), {
      target: { value: "-10" },
    });
    expect(harness.applySceneChange.mock.calls.at(-1)![1].settings).toMatchObject({
      fogStart: 0, fogEnd: 0.01,
    });
  });

  it("clamps negative exponential density to zero without changing other fog settings", () => {
    Object.assign(scene().settings, {
      fogEnabled: true, fogMode: "exponential", fogStart: 25, fogEnd: 350,
    });
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.change(screen.getByTestId("property-scene-fog-density"), {
      target: { value: "-0.5" },
    });
    expect(harness.applySceneChange.mock.calls.at(-1)![1].settings).toMatchObject({
      fogEnabled: true, fogMode: "exponential", fogDensity: 0, fogStart: 25, fogEnd: 350,
    });
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
    expect(
      screen.getByTestId("actor-transform-grid").textContent,
    ).not.toContain("Cube");
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
      { id: expect.any(String), materialGuid: "pp-blur", enabled: true },
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
    fireEvent.click(
      screen.getByTestId("add-component-catalog-item-asset-mesh-1"),
    );
    expect(harness.applySceneChange).toHaveBeenCalled();
    const next = harness.applySceneChange.mock.calls[0]![1] as SerializedScene;
    const added = next.actors[0]?.components.at(-1);
    expect(added?.classId).toBe("MeshComponent");
    expect(added?.properties).toMatchObject({
      meshKind: "box",
      assetGuid: "mesh-1",
    });
  });

  it("adds a distinct component after deleting a middle row without changing the remaining component", () => {
    const actor = createActor("actor-1", "Actor", { components: [
      createMeshComponent("actor-1-component-1", "box"),
      { id: "actor-1-component-3", classId: "PointLightComponent", properties: { intensity: 5 } },
    ] });
    scene().actors = [actor];
    const before = scene();
    harness.selectedActorIds = [actor.id];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("details-add-component"));
    fireEvent.click(screen.getByTestId("add-component-catalog-item-asset-mesh-1"));
    const intended = harness.applySceneChange.mock.lastCall![1];
    const result = new EditSession().applyBatch("scene", before, diffSceneCommands(before, intended))!;
    const components = result.doc.actors[0]!.components;
    expect(components).toHaveLength(3);
    expect(new Set(components.map((component) => component.id)).size).toBe(3);
    expect(components[1]).toEqual(actor.components[1]);
    expect(components[2]).toMatchObject({ classId: "MeshComponent", properties: { assetGuid: "mesh-1" } });
  });

  it("reorders, disables, and removes a post-process pass", () => {
    scene().settings.postProcessStack = [
      { materialGuid: "pp-a", enabled: true },
      { materialGuid: "pp-b", enabled: true },
    ];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("scene-post-process-stack-1-move-up"));
    const reordered = harness.applySceneChange.mock
      .calls[0]![1] as SerializedScene;
    expect(
      reordered.settings.postProcessStack.map((entry) => entry.materialGuid),
    ).toEqual(["pp-b", "pp-a"]);
    fireEvent.click(screen.getByTestId("scene-post-process-0-enabled"));
    const toggled = harness.applySceneChange.mock.calls.at(
      -1,
    )![1] as SerializedScene;
    expect(toggled.settings.postProcessStack[0]?.enabled).toBe(false);
    fireEvent.click(screen.getByTestId("scene-post-process-stack-0-remove"));
    const removed = harness.applySceneChange.mock.calls.at(
      -1,
    )![1] as SerializedScene;
    expect(removed.settings.postProcessStack).toHaveLength(1);
  });

  it("authors a SceneLayer spawn list on world Scene Options", async () => {
    const actorIds = scene().actors.map((actor) => actor.id);
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
    expect(next.actors.map((actor) => actor.id)).toEqual(actorIds);
  });

  it("opens selectable immutable Entry IDs on demand and preserves each repeated pass through reordering", async () => {
    scene().settings.postProcessStack = [
      { id: "first-tint", materialGuid: "pp-blur", enabled: true },
      { id: "disabled-tint", materialGuid: "pp-blur", enabled: false },
    ];
    const view = render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    const open = async (pass: number) => {
      fireEvent.click(screen.getByRole("button", { name: `Pass ${pass} Entry ID` }));
      return await screen.findByRole("textbox", { name: "Entry ID" }) as HTMLInputElement;
    };
    const close = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    };
    expect(screen.queryByRole("textbox", { name: "Entry ID" })).toBeNull();
    const first = await open(1);
    expect(first.value).toBe("first-tint");
    fireEvent.focus(first);
    expect(first.disabled).toBe(false);
    expect(first.readOnly).toBe(true);
    expect(first.value.slice(first.selectionStart!, first.selectionEnd!)).toBe("first-tint");
    fireEvent.change(first, { target: { value: "changed" } });
    fireEvent.blur(first);
    expect(harness.applySceneChange).not.toHaveBeenCalled();
    await close();
    expect((await open(2)).value).toBe("disabled-tint");
    await close();
    fireEvent.click(screen.getByTestId("scene-post-process-stack-1-move-up"));
    harness.scene = harness.applySceneChange.mock.calls.at(-1)![1];
    view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect((await open(1)).value).toBe("disabled-tint");
    await close();
    expect((await open(2)).value).toBe("first-tint");
  });

  it("moves and removes repeated post-process assets with their own enabled state", () => {
    scene().settings.postProcessStack = [
      { id: "a", materialGuid: "pp-blur", enabled: true },
      { id: "b", materialGuid: "pp-blur", enabled: false, scalable: true },
    ];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("scene-post-process-stack-1-move-up"));
    expect(
      harness.applySceneChange.mock.calls.at(-1)![1].settings.postProcessStack,
    ).toEqual([
      { id: "b", materialGuid: "pp-blur", enabled: false, scalable: true },
      { id: "a", materialGuid: "pp-blur", enabled: true },
    ]);
    fireEvent.click(screen.getByTestId("scene-post-process-stack-0-remove"));
    expect(
      harness.applySceneChange.mock.calls.at(-1)![1].settings.postProcessStack,
    ).toEqual([{ id: "b", materialGuid: "pp-blur", enabled: false, scalable: true }]);
  });

  it("retains pass identity and scalability when replacing its Material", async () => {
    scene().settings.postProcessStack = [
      { id: "retained", materialGuid: "pp-old", enabled: false, scalable: true },
    ];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("scene-post-process-0-material"));
    fireEvent.click(await screen.findByTestId("search-item-pp-blur"));
    expect(harness.applySceneChange.mock.calls.at(-1)![1].settings.postProcessStack).toEqual([
      { id: "retained", materialGuid: "pp-blur", enabled: false, scalable: true },
    ]);
  });

  it("targets the picked pass by ID if its owner reorders while the picker is open", async () => {
    const a = { id: "a", materialGuid: "pp-old", enabled: true };
    const b = { id: "b", materialGuid: "pp-other", enabled: false };
    scene().settings.postProcessStack = [a, b];
    const { rerender } = render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("scene-post-process-0-material"));
    await screen.findByTestId("search-item-pp-blur");
    scene().settings.postProcessStack = [b, a];
    rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("search-item-pp-blur"));
    expect(harness.applySceneChange.mock.calls.at(-1)![1].settings.postProcessStack).toEqual([
      b, { ...a, materialGuid: "pp-blur" },
    ]);
  });

  it("keeps repeated layers' Z-Order and enabled state when moving and editing them", () => {
    scene().settings.sceneLayers = [
      { assetGuid: "layer-hud", zOrder: 2, enabled: true },
      { assetGuid: "layer-hud", zOrder: 8, enabled: false },
    ];
    const { rerender } = render(
      <SceneDetailsPanel {...({} as IDockviewPanelProps)} />,
    );
    fireEvent.click(screen.getByTestId("scene-layers-stack-1-move-up"));
    const reordered = harness.applySceneChange.mock.calls.at(-1)![1];
    expect(reordered.settings.sceneLayers).toEqual([
      { assetGuid: "layer-hud", zOrder: 8, enabled: false },
      { assetGuid: "layer-hud", zOrder: 2, enabled: true },
    ]);
    harness.scene = reordered;
    rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Layer 1 Z-Order" }), {
      target: { value: "12" },
    });
    expect(
      harness.applySceneChange.mock.calls.at(-1)![1].settings.sceneLayers,
    ).toEqual([
      { assetGuid: "layer-hud", zOrder: 12, enabled: false },
      { assetGuid: "layer-hud", zOrder: 2, enabled: true },
    ]);
    fireEvent.click(screen.getByRole("switch", { name: "Layer 1 Enabled" }));
    expect(
      harness.applySceneChange.mock.calls.at(-1)![1].settings.sceneLayers[0],
    ).toEqual({ assetGuid: "layer-hud", zOrder: 8, enabled: true });
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
    expect(
      screen.queryByTestId("property-scene-environment-texture"),
    ).toBeNull();
    expect(screen.queryByTestId("scene-layers-stack")).toBeNull();
    expect(
      screen.queryByTestId("property-scene-game-instance-class"),
    ).toBeNull();
    expect(
      screen.getByTestId("property-row-scene-camera-bounds-width"),
    ).toBeTruthy();
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

  it("hosts 3D Text in a sibling read-only trigger that opens a modal editor", () => {
    scene().actors = [
      createActor("label", "3D Text", {
        components: [createText3DComponent("text3d")],
      }),
    ];
    harness.selectedActorIds = ["label"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.queryByTestId("property-label-text3d-text")).toBeNull();
    expect(screen.getByTestId("property-label-text3d-alignment")).toBeTruthy();
    const trigger = screen.getByTestId("text3d-text-text3d");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.textContent).toContain("Text");
    fireEvent.click(trigger);
    const field = screen.getByTestId(
      "text3d-text-text3d-editor",
    ) as HTMLTextAreaElement;
    expect(field.value).toBe("Text");
    fireEvent.change(field, { target: { value: "Hello\nWorld" } });
    fireEvent.click(screen.getByTestId("text3d-text-text3d-done"));
    expect(harness.applySceneChange).toHaveBeenCalled();
    const next = harness.applySceneChange.mock.calls[0]![1] as SerializedScene;
    expect(next.actors[0]?.components[0]?.properties.text).toBe("Hello\nWorld");
  });

  it("hosts 2D Text in a sibling read-only trigger that opens a modal editor", () => {
    scene().actors = [
      createActor("hud", "Label", {
        components: [createText2DComponent("label")],
      }),
    ];
    harness.selectedActorIds = ["hud"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.queryByTestId("property-hud-label-text")).toBeNull();
    const trigger = screen.getByTestId("text2d-text-label");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.textContent).toContain("Text");
    fireEvent.click(trigger);
    const field = screen.getByTestId(
      "text2d-text-label-editor",
    ) as HTMLTextAreaElement;
    expect(field.value).toBe("Text");
    fireEvent.change(field, { target: { value: "Hello overlay" } });
    fireEvent.click(screen.getByTestId("text2d-text-label-done"));
    expect(harness.applySceneChange).toHaveBeenCalled();
    const next = harness.applySceneChange.mock.calls[0]![1] as SerializedScene;
    expect(next.actors[0]?.components[0]?.properties.text).toBe(
      "Hello overlay",
    );
  });

  it("hosts 2D Rich Text markup in a sibling trigger", () => {
    scene().actors = [
      createActor("hud", "Rich", {
        components: [createRichText2DComponent("rich")],
      }),
    ];
    harness.selectedActorIds = ["hud"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.queryByTestId("property-hud-rich-text")).toBeNull();
    expect(screen.getByTestId("text2d-text-rich").textContent).toContain(
      "[color=green]",
    );
  });

  it("resets a rich-text mode override to its prefab's modes", () => {
    const prefab = createRichText2DComponent("prefab-rich");
    prefab.properties.appearModes = ["fade"];
    harness.prefabComponents = [prefab];
    scene().actors = [createActor("hud", "Rich", {
      classId: "RichLabel",
      components: [{
        ...prefab, id: "rich", sourceId: "prefab-rich", overrideKeys: ["appearModes"],
        properties: { ...prefab.properties, appearModes: ["scale"] },
      }],
    })];
    harness.selectedActorIds = ["hud"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset Appear Modes" }));
    const next = harness.applySceneChange.mock.calls.at(-1)![1];
    expect(next.actors[0]?.components[0]?.properties.appearModes).toEqual(["fade"]);
  });

  it("opens markup tag suggestions for 2D Rich Text in the modal editor", () => {
    scene().actors = [
      createActor("hud", "Rich", {
        components: [createRichText2DComponent("rich")],
      }),
    ];
    harness.selectedActorIds = ["hud"];
    render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("text2d-text-rich"));
    const field = screen.getByTestId(
      "text2d-text-rich-editor",
    ) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "[" } });
    field.setSelectionRange(1, 1);
    fireEvent.select(field);
    expect(
      screen.getByTestId("text2d-text-rich-editor-suggestions"),
    ).toBeTruthy();
    expect(screen.getByTestId("search-item-tag:b")).toBeTruthy();
  });
});


it("hides scene CEL overrides in PBR and persists only explicitly overridden fields", () => {
  const view = render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
  expect(screen.queryByTestId("scene-cel-settings")).toBeNull();
  harness.render.mode = "cel";
  view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
  fireEvent.click(screen.getByRole("button", { name: "CEL Shading" }));
  expect((screen.getByLabelText("Shadow Bands") as HTMLInputElement).value).toBe("4");
  fireEvent.click(screen.getByRole("button", { name: "Override Shadow Bands" }));
  const next = harness.applySceneChange.mock.calls.at(-1)![1];
  expect(next.settings.celShading).toEqual({ shadowBands: 4 });
  harness.scene = next;
  view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
  fireEvent.click(screen.getByRole("button", { name: "Reset Shadow Bands To Project Settings" }));
  expect(harness.applySceneChange.mock.calls.at(-1)![1].settings.celShading).toEqual({});
  harness.render.mode = "pbr";
  view.rerender(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
  expect(screen.queryByTestId("scene-cel-settings")).toBeNull();
});


it("exposes no Scene Render Path control; the path is project-wide only", () => {
  harness.render.renderPath = "auto";
  render(<SceneDetailsPanel {...({} as IDockviewPanelProps)} />);
  expect(screen.queryByRole("button", { name: "Rendering" })).toBeNull();
  expect(screen.queryByTestId("scene-render-path")).toBeNull();
  expect(screen.queryByTestId("project-render-path")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter Properties" }), { target: { value: "Render Path" } });
  expect(screen.queryByTestId("scene-render-path")).toBeNull();
  expect(harness.applySceneChange).not.toHaveBeenCalled();
});
