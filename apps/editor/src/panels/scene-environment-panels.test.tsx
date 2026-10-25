import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { FoliageGroup, SerializedScene } from "@haptic/core";
import { FoliageGroupsPanel, LandscapeOutlinerPanel } from "./scene-environment-panels";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const MODEL = "00000000-0000-4000-8000-000000000010";
const harness = vi.hoisted(() => ({
  groups: [] as FoliageGroup[],
  tools: {} as Record<string, unknown>,
  applySceneChange: vi.fn<(id: string, scene: SerializedScene) => Promise<boolean>>(async () => true),
  selectActor: vi.fn(),
  frameActor: vi.fn(),
}));

function scene(): SerializedScene {
  return { actors: [], settings: { foliageGroups: harness.groups } } as unknown as SerializedScene;
}

vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "scene:main" }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "scene:main", ref: { kind: "scene" }, content: scene() }],
  applySceneChange: harness.applySceneChange,
  assetRegistry: { list: () => [{ path: "assets/tree.hasset", header: { guid: MODEL, name: "Tree", type: "Model" } }] },
})));
vi.mock("../context/scene-editing-context", () => ({ useSceneEditing: () => ({ selectedActorIds: [], selectActor: harness.selectActor, frameActor: harness.frameActor }) }));
vi.mock("../context/scene-tools-context", () => ({ useSceneTools: () => harness.tools }));

const panel = {} as IDockviewPanelProps;

function setTools(overrides: Record<string, unknown>) {
  harness.tools = {
    landscapeTool: "navigate", landscapeBrush: { tool: "raise", radius: 4, strength: 0.25, falloff: 0.5, height: 0, layer: 0 }, landscapeSelection: null,
    foliageTool: "navigate", foliageBrush: { radius: 4, density: 0.25, spacing: 0.5, maxSlope: 60, alignToNormal: true, randomYaw: true },
    groupId: null, setGroupId: vi.fn(), setLandscapeBrush: vi.fn(), setFoliageBrush: vi.fn(), setLandscapeSelection: vi.fn(),
    ...overrides,
  };
}

afterEach(() => { cleanup(); harness.groups = []; harness.applySceneChange.mockClear(); harness.selectActor.mockClear(); harness.frameActor.mockClear(); });

describe("Landscape Outliner", () => {
  it("selects a created landscape without moving the camera", async () => {
    setTools({});
    render(<LandscapeOutlinerPanel {...panel} />);
    fireEvent.click(screen.getByRole("button", { name: "Create Landscape" }));
    const actor = harness.applySceneChange.mock.calls.at(-1)![1].actors[0]!;
    expect(actor.components.map((component) => component.classId)).toEqual(["LandscapeComponent"]);
    await waitFor(() => expect(harness.selectActor).toHaveBeenCalledWith(actor.id));
    expect(harness.tools.setLandscapeSelection).toHaveBeenCalledWith(`${actor.id}/${actor.components[0]!.id}`);
    expect(harness.frameActor).not.toHaveBeenCalled();
  });
});

describe("Foliage Groups", () => {
  it("keeps a Model's scale range ordered when Min passes Max", () => {
    harness.groups = [{ id: "g", name: "Trees", models: [{ modelGuid: MODEL, materialGuid: null, weight: 1, minScale: 0.8, maxScale: 1.2 }] }];
    setTools({ groupId: "g" });
    render(<FoliageGroupsPanel {...panel} />);
    expect(screen.getByTestId("foliage-model-0-name").textContent).toBe("Tree");
    fireEvent.change(screen.getByLabelText("Scale Range Min"), { target: { value: "2" } });
    const saved = harness.applySceneChange.mock.calls.at(-1)![1];
    expect(saved.settings.foliageGroups![0]!.models[0]).toMatchObject({ minScale: 2, maxScale: 2 });
  });
});

