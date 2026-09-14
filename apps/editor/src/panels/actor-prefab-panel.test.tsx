import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createMeshComponent } from "@babylonslate/core";
import {
  ActorPrefabPanel,
  flattenPrefabComponents,
} from "./actor-prefab-panel";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";
import type { ProjectAddComponentAsset } from "./add-component-catalog";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const frameActor = vi.hoisted(() => vi.fn());
const setSelectedIds = vi.hoisted(() => vi.fn());
const harness = vi.hoisted(() => ({
  components: [] as Array<{ id: string; classId: string; parentId?: string | null }>,
  selectedId: "prefab-root" as string | null,
  selectedIds: ["prefab-root"] as string[],
  assets: [] as ProjectAddComponentAsset[],
}));

vi.mock("../context/prefab-editing-context", () => ({
  usePrefabEditing: () => ({
    components: harness.components,
    selectedId: harness.selectedId,
    selectedIds: harness.selectedIds,
    setSelectedIds,
    addComponent: vi.fn(),
    removeSelected: vi.fn(),
    reparentComponent: vi.fn(),
  }),
}));

vi.mock("../context/graph-editing-context", () => ({
  useGraphEditing: () => ({
    setSelectedMemberId: vi.fn(),
    setSelectedNodeIds: vi.fn(),
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: { list: () => harness.assets },
    openDocuments: [],
  }),
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "graph:assets/Hero.class.babasset" }),
}));

vi.mock("../context/scene-editing-context", () => ({
  useSceneEditing: () => ({
    frameActor,
  }),
}));

function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointerup",
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: 10,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

function doubleTap(rowId: string): void {
  const row = screen.getByTestId(`tree-row-${rowId}`);
  dispatchPointerEvent(row, "pointerdown");
  dispatchPointerEvent(row, "pointerup");
  dispatchPointerEvent(row, "pointerdown");
  dispatchPointerEvent(row, "pointerup");
}

afterEach(() => {
  cleanup();
  frameActor.mockClear();
  setSelectedIds.mockClear();
  harness.assets = [];
});

describe("flattenPrefabComponents", () => {
  it("nests children under a parentId", () => {
    const root = createMeshComponent("root", "box");
    const child = { ...createMeshComponent("child", "sphere"), parentId: "root" };
    const nodes = flattenPrefabComponents([root, child], new Set());
    expect(nodes.map((node) => ({ id: node.id, depth: node.depth }))).toEqual([
      { id: PREFAB_ROOT_ID, depth: 0 },
      { id: "root", depth: 1 },
      { id: "child", depth: 2 },
    ]);
    expect(nodes.find((node) => node.id === "root")?.hasChildren).toBe(true);
  });

  it("labels a mesh with the catalog title and bound asset name", () => {
    const mesh = createMeshComponent("root", "box");
    mesh.properties.assetGuid = "hero";
    const nodes = flattenPrefabComponents(
      [mesh],
      new Set(),
      (guid) => (guid === "hero" ? "Hero" : undefined),
    );
    expect(nodes.find((node) => node.id === "root")?.label).toBe("Mesh (Hero)");
  });
});

describe("ActorPrefabPanel", () => {
  it("shows inherited ActorComponent class visuals on an attached custom component", () => {
    harness.assets = [
      { header: { guid: "health", name: "Health", type: "Class", parentClass: "ActorComponent" } },
      { header: { guid: "regen", name: "RegenHealth", type: "Class", parentClass: "Health" } },
    ];
    harness.components = [{ id: "regen", classId: "RegenHealth" }];
    harness.selectedId = PREFAB_ROOT_ID;
    harness.selectedIds = [PREFAB_ROOT_ID];
    render(<ActorPrefabPanel {...({} as IDockviewPanelProps)} />);
    const icon = screen.getByTestId("tree-row-regen").querySelector("svg[data-type-icon]");
    expect(icon?.getAttribute("data-type-icon")).toBe("ActorComponent");
    expect(icon?.classList.contains("lucide-file-cog")).toBe(true);
    expect(icon?.getAttribute("color")).toBe("var(--asset-animation)");
  });

  it("frames Prefab Root on double-tap", () => {
    harness.components = [createMeshComponent("mesh-1", "box")];
    harness.selectedId = PREFAB_ROOT_ID;
    harness.selectedIds = [PREFAB_ROOT_ID];
    render(<ActorPrefabPanel {...({} as IDockviewPanelProps)} />);
    doubleTap(PREFAB_ROOT_ID);
    expect(frameActor).toHaveBeenCalledWith(PREFAB_ROOT_ID);
  });

  it("frames a component on double-tap", () => {
    harness.components = [createMeshComponent("mesh-1", "box")];
    harness.selectedId = "mesh-1";
    harness.selectedIds = ["mesh-1"];
    render(<ActorPrefabPanel {...({} as IDockviewPanelProps)} />);
    doubleTap("mesh-1");
    expect(frameActor).toHaveBeenCalledWith("mesh-1");
  });
});
