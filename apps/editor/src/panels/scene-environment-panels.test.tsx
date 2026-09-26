import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { FoliageGroup, SerializedScene } from "@babylonslate/core";
import { FoliageGroupsPanel, FoliageSettingsPanel, LandscapeSettingsPanel } from "./scene-environment-panels";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const MODEL = "00000000-0000-4000-8000-000000000010";
const harness = vi.hoisted(() => ({
  groups: [] as FoliageGroup[],
  tools: {} as Record<string, unknown>,
  applySceneChange: vi.fn<(id: string, scene: SerializedScene) => Promise<boolean>>(async () => true),
}));

function scene(): SerializedScene {
  return { actors: [], settings: { foliageGroups: harness.groups } } as unknown as SerializedScene;
}

vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "scene:main" }) }));
vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [{ id: "scene:main", ref: { kind: "scene" }, content: scene() }],
    applySceneChange: harness.applySceneChange,
    assetRegistry: { list: () => [{ path: "assets/tree.babasset", header: { guid: MODEL, name: "Tree", type: "Model" } }] },
  }),
}));
vi.mock("../context/scene-editing-context", () => ({ useSceneEditing: () => ({ selectedActorIds: [], selectActor: vi.fn(), frameActor: vi.fn() }) }));
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

afterEach(() => { cleanup(); harness.groups = []; harness.applySceneChange.mockClear(); });

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

describe("Foliage Settings", () => {
  it("explains why Paint Foliage cannot place instances", () => {
    harness.groups = [{ id: "g", name: "Trees", models: [] }];
    setTools({ foliageTool: "paint", groupId: null });
    render(<FoliageSettingsPanel {...panel} />);
    expect(screen.getByTestId("foliage-settings-blocked").textContent).toMatch(/Pick a Foliage Group/);
    cleanup();
    setTools({ foliageTool: "paint", groupId: "g" });
    render(<FoliageSettingsPanel {...panel} />);
    expect(screen.getByTestId("foliage-settings-blocked").textContent).toMatch(/Add Models/);
    cleanup();
    harness.groups = [{ id: "g", name: "Trees", models: [{ modelGuid: MODEL, materialGuid: null, weight: 1, minScale: 1, maxScale: 1 }] }];
    render(<FoliageSettingsPanel {...panel} />);
    expect(screen.queryByTestId("foliage-settings-blocked")).toBeNull();
  });
});

describe("Landscape Settings", () => {
  it("shows the brush settings the active tool uses", () => {
    setTools({ landscapeTool: "flatten" });
    render(<LandscapeSettingsPanel {...panel} />);
    expect(screen.getByLabelText("Flatten Height")).toBeTruthy();
    expect(screen.queryByTestId("property-row-layer")).toBeNull();
    cleanup();
    setTools({ landscapeTool: "paint" });
    render(<LandscapeSettingsPanel {...panel} />);
    expect(screen.getByTestId("property-row-layer")).toBeTruthy();
    expect(screen.queryByLabelText("Flatten Height")).toBeNull();
  });
});
