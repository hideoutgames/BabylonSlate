import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@haptic/core";
import { createMeshComponent } from "@haptic/core";
import { InspectorPanel } from "./inspector-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";

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

const applyGraphChange = vi.hoisted(() =>
  vi.fn<(id: string, graph: SerializedGraph) => Promise<boolean>>(
    async () => true,
  ),
);
const sceneEditing = vi.hoisted(() => ({ viewportMode: "3d" as "2d" | "3d" }));
const classState = vi.hoisted(() => ({ parentClass: "Actor" }));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "graph:assets/Hero.class.hasset",
  }),
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [
    {
      id: "graph:assets/Hero.class.hasset",
      ref: {
        kind: "graph",
        path: "assets/Hero.class.hasset",
        label: "Hero Class",
      },
      content: {
        nodes: [],
        edges: [],
        members: [
          { id: "var-1", kind: "variable", name: "Health", typeId: "bool" },
        ],
        components: [
          createMeshComponent("prefab-mesh", "box"),
          {
            ...createMeshComponent("prefab-sphere", "sphere"),
            properties: { ...createMeshComponent("prefab-sphere", "sphere").properties, castShadows: false },
            transform: { position: [2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { id: "prefab-movement", classId: "MovementComponent", properties: {} },
        ],
      },
      layout: null,
      dirty: false,
    },
    {
      id: "graph:assets/Quiet.class.hasset",
      ref: { kind: "graph", path: "assets/Quiet.class.hasset", label: "Quiet Class" },
      content: { nodes: [], edges: [], actorDefaults: { generateHitEvents: false, eventTick: "disabled" } },
      layout: null,
      dirty: false,
    },
  ],
  applyGraphChange,
  assetRegistry: (() => {
    const assets = () => [
      {
        path: "assets/Hero.class.hasset",
        header: {
          type: "Class",
          name: "Hero",
          parentClass: classState.parentClass,
          guid: "hero-1",
        },
      },
      {
        path: "assets/Quiet.class.hasset",
        header: { type: "Class", name: "Quiet", parentClass: "Actor", guid: "quiet-1" },
      },
    ];
    return { list: assets, getByPath: (path: string) => assets().find((asset) => asset.path === path) };
  })(),
  projectDocument: {
    settings: {
      twoD: { sortingLayers: ["Default"] },
    },
  },
  reparentClassDocument: vi.fn(async () => null),
})));

vi.mock("../context/scene-editing-context", () => ({
  useOptionalSceneEditing: () => ({ viewportMode: sceneEditing.viewportMode }),
}));

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({
    focusDiagnostic: null,
    setFocusDiagnostic: vi.fn(),
  }),
}));

vi.mock("../context/play-context", () => ({
  usePlay: () => ({ focusedNodeId: null }),
  usePlayFocusedNodeId: () => null,
  usePlaySimulationDocumentId: () => null,
}));

function renderInspector(options?: {
  selectedComponentId?: string | null;
  selectedComponentIds?: string[];
  selectedMemberId?: string | null;
}) {
  return render(
    <PrefabEditingProvider
      initialSelectedId={options && "selectedComponentId" in options ? options.selectedComponentId : PREFAB_ROOT_ID}
      initialSelectedIds={options?.selectedComponentIds}
    >
      <GraphEditingProvider
        initialSelectedMemberId={options?.selectedMemberId ?? null}
      >
        <InspectorPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>
    </PrefabEditingProvider>,
  );
}

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
  sceneEditing.viewportMode = "3d";
  classState.parentClass = "Actor";
});

describe("Inspector prefab component details", () => {
  it("shows Mesh Kind when a prefab component is selected", () => {
    renderInspector({ selectedComponentId: "prefab-mesh" });
    expect(screen.getByTestId("inspector-prefab-component")).toBeTruthy();
    expect(
      screen.getByTestId("property-prefab-root-prefab-mesh-meshKind"),
    ).toBeTruthy();
  });

  it("shows Position Rotation and Scale for the selected prefab component", () => {
    renderInspector({ selectedComponentId: "prefab-mesh" });
    expect(
      screen.getByTestId("property-vector3-prefab-mesh-position"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("property-vector3-prefab-mesh-rotation"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("property-vector3-prefab-mesh-scale"),
    ).toBeTruthy();
    expect(screen.getByTestId("property-prefab-mesh-position-z")).toBeTruthy();
    expect(screen.queryByTestId("property-prefab-mesh-z-order")).toBeNull();
  });

  it.each(["2d", "3d"] as const)("edits the Movement capsule instead of an ineffective local transform in %s", (mode) => {
    sceneEditing.viewportMode = mode;
    renderInspector({ selectedComponentId: "prefab-movement" });
    expect(screen.queryByTestId("prefab-component-transform-grid")).toBeNull();
    const radius = screen.getByTestId("property-prefab-root-prefab-movement-radius");
    fireEvent.change(radius, { target: { value: "0.6" } });
    fireEvent.blur(radius);
    const movement = applyGraphChange.mock.calls.at(-1)![1].components?.find(
      (component) => component.id === "prefab-movement",
    );
    expect(movement?.properties.radius).toBe(0.6);
    expect(movement?.transform).toBeUndefined();
  });

  it("keeps class member details when Prefab Root is selected", () => {
    renderInspector({
      selectedComponentId: PREFAB_ROOT_ID,
      selectedMemberId: "var-1",
    });
    expect(screen.getByTestId("inspector-member-variable")).toBeTruthy();
    expect(screen.queryByTestId("inspector-prefab-component")).toBeNull();
  });

  it("shows Parent Class on Prefab Root", () => {
    renderInspector({ selectedComponentId: PREFAB_ROOT_ID });
    expect(screen.getByTestId("inspector-parent-class").textContent).toContain(
      "Actor",
    );
  });

  it("shows Prefab Origin on Prefab Root", () => {
    renderInspector({ selectedComponentId: PREFAB_ROOT_ID });
    expect(screen.getByTestId("inspector-prefab-origin")).toBeTruthy();
  });

  it("shows Actor Defaults on Prefab Root and persists generate flags", () => {
    renderInspector({ selectedComponentId: PREFAB_ROOT_ID });
    expect(screen.getByTestId("inspector-actor-defaults")).toBeTruthy();
    expect(screen.getByTestId("inspector-prefab-origin")).toBeTruthy();
    expect(screen.getByText("Actor Defaults")).toBeTruthy();
    const hit = screen.getByTestId("property-generateHitEvents");
    expect(hit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(hit);
    expect(applyGraphChange).toHaveBeenCalled();
    const next = applyGraphChange.mock.calls.at(-1)![1];
    expect(next.actorDefaults?.generateHitEvents).toBe(false);
    const overlap = screen.getByTestId("property-generateOverlapEvents");
    expect(overlap.hasAttribute("disabled")).toBe(false);
    fireEvent.click(overlap);
    expect(applyGraphChange.mock.calls.at(-1)![1].actorDefaults?.generateOverlapEvents).toBe(false);
  });

  it.each(["Object", "GameInstance", "ActorComponent"])(
    "does not show Actor Defaults or Prefab Origin for %s classes",
    (parentClass) => {
      classState.parentClass = parentClass;
      renderInspector({ selectedComponentId: PREFAB_ROOT_ID });
      expect(screen.queryByTestId("inspector-actor-defaults")).toBeNull();
      expect(screen.queryByTestId("inspector-prefab-origin")).toBeNull();
      expect(screen.getByTestId("inspector-parent-class").textContent).toContain(parentClass);
    },
  );

  it("shows Tick On Pause in Actor Defaults, off unless set, and writes it as an override", () => {
    renderInspector({ selectedComponentId: PREFAB_ROOT_ID });
    const tickOnPause = screen.getByTestId("property-tickOnPause");
    expect(tickOnPause.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(tickOnPause);
    expect(applyGraphChange.mock.calls.at(-1)![1].actorDefaults).toEqual({ tickOnPause: true });
  });

  it("shows Tags in Actor Defaults", () => {
    renderInspector({ selectedComponentId: PREFAB_ROOT_ID });
    expect(screen.getByTestId("inspector-actor-defaults").contains(screen.getByTestId("property-actorTags"))).toBe(true);
  });

  it("shows Game Instance Defaults with Tick On Pause beside a Game Instance class's Parent Class", () => {
    classState.parentClass = "GameInstance";
    renderInspector({ selectedComponentId: PREFAB_ROOT_ID });
    expect(screen.getByTestId("inspector-parent-class").textContent).toContain("GameInstance");
    const tickOnPause = screen.getByTestId("property-tickOnPause");
    expect(tickOnPause.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(tickOnPause);
    const next = applyGraphChange.mock.calls.at(-1)![1];
    expect(next.gameInstanceDefaults).toEqual({ tickOnPause: true });
    expect(next.actorDefaults).toBeUndefined();
  });

  it("shows an actor class's Parent Class and Actor Defaults when nothing is selected, without the Prefab Origin note", () => {
    renderInspector({ selectedComponentId: null });
    expect(screen.getByTestId("inspector-parent-class").textContent).toContain("Actor");
    expect(screen.getByTestId("inspector-actor-defaults")).toBeTruthy();
    expect(screen.queryByTestId("inspector-prefab-origin")).toBeNull();
    fireEvent.click(screen.getByTestId("property-tickOnPause"));
    expect(applyGraphChange.mock.calls.at(-1)![1].actorDefaults).toEqual({ tickOnPause: true });
  });

  it("shows a Game Instance class's Game Instance Defaults when nothing is selected", () => {
    classState.parentClass = "GameInstance";
    renderInspector({ selectedComponentId: null });
    expect(screen.getByTestId("inspector-game-instance-defaults")).toBeTruthy();
    expect(screen.queryByTestId("inspector-actor-defaults")).toBeNull();
    fireEvent.click(screen.getByTestId("property-tickOnPause"));
    expect(applyGraphChange.mock.calls.at(-1)![1].gameInstanceDefaults).toEqual({ tickOnPause: true });
  });

  it.each(["Actor", "Object"])("shows no Game Instance Defaults for %s classes", (parentClass) => {
    classState.parentClass = parentClass;
    renderInspector({ selectedComponentId: PREFAB_ROOT_ID });
    expect(screen.queryByTestId("inspector-game-instance-defaults")).toBeNull();
  });

  it("shows inherited Actor Defaults and writes only overrides", async () => {
    classState.parentClass = "Quiet";
    renderInspector({ selectedComponentId: PREFAB_ROOT_ID });
    await waitFor(() =>
      expect(screen.getByTestId("property-eventTick").textContent).toContain("Inherit (Disabled)"),
    );
    const hit = screen.getByTestId("property-generateHitEvents");
    expect(hit.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(hit);
    expect(applyGraphChange.mock.calls.at(-1)![1].actorDefaults).toEqual({ generateHitEvents: true });
    fireEvent.click(screen.getByTestId("property-eventTick"));
    const enabled = await screen.findByRole("option", { name: "Enabled" });
    fireEvent.pointerDown(enabled);
    fireEvent.click(enabled);
    await waitFor(() =>
      expect(applyGraphChange.mock.calls.at(-1)![1].actorDefaults).toEqual({ eventTick: "enabled" }),
    );
  });

  it("shows the Details two selected components share, with Mixed Values where they differ", () => {
    renderInspector({ selectedComponentIds: ["prefab-mesh", "prefab-sphere"] });
    expect(screen.getByTestId("inspector-prefab-multi").textContent).toContain("2 Components");
    expect(screen.queryByTestId("inspector-prefab-component")).toBeNull();
    expect(screen.getByTestId("property-prefab-root-prefab-mesh-meshKind").textContent).toContain("Mixed Values");
    expect((screen.getByTestId("property-prefab-mesh-position-x") as HTMLInputElement).value).toBe("Mixed Values");
    expect((screen.getByTestId("property-prefab-mesh-position-y") as HTMLInputElement).value).toBe("0");
  });

  it("sets a value on every selected component in one change", () => {
    renderInspector({ selectedComponentIds: ["prefab-mesh", "prefab-sphere"] });
    fireEvent.click(screen.getByTestId("property-prefab-root-prefab-mesh-castShadows"));
    expect(applyGraphChange).toHaveBeenCalledTimes(1);
    const components = applyGraphChange.mock.calls[0]![1].components!;
    expect(components.find((component) => component.id === "prefab-mesh")?.properties.castShadows).toBe(true);
    expect(components.find((component) => component.id === "prefab-sphere")?.properties.castShadows).toBe(true);
    expect(components.find((component) => component.id === "prefab-sphere")?.properties.meshKind).toBe("sphere");
  });

  it("moves each selected component from its own Position when Mixed Values+4 is typed", () => {
    renderInspector({ selectedComponentIds: ["prefab-mesh", "prefab-sphere"] });
    const x = screen.getByTestId("property-prefab-mesh-position-x");
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: "Mixed Values+4" } });
    expect(applyGraphChange).toHaveBeenCalledTimes(1);
    const components = applyGraphChange.mock.calls[0]![1].components!;
    expect(components.find((component) => component.id === "prefab-mesh")?.transform?.position).toEqual([4, 0, 0]);
    expect(components.find((component) => component.id === "prefab-sphere")?.transform?.position).toEqual([6, 0, 0]);
  });

  it("hides the rows and Transform only one selected component has", () => {
    renderInspector({ selectedComponentIds: ["prefab-mesh", "prefab-movement"] });
    expect(screen.getByTestId("inspector-prefab-multi").textContent).toContain("2 Components");
    expect(screen.queryByTestId("property-prefab-root-prefab-mesh-meshKind")).toBeNull();
    expect(screen.queryByTestId("property-prefab-root-prefab-movement-radius")).toBeNull();
    expect(screen.queryByTestId("prefab-component-transform-grid")).toBeNull();
  });

  it("shows editable Actor Defaults for an engine Actor subclass", () => {
    classState.parentClass = "SceneLayerActor";
    renderInspector({ selectedComponentId: PREFAB_ROOT_ID });
    fireEvent.click(screen.getByTestId("property-generateOverlapEvents"));
    expect(applyGraphChange.mock.calls.at(-1)![1].actorDefaults?.generateOverlapEvents).toBe(false);
  });
});
