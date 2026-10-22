import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createMeshComponent } from "@haptic/core";
import {
  ActorPrefabPanel,
  flattenPrefabComponents,
} from "./actor-prefab-panel";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";
import type { ProjectAddComponentAsset } from "./add-component-catalog";
import { KeybindProvider } from "../context/keybind-context";

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
const renameComponent = vi.hoisted(() => vi.fn());
const removeSelected = vi.hoisted(() => vi.fn());
const setSelectedMemberId = vi.hoisted(() => vi.fn());
const setSelectedNodeIds = vi.hoisted(() => vi.fn());
const harness = vi.hoisted(() => ({
  components: [] as Array<{ id: string; classId: string; name?: string; parentId?: string | null; properties?: Record<string, unknown>; inheritedFrom?: string }>,
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
    removeSelected,
    reparentComponent: vi.fn(),
    renameComponent,
  }),
}));

vi.mock("../context/graph-editing-context", () => ({
  useGraphEditing: () => ({
    setSelectedMemberId,
    setSelectedNodeIds,
  }),
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  assetRegistry: { list: () => harness.assets },
  openDocuments: [],
})));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "graph:assets/Hero.class.hasset" }),
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
  renameComponent.mockClear();
  removeSelected.mockClear();
  setSelectedMemberId.mockClear();
  setSelectedNodeIds.mockClear();
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

  it("lists a component under Prefab Root when its parent is missing or loops back to it", () => {
    const orphan = { ...createMeshComponent("orphan", "box"), parentId: "gone" };
    const loopA = { ...createMeshComponent("loop-a", "box"), parentId: "loop-b" };
    const loopB = { ...createMeshComponent("loop-b", "box"), parentId: "loop-a" };
    const nodes = flattenPrefabComponents([orphan, loopA, loopB], new Set());
    expect(nodes.map((node) => [node.id, node.depth])).toEqual([
      [PREFAB_ROOT_ID, 0],
      ["orphan", 1],
      ["loop-a", 1],
      ["loop-b", 1],
    ]);
  });

  it("lists search matches flat under Prefab Root", () => {
    const body = createMeshComponent("body", "box");
    const arm = { ...createMeshComponent("arm", "box"), name: "Arm Mesh", parentId: "body" };
    const light = { id: "light", classId: "PointLightComponent", name: "Lamp", parentId: "arm", properties: {} };
    const nodes = flattenPrefabComponents([body, arm, light], new Set(["body"]), undefined, undefined, "arm");
    expect(nodes.map((node) => [node.id, node.depth, node.hasChildren])).toEqual([
      [PREFAB_ROOT_ID, 0, true],
      ["arm", 1, false],
    ]);
  });
});

describe("ActorPrefabPanel", () => {
  it("frames Prefab Root on double-tap", () => {
    harness.components = [createMeshComponent("mesh-1", "box")];
    harness.selectedId = PREFAB_ROOT_ID;
    harness.selectedIds = [PREFAB_ROOT_ID];
    render(<ActorPrefabPanel {...({} as IDockviewPanelProps)} />);
    doubleTap(PREFAB_ROOT_ID);
    expect(frameActor).toHaveBeenCalledWith(PREFAB_ROOT_ID);
  });

  it("leaves the graph node and member selection when Prefab Root is picked", () => {
    harness.components = [createMeshComponent("mesh-1", "box")];
    harness.selectedId = "mesh-1";
    harness.selectedIds = ["mesh-1"];
    render(<ActorPrefabPanel {...({} as IDockviewPanelProps)} />);
    const root = screen.getByTestId(`tree-row-${PREFAB_ROOT_ID}`);
    dispatchPointerEvent(root, "pointerdown");
    dispatchPointerEvent(root, "pointerup");
    expect(setSelectedIds).toHaveBeenLastCalledWith([PREFAB_ROOT_ID]);
    expect(setSelectedNodeIds).toHaveBeenCalledWith([]);
    expect(setSelectedMemberId).toHaveBeenCalledWith(null);
  });

  it("frames a component on double-tap", () => {
    harness.components = [createMeshComponent("mesh-1", "box")];
    harness.selectedId = "mesh-1";
    harness.selectedIds = ["mesh-1"];
    render(<ActorPrefabPanel {...({} as IDockviewPanelProps)} />);
    doubleTap("mesh-1");
    expect(frameActor).toHaveBeenCalledWith("mesh-1");
  });

  it("renames a component from a label double-tap without its asset detail", async () => {
    harness.components = [{ id: "mesh-1", classId: "MeshComponent", parentId: null, properties: { assetGuid: "model-1" } }];
    harness.assets = [{ path: "assets/mannequin.model.hasset", header: { guid: "model-1", name: "mannequin", type: "Model" } } as unknown as ProjectAddComponentAsset];
    harness.selectedId = "mesh-1";
    harness.selectedIds = ["mesh-1"];
    render(<ActorPrefabPanel {...({} as IDockviewPanelProps)} />);
    const label = screen.getByText("Mesh (mannequin)");
    for (let tap = 0; tap < 2; tap++) {
      dispatchPointerEvent(label, "pointerdown");
      dispatchPointerEvent(label, "pointerup");
    }
    expect(frameActor).not.toHaveBeenCalled();
    const input = await screen.findByRole("textbox", { name: "Rename Mesh (mannequin)" }) as HTMLInputElement;
    expect(input.value).toBe("Mesh");
    fireEvent.change(input, { target: { value: "MyCustomNamedComponent" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameComponent).toHaveBeenCalledWith("mesh-1", "MyCustomNamedComponent");
  });

  it("deletes from a row menu after selecting a row outside the selection", async () => {
    harness.components = [createMeshComponent("mesh-1", "box"), createMeshComponent("mesh-2", "box")];
    harness.selectedId = "mesh-1";
    harness.selectedIds = ["mesh-1"];
    render(<ActorPrefabPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("prefab-row-menu-mesh-2"));
    expect(setSelectedIds).toHaveBeenLastCalledWith(["mesh-2"]);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(removeSelected).toHaveBeenCalledOnce();
  });

  it("keeps Delete unavailable for an inherited component", async () => {
    harness.components = [{ ...createMeshComponent("mesh-1", "box"), inheritedFrom: "BaseHero" }];
    harness.selectedId = "mesh-1";
    harness.selectedIds = ["mesh-1"];
    render(<KeybindProvider><ActorPrefabPanel {...({} as IDockviewPanelProps)} /></KeybindProvider>);
    fireEvent.click(screen.getByTestId("prefab-row-menu-mesh-1"));
    const remove = await screen.findByRole("menuitem", { name: "Delete" });
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Delete", code: "Delete" });
    expect(removeSelected).not.toHaveBeenCalled();
  });

  it("deletes the selection with the Delete key unless the search field has focus", async () => {
    harness.components = [createMeshComponent("mesh-1", "box")];
    harness.selectedId = "mesh-1";
    harness.selectedIds = ["mesh-1"];
    render(<KeybindProvider><ActorPrefabPanel {...({} as IDockviewPanelProps)} /></KeybindProvider>);
    const search = screen.getByTestId("prefab-component-search");
    search.focus();
    fireEvent.keyDown(search, { key: "Delete", code: "Delete" });
    expect(removeSelected).not.toHaveBeenCalled();
    const tree = screen.getByRole("tree");
    tree.focus();
    fireEvent.keyDown(tree, { key: "Delete", code: "Delete" });
    await waitFor(() => expect(removeSelected).toHaveBeenCalledOnce());
  });

  it("names the selected component as the Add Component target", () => {
    harness.components = [{ ...createMeshComponent("mesh-1", "box"), name: "Body" }];
    harness.selectedId = "mesh-1";
    harness.selectedIds = ["mesh-1"];
    render(<ActorPrefabPanel {...({} as IDockviewPanelProps)} />);
    expect(screen.getByTestId("prefab-add-component").getAttribute("aria-label")).toBe("Add Component To Body");
  });
});
