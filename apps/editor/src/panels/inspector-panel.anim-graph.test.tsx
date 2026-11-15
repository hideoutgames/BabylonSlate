import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createDefaultAnimGraph, createDefaultTransitionRuleGraph, createStateGraph, type AnimGraphDocument } from "@haptic/anim-graph";
import type { SerializedGraph } from "@haptic/core";
import { FLOAT, pin } from "@haptic/scripting";
import { InspectorPanel } from "./inspector-panel";
import { AnimGraphEditingProvider, animStateCanvas, useAnimGraphEditing } from "../context/anim-graph-editing-context";
import { GraphEditingProvider, useGraphEditing } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";

const DOC_ID = "anim-graph:assets/Loco.anim3d.hasset";
const store = vi.hoisted(() => {
  let content: Record<string, unknown> = {};
  let revision = 0;
  const listeners = new Set<() => void>();
  const publish = () => {
    revision += 1;
    listeners.forEach((listener) => listener());
  };
  return {
    content: () => content,
    getSnapshot: () => revision,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: (next: Record<string, unknown>) => {
      content = next;
      publish();
    },
    applyAssetDocumentChange: vi.fn(async (_id: string, next: Record<string, unknown>) => {
      content = next;
      publish();
      return true;
    }),
  };
});

/** Animations on two Skeletons, a Blend Space on the graph's and 2D assets, which a 3D graph's clip rows tell apart. */
const registry = vi.hoisted(() => {
  const assets = [
    { path: "assets/Walk.hasset", header: { guid: "walk", name: "Hero_Walk", type: "Animation", payload: { clipName: "Walk", skeletonGuid: "rig" } } },
    { path: "assets/Ogre.hasset", header: { guid: "ogre-walk", name: "Ogre_Walk", type: "Animation", payload: { clipName: "Walk", skeletonGuid: "ogre-rig" } } },
    { path: "assets/Loose.hasset", header: { guid: "loose", name: "Loose_Wave", type: "Animation", payload: { clipName: "Wave", skeletonGuid: null } } },
    { path: "assets/Robot.hasset", header: { guid: "robot", name: "Robot_Walk", type: "SpriteAnimation", payload: {} } },
  ];
  return {
    list: () => assets,
    getByPath: (path: string) => assets.find((asset) => asset.path === path),
    getByGuid: (guid: string) => assets.find((asset) => asset.header.guid === guid),
  };
});

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: DOC_ID }),
}));

vi.mock("../context/document-context", async () => {
  const { useSyncExternalStore } = await import("react");
  return (await import("../testing/document-context-mock")).documentContextMock(() => {
    useSyncExternalStore(store.subscribe, store.getSnapshot);
    return {
      openDocuments: [{
        id: DOC_ID,
        ref: { kind: "anim-graph-3d", path: "assets/Loco.anim3d.hasset" },
        content: store.content(),
      }],
      activeDocumentId: DOC_ID,
      applyAssetDocumentChange: store.applyAssetDocumentChange,
      projectDocument: { settings: {} },
      assetRegistry: registry,
    };
  });
});

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({ focusDiagnostic: null }),
}));
vi.mock("../context/play-context", () => ({
  usePlay: () => ({ focusedNodeId: null }),
  usePlayFocusedNodeId: () => null,
  usePlaySimulationDocumentId: () => null,
}));

function SelectionControls() {
  const { openTransitionRule, setCanvas } = useAnimGraphEditing();
  const { setSelectedNodeIds } = useGraphEditing();
  return <>
    <button onClick={() => setCanvas("stateMachine")}>Show Graph</button>
    <button onClick={() => setCanvas("animationObject")}>Show Animation Object</button>
    <button onClick={() => openTransitionRule("idle-to-run")}>Open Rule</button>
    <button onClick={() => setCanvas(animStateCanvas("idle"))}>Open Idle Graph</button>
    <button onClick={() => setSelectedNodeIds(["add"])}>Select Add</button>
    <button onClick={() => setSelectedNodeIds(["other"])}>Select Other</button>
    <button onClick={() => setSelectedNodeIds(["player"])}>Select Player</button>
  </>;
}

function addNode(id: string, a: number, hydrated = false): SerializedGraph["nodes"][number] {
  return {
    id,
    type: "math.add",
    position: { x: 0, y: 0 },
    data: {
      "default:a": a,
      "default:b": 7,
      ...(hydrated ? { __pins: [pin("a", "a", "in", FLOAT), pin("b", "b", "in", FLOAT), pin("out", "out", "out", FLOAT)] } : {}),
    },
  };
}

function renderInspector(doc: AnimGraphDocument) {
  store.reset(doc as unknown as Record<string, unknown>);
  return render(
    <AnimGraphEditingProvider>
      <PrefabEditingProvider initialSelectedId={null}>
        <GraphEditingProvider>
          <SelectionControls />
          <InspectorPanel {...({} as IDockviewPanelProps)} />
        </GraphEditingProvider>
      </PrefabEditingProvider>
    </AnimGraphEditingProvider>,
  );
}

function committedDocument(): AnimGraphDocument {
  return store.content() as unknown as AnimGraphDocument;
}

beforeEach(() => store.applyAssetDocumentChange.mockClear());
afterEach(cleanup);

describe("Animation Object Inspector", () => {
  it("selects and edits loaded node defaults without requiring persisted editor pins", () => {
    const doc = createDefaultAnimGraph();
    doc.animationObject.nodes.push(addNode("add", 3), addNode("other", 11));
    renderInspector(doc);

    fireEvent.click(screen.getByText("Select Add"));
    expect((screen.getByTestId("property-a") as HTMLInputElement).value).toBe("3");
    fireEvent.change(screen.getByTestId("property-a"), { target: { value: "5" } });
    fireEvent.blur(screen.getByTestId("property-a"));
    expect(committedDocument().animationObject.nodes.find((node) => node.id === "add")?.data).toEqual({ "default:a": 5, "default:b": 7 });
    expect(committedDocument().stateMachine).toEqual(doc.stateMachine);

    fireEvent.click(screen.getByText("Select Other"));
    expect((screen.getByTestId("property-a") as HTMLInputElement).value).toBe("11");
  });

  it("hides connected literal defaults while exposing the remaining inputs", () => {
    const doc = createDefaultAnimGraph();
    doc.animationObject.nodes.push(addNode("add", 3), addNode("other", 11));
    doc.animationObject.edges.push({ id: "wire", source: "other", sourceHandle: "out", target: "add", targetHandle: "a" });
    renderInspector(doc);
    fireEvent.click(screen.getByText("Select Add"));
    expect(screen.queryByTestId("property-a")).toBeNull();
    expect((screen.getByTestId("property-b") as HTMLInputElement).value).toBe("7");
  });

  it("reads and writes the active Animation Object when a remembered rule has the same node ID", () => {
    const doc = createDefaultAnimGraph();
    const machine = doc.stateMachine;
    machine.states.push({ id: "run", name: "Run", position: { x: 300, y: 0 }, stateGraph: createStateGraph("3d") });
    doc.animationObject.nodes.push(addNode("add", 3, true));
    machine.transitions.push({
      id: "idle-to-run", fromStateId: "idle", toStateId: "run", blendSeconds: 0.2,
      priority: 0, ruleGraph: { nodes: [addNode("add", 20, true)], edges: [] },
    });
    renderInspector(doc);
    fireEvent.click(screen.getByText("Show Graph"));
    fireEvent.click(screen.getByText("Open Rule"));
    fireEvent.click(screen.getByText("Select Add"));
    expect((screen.getByTestId("property-a") as HTMLInputElement).value).toBe("20");

    fireEvent.click(screen.getByText("Show Animation Object"));
    fireEvent.click(screen.getByText("Select Add"));
    expect((screen.getByTestId("property-a") as HTMLInputElement).value).toBe("3");
    fireEvent.change(screen.getByTestId("property-a"), { target: { value: "5" } });
    fireEvent.blur(screen.getByTestId("property-a"));
    expect(committedDocument().animationObject.nodes.find((node) => node.id === "add")?.data["default:a"]).toBe(5);
    expect(committedDocument().stateMachine.transitions[0]?.ruleGraph.nodes[0]?.data["default:a"]).toBe(20);

    fireEvent.click(screen.getByText("Show Graph"));
    expect((screen.getByTestId("property-a") as HTMLInputElement).value).toBe("20");
    fireEvent.change(screen.getByTestId("property-a"), { target: { value: "25" } });
    expect(committedDocument().stateMachine.transitions[0]?.ruleGraph.nodes[0]?.data["default:a"]).toBe(25);
    expect(committedDocument().animationObject.nodes.find((node) => node.id === "add")?.data["default:a"]).toBe(5);
  });

  it("edits a data node in a state's graph and keeps the other graphs", () => {
    const doc = createDefaultAnimGraph();
    const idle = doc.stateMachine.states[0]!;
    idle.stateGraph = { ...idle.stateGraph, nodes: [...idle.stateGraph.nodes, addNode("add", 3, true)] };
    doc.stateMachine.transitions.push({
      id: "idle-to-run", fromStateId: "idle", toStateId: "idle", blendSeconds: 0, priority: 0, ruleGraph: createDefaultTransitionRuleGraph(),
      sourceHandle: "right-out", targetHandle: "left-in",
    });
    renderInspector(doc);
    fireEvent.click(screen.getByText("Show Graph"));
    fireEvent.click(screen.getByText("Open Idle Graph"));
    fireEvent.click(screen.getByText("Select Add"));
    expect((screen.getByTestId("property-a") as HTMLInputElement).value).toBe("3");
    fireEvent.change(screen.getByTestId("property-a"), { target: { value: "9" } });
    fireEvent.blur(screen.getByTestId("property-a"));
    const committed = committedDocument();
    expect(committed.stateMachine.states[0]!.stateGraph.nodes.find((node) => node.id === "add")?.data["default:a"]).toBe(9);
    expect(committed.stateMachine.transitions).toEqual(doc.stateMachine.transitions);
  });

  it("offers a state's Sequence Player only the Animations on the graph's Skeleton", async () => {
    const doc = createDefaultAnimGraph("Locomotion", { skeletonGuid: "rig" });
    renderInspector(doc);
    fireEvent.click(screen.getByText("Show Graph"));
    fireEvent.click(screen.getByText("Open Idle Graph"));
    fireEvent.click(screen.getByText("Select Player"));
    fireEvent.click(screen.getByTestId("property-animPoseClip"));
    expect(await screen.findByTestId("search-item-walk")).toBeTruthy();
    // Another Skeleton's Animation, one with no Skeleton and a Sprite Animation cannot play in this graph.
    expect(screen.queryByTestId("search-item-ogre-walk")).toBeNull();
    expect(screen.queryByTestId("search-item-loose")).toBeNull();
    expect(screen.queryByTestId("search-item-robot")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-walk"));
    expect(committedDocument().stateMachine.states[0]!.stateGraph.nodes.find((node) => node.id === "player")?.data.assetGuid).toBe("walk");
  });
});
