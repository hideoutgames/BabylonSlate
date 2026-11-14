import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  createStateGraph,
  setTransitionBidirectional,
  singlePlayerOf,
  type AnimGraphDocument,
} from "@haptic/anim-graph";
import { GraphDebugProvider, useGraphDebugStore } from "../context/graph-debug-context";
import type { GraphDebugStore } from "../services/graph-debug-store";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { AnimGraphEditingProvider } from "../context/anim-graph-editing-context";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";
import { TagProvider } from "@haptic/editor-kit";
import { ValidationProvider } from "../context/validation-context";
import { BreakpointStoreProvider } from "../context/breakpoints-context";
import { BreakpointStore } from "../services/breakpoint-store";
import { ANIM_STATE_MACHINE_DEBUG_GRAPH_ID } from "@haptic/bridge";
import {
  AnimGraphDetailsPanel,
  AnimGraphGraphPanel,
  AnimGraphVariablesPanel,
} from "./anim-graph-editor";

if (typeof window !== "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    writable: true,
    value: PointerEventPolyfill,
  });
}

const DOC_ID = "anim-graph:assets/Loco.anim3d.hasset";

const store = vi.hoisted(() => {
  let content: Record<string, unknown> = {};
  /** The open document's kind: a 3D graph unless a test opens a 2D one. */
  const view = { kind: "anim-graph-3d" as "anim-graph-3d" | "anim-graph-2d" };
  const listeners = new Set<() => void>();
  return {
    applyAssetDocumentChange: vi.fn(
      async (_id: string, next: Record<string, unknown>) => {
        content = next;
        listeners.forEach((listener) => listener());
        return true;
      },
    ),
    getSnapshot: () => content,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: (next: Record<string, unknown>) => {
      content = next;
      listeners.forEach((listener) => listener());
    },
    view,
  };
});

vi.mock("../context/document-context", async () => {
  const { useSyncExternalStore } = await import("react");
  return (await import("../testing/document-context-mock")).documentContextMock(() => {
    const content = useSyncExternalStore(store.subscribe, store.getSnapshot);
    return {
      openDocuments: [
        {
          id: DOC_ID,
          ref: { kind: store.view.kind, path: "assets/Loco.anim3d.hasset" },
          content,
        },
      ],
      applyAssetDocumentChange: store.applyAssetDocumentChange,
      applyGraphChange: vi.fn(),
      projectDocument: { settings: {} },
      activeDocumentId: DOC_ID,
      animEditorMode: "stateMachine",
      assetRegistry: {
        list: () => [
          {
            header: { guid: "spr-1", name: "Hero", type: "Sprite" },
            path: "assets/Hero.sprite.hasset",
          },
          {
            header: {
              guid: "walk-anim",
              name: "WalkClip",
              type: "SpriteAnimation",
              payload: { durationMs: 250 },
            },
            path: "assets/Walk.spriteanim.hasset",
          },
          {
            header: {
              guid: "model-1",
              name: "HeroModel",
              type: "Model",
              payload: {},
              dependencies: ["anim-1"],
            },
            path: "assets/Hero.model.hasset",
          },
          {
            header: {
              guid: "model-empty",
              name: "EmptyModel",
              type: "Model",
              payload: {},
            },
            path: "assets/Empty.model.hasset",
          },
          {
            header: {
              guid: "anim-1",
              name: "Hero_Walk",
              type: "Animation",
              payload: { clipName: "Walk" },
            },
            path: "assets/Walk.animation.hasset",
          },
          {
            header: { guid: "tex-1", name: "Atlas", type: "Texture" },
            path: "assets/Atlas.texture.hasset",
          },
          {
            header: {
              guid: "bs-loco",
              name: "BS_Locomotion",
              type: "BlendSpace",
              payload: { axes: [{ name: "Speed", min: 0, max: 6 }], samples: [{ animationGuid: "anim-1", x: 2 }] },
            },
            path: "assets/BS_Locomotion.blendspace.hasset",
          },
          {
            header: { guid: "rig", name: "Knight_Skeleton", type: "Skeleton", payload: { kind: "skin", bones: [] } },
            path: "assets/Knight_Skeleton.hasset",
          },
          {
            header: {
              guid: "anim-rig",
              name: "Knight_Run",
              type: "Animation",
              payload: { clipName: "Run", skeletonGuid: "rig" },
            },
            path: "assets/Knight_Run.hasset",
          },
          {
            header: {
              guid: "stats", name: "Stats", type: "DataDefinition",
              payload: { fields: [{ id: "allowed", name: "Allowed", typeId: "bool", defaultValue: true }] },
            },
            path: "assets/Stats.hasset",
          },
          {
            header: {
              guid: "settings", name: "Settings", type: "DataTree",
              payload: { defaultDefinitionGuid: "stats", entries: [{ id: "primary", parentId: null, name: "Primary", values: { Allowed: true } }] },
            },
            path: "assets/Settings.hasset",
          },
        ],
        getByPath: (path: string) =>
          path === "assets/Loco.anim3d.hasset"
            ? { header: { guid: "loco-graph", name: "Loco", type: "AnimationGraph3D" }, path }
            : undefined,
        getByGuid: (guid: string) =>
          guid === "spr-1"
            ? { header: { guid: "spr-1", name: "Hero", type: "Sprite" } }
            : guid === "walk-anim"
              ? {
                  header: {
                    guid: "walk-anim",
                    name: "WalkClip",
                    type: "SpriteAnimation",
                    payload: { durationMs: 250 },
                  },
                }
              : guid === "model-1"
                ? {
                    header: {
                      guid: "model-1",
                      name: "HeroModel",
                      type: "Model",
                      payload: {},
                    },
                  }
                : guid === "model-empty"
                  ? {
                      header: {
                        guid: "model-empty",
                        name: "EmptyModel",
                        type: "Model",
                        payload: {},
                      },
                    }
                  : guid === "anim-1"
                    ? {
                        header: {
                          guid: "anim-1",
                          name: "Hero_Walk",
                          type: "Animation",
                          payload: { clipName: "Walk" },
                        },
                      }
                    : undefined,
      },
    };
  });
});

vi.mock("../context/play-context", () => ({
  usePlay: () => ({ focusedNodeId: null }),
  usePlayFocusedNodeId: () => null,
  usePlaySimulationDocumentId: () => null,
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  store.applyAssetDocumentChange.mockClear();
  store.reset(createDefaultAnimGraph() as unknown as Record<string, unknown>);
});

const panelProps = {} as IDockviewPanelProps;

function renderAnimGraph(
  payload: AnimGraphDocument = createDefaultAnimGraph(),
  kind: "anim-graph-3d" | "anim-graph-2d" = "anim-graph-3d",
) {
  store.view.kind = kind;
  store.reset(payload as unknown as Record<string, unknown>);
  return render(
    <ValidationProvider>
      <DocumentWorkspaceProvider documentId={DOC_ID}>
        <AnimGraphEditingProvider>
          <PrefabEditingProvider>
            <GraphEditingProvider>
              <AnimGraphVariablesPanel {...panelProps} />
              <AnimGraphGraphPanel {...panelProps} />
              <AnimGraphDetailsPanel {...panelProps} />
            </GraphEditingProvider>
          </PrefabEditingProvider>
        </AnimGraphEditingProvider>
      </DocumentWorkspaceProvider>
    </ValidationProvider>,
  );
}

function lastCommit(): AnimGraphDocument {
  const calls = store.applyAssetDocumentChange.mock.calls;
  return calls[calls.length - 1]![1] as unknown as AnimGraphDocument;
}

function machineOf(doc: AnimGraphDocument) {
  return doc.stateMachine;
}

/** The data of a state's single player. */
function playerData(doc: AnimGraphDocument, stateId: string) {
  const state = machineOf(doc).states.find((row) => row.id === stateId);
  return state ? singlePlayerOf(state.stateGraph)?.data : undefined;
}

function locoGraph(): AnimGraphDocument {
  const doc = createDefaultAnimGraph();
  const machine = machineOf(doc);
  machine.states.push({
    id: "run",
    name: "Run",
    position: { x: 300, y: 80 },
    stateGraph: createStateGraph("3d", { assetGuid: "anim-1", clipName: "Walk", durationMs: 400 }),
  });
  machine.transitions.push({
    id: "idle-to-run",
    fromStateId: "idle",
    toStateId: "run",
    blendSeconds: 0.25,
    priority: 0,
    ruleGraph: createDefaultTransitionRuleGraph(),
  });
  return doc;
}

describe("AnimGraphEditor", () => {
  it("hydrates side handles on state nodes", async () => {
    const { container } = renderAnimGraph();
    await waitFor(() => {
      expect(container.querySelector('[data-handleid="right-out"]')).not.toBeNull();
      expect(container.querySelector('[data-handleid="left-in"]')).not.toBeNull();
      expect(container.querySelector('[data-handleid="in"]')).toBeNull();
      expect(container.querySelector('[data-handleid="out"]')).toBeNull();
    });
  });

  it("lists the state node in Add Node", async () => {
    const { container } = renderAnimGraph();
    await waitFor(() => {
      expect(container.querySelector(".react-flow__pane")).not.toBeNull();
    });
    const pane = container.querySelector(".react-flow__pane");
    fireEvent.click(pane!);
    fireEvent.click(pane!);
    await waitFor(() => {
      expect(screen.getByTestId("node-palette-item-anim.state")).toBeTruthy();
    });
  });

  it("opens Add State from a far pin-drag release instead of cancelling", async () => {
    renderAnimGraph();
    await waitFor(() => {
      expect(screen.getByTestId("graph-editor")).toBeTruthy();
    });
    expect(screen.getByTestId("graph-editor").getAttribute("data-connect-end-mode")).toBe(
      "zone-add-node",
    );
  });

  it("adds a typed Animation Graph variable", () => {
    renderAnimGraph();
    fireEvent.click(screen.getByTestId("anim-graph-add-variable"));
    expect(lastCommit().variables).toEqual([
      expect.objectContaining({ name: "Variable", typeId: "bool" }),
    ]);
  });

  it("stores TagContainer selection on an Animation Graph variable", () => {
    const doc = createDefaultAnimGraph();
    doc.variables = [{ id: "allowed", name: "Allowed", typeId: "struct", typeClassId: "engine:TagContainer", defaultValue: { Tags: [] } }];
    store.reset(doc as unknown as Record<string, unknown>);
    render(
      <TagProvider entries={[{ id: 1, path: "Actor", parentId: 0 }, { id: 2, path: "Actor.Alive", parentId: 1 }]}>
        <DocumentWorkspaceProvider documentId={DOC_ID}>
          <AnimGraphEditingProvider><AnimGraphVariablesPanel {...panelProps} /></AnimGraphEditingProvider>
        </DocumentWorkspaceProvider>
      </TagProvider>,
    );
    fireEvent.click(screen.getByTestId("property-allowed"));
    const tree = screen.getByTestId("property-allowed-tree");
    fireEvent.keyDown(tree, { key: "End" });
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(lastCommit().variables).toEqual([{ id: "allowed", name: "Allowed", typeId: "struct", typeClassId: "engine:TagContainer", defaultValue: { Tags: [2] } }]);
  });

  it("shows each state's clip on its graph node", async () => {
    const doc = locoGraph();
    const machine = machineOf(doc);
    machine.states[0]!.stateGraph = createStateGraph("3d", { assetGuid: "anim-1" });
    const player = (id: string) => ({ id, type: "anim.pose.sequencePlayer", position: { x: 0, y: 0 }, data: { assetGuid: "anim-1" } });
    machine.states.push(
      { id: "blank", name: "Blank", position: { x: 600, y: 80 }, stateGraph: { nodes: [], edges: [] } },
      {
        id: "moving",
        name: "Moving",
        position: { x: 1200, y: 80 },
        stateGraph: {
          nodes: [
            { id: "bs", type: "anim.pose.blendSpacePlayer", position: { x: 0, y: 0 }, data: { assetGuid: "bs-loco" } },
            { id: "output", type: "anim.pose.output", position: { x: 0, y: 0 }, data: { __protected: true } },
          ],
          edges: [{ id: "1", source: "bs", sourceHandle: "pose", target: "output", targetHandle: "pose" }],
        },
      },
      {
        id: "mixed",
        name: "Mixed",
        position: { x: 900, y: 80 },
        stateGraph: {
          nodes: [
            { id: "blend", type: "anim.pose.blend", position: { x: 0, y: 0 }, data: {} },
            player("a"),
            player("b"),
            { id: "output", type: "anim.pose.output", position: { x: 0, y: 0 }, data: { __protected: true } },
          ],
          edges: [
            { id: "1", source: "a", sourceHandle: "pose", target: "blend", targetHandle: "a" },
            { id: "2", source: "b", sourceHandle: "pose", target: "blend", targetHandle: "b" },
            { id: "3", source: "blend", sourceHandle: "pose", target: "output", targetHandle: "pose" },
          ],
        },
      },
    );
    renderAnimGraph(doc);
    await waitFor(() => {
      expect(screen.getByTestId("anim-state-node-clip-idle").textContent).toBe(
        "Hero_Walk",
      );
    });
    expect(screen.getByTestId("anim-state-node-clip-blank").textContent).toBe(
      "No Clip",
    );
    // A state whose graph is more than one player shows that it plays a State Graph.
    expect(screen.getByTestId("anim-state-node-clip-mixed").textContent).toBe("State Graph");
    // A state that plays a Blend Space names it.
    expect(screen.getByTestId("anim-state-node-clip-moving").textContent).toBe("BS_Locomotion");
  });

  it("adds a state from the States list", () => {
    renderAnimGraph();
    fireEvent.click(screen.getByTestId("anim-graph-add-state"));
    const states = machineOf(lastCommit()).states;
    expect(states).toEqual([
      expect.objectContaining({ id: "idle" }),
      expect.objectContaining({ name: "State" }),
    ]);
    expect(states[1]!.position.x).toBeGreaterThan(states[0]!.position.x);
    // A new state plays one player of the graph's dimension.
    expect(singlePlayerOf(states[1]!.stateGraph)?.type).toBe("anim.pose.sequencePlayer");
  });

  it("shows Details after selecting a state and toggles loop", () => {
    renderAnimGraph();
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    expect(screen.getByTestId("property-name")).toBeTruthy();
    expect(screen.getByTestId("property-loop")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-loop"));
    expect(playerData(lastCommit(), "idle")?.loop).toBe(false);
  });

  it("puts a state's player in a Sync Group, and takes it out again", () => {
    renderAnimGraph();
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    fireEvent.change(screen.getByTestId("property-syncGroup"), { target: { value: " Locomotion " } });
    expect(playerData(lastCommit(), "idle")?.syncGroup).toBe("Locomotion");
    fireEvent.change(screen.getByTestId("property-syncGroup"), { target: { value: "" } });
    expect(playerData(lastCommit(), "idle")).not.toHaveProperty("syncGroup");
  });

  it("selects a state from the list without zooming the graph to that node", async () => {
    renderAnimGraph(locoGraph());
    await waitFor(() => {
      expect(screen.getByTestId("anim-state-node-run")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("anim-graph-state-run"));
    expect(screen.getByTestId("property-name")).toBeTruthy();
    expect(
      screen.getByTestId("graph-editor").getAttribute("data-focused-node-id"),
    ).toBeNull();
  });

  it("edits outgoing transition blend and priority without a condition row", () => {
    renderAnimGraph(locoGraph());
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    expect(screen.queryByTestId("property-idle-to-run-hasExitTime")).toBeNull();
    expect(screen.queryByTestId("property-idle-to-run-condition")).toBeNull();
    expect(screen.getByTestId("property-idle-to-run-blendSeconds")).toBeTruthy();
    expect(screen.getByTestId("property-idle-to-run-priority")).toBeTruthy();
    expect(screen.getByTestId("property-idle-to-run-direction")).toBeTruthy();
    expect(screen.getByTestId("anim-graph-open-rule-idle-to-run")).toBeTruthy();
  });

  it("draws a State Alias on the State Machine and edits the states it leaves from in the Inspector", async () => {
    const doc = locoGraph();
    machineOf(doc).aliases = [{ id: "struck", name: "Struck", position: { x: 0, y: 400 }, anyState: false, stateIds: ["idle"] }];
    const { container } = renderAnimGraph(doc);
    await waitFor(() => expect(screen.getByTestId("anim-alias-node-struck")).toBeTruthy());
    expect(screen.getByTestId("anim-alias-node-covers-struck").textContent).toBe("1 State");
    fireEvent.click(container.querySelector('.react-flow__node[data-id="struck"]')!);
    await waitFor(() => expect(screen.getByTestId("anim-graph-alias")).toBeTruthy());
    // Cover Run too.
    fireEvent.click(within(screen.getByTestId("property-row-aliasState-run")).getByRole("checkbox").parentElement!.querySelector("input")!);
    expect(machineOf(lastCommit()).aliases).toEqual([{ id: "struck", name: "Struck", position: { x: 0, y: 400 }, anyState: false, stateIds: ["idle", "run"] }]);
  });

  it("shows the rows two selected states share and adds typed math to each state's Speed in one change", async () => {
    const doc = locoGraph();
    machineOf(doc).states[1]!.stateGraph = createStateGraph("3d", { assetGuid: "anim-1", playRate: 2 });
    const { container } = renderAnimGraph(doc);
    await waitFor(() => expect(screen.getByTestId("anim-state-node-run")).toBeTruthy());
    fireEvent.keyDown(document.body, { key: "Control", code: "ControlLeft" });
    fireEvent.click(container.querySelector('.react-flow__node[data-id="idle"]')!);
    fireEvent.click(container.querySelector('.react-flow__node[data-id="run"]')!);
    fireEvent.keyUp(document.body, { key: "Control", code: "ControlLeft" });
    await waitFor(() => expect(screen.getByTestId("anim-graph-details").textContent).toContain("2 States"));
    // Names, the entry state and transitions stay per state; Idle plays no clip and Run plays Hero_Walk.
    expect(screen.queryByTestId("property-name")).toBeNull();
    expect(screen.queryByTestId("property-entry")).toBeNull();
    expect(screen.queryByTestId("anim-graph-transition-idle-to-run")).toBeNull();
    expect(screen.getByTestId("property-clipAsset").textContent).toContain("Mixed Values");
    const speed = screen.getByTestId<HTMLInputElement>("property-speed");
    expect(speed.value).toBe("Mixed Values");
    store.applyAssetDocumentChange.mockClear();
    fireEvent.focus(speed);
    fireEvent.change(speed, { target: { value: "Mixed Values+4" } });
    expect(store.applyAssetDocumentChange).toHaveBeenCalledTimes(1);
    expect(["idle", "run"].map((id) => [id, playerData(lastCommit(), id)?.["default:playRate"]])).toEqual([["idle", 5], ["run", 6]]);
  });

  it("opens a nested transition rule graph from Details", async () => {
    renderAnimGraph(locoGraph());
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    // The canvas reports the state it selected a microtask later, as it does between real clicks.
    await act(async () => {});
    fireEvent.click(screen.getByTestId("anim-graph-open-rule-idle-to-run"));
    expect(screen.getByTestId("anim-rule-graph")).toBeTruthy();
    expect(screen.getByTestId("anim-rule-title").textContent).toBe(
      "Idle To Run",
    );
    await waitFor(() => {
      expect(screen.getByTestId("graph-editor")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Back To State Machine" }));
    expect(screen.queryByTestId("anim-rule-graph")).toBeNull();
    expect(screen.getByTestId("anim-graph-editor")).toBeTruthy();
    // The rule's transition, not the state it was opened from, is the selection.
    expect(screen.getByTestId("anim-graph-transition-idle-to-run-toggle").textContent).toBe("Idle To Run");
    // The canvas highlights the wire of the transition the Inspector shows.
    expect(screen.getByTestId("graph-editor").getAttribute("data-selected-edge-id")).toBe("idle-to-run");
  });

  it("highlights a Both Ways pair's one wire after its reverse rule closes", async () => {
    renderAnimGraph(setTransitionBidirectional(locoGraph(), "idle-to-run", true));
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    await act(async () => {});
    fireEvent.click(within(screen.getByTestId("anim-graph-transition-idle-to-run")).getByRole("button", { name: "Open Reverse Rule" }));
    await waitFor(() => expect(screen.getByTestId("anim-rule-title").textContent).toBe("Run To Idle"));
    fireEvent.click(screen.getByRole("button", { name: "Back To State Machine" }));
    expect(screen.getByTestId("graph-editor").getAttribute("data-selected-edge-id")).toBe("idle-to-run");
  });

  it("groups a state's transitions as cards that collapse to their blend time and direction", () => {
    renderAnimGraph(locoGraph());
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    const card = screen.getByTestId("anim-graph-transition-idle-to-run");
    expect(card.closest('[data-testid="module-stage-anim-graph-transitions"]')?.textContent).toContain("Transitions");
    expect(screen.getByTestId("anim-graph-transition-idle-to-run-toggle").textContent).toBe("To Run");
    expect(screen.queryByTestId("anim-graph-transition-idle-to-run-summary")).toBeNull();
    fireEvent.click(screen.getByTestId("anim-graph-transition-idle-to-run-toggle"));
    expect(screen.queryByTestId("property-idle-to-run-blendSeconds")).toBeNull();
    expect(screen.queryByTestId("anim-graph-open-rule-idle-to-run")).toBeNull();
    expect(screen.getByTestId("anim-graph-transition-idle-to-run-summary").textContent).toBe("0.25 s · One Way");
    fireEvent.click(screen.getByTestId("anim-graph-transition-idle-to-run-toggle"));
    expect(screen.getByTestId("property-idle-to-run-blendSeconds")).toBeTruthy();
  });

  it("shows node details in the Details panel while a To State rule is open", async () => {
    const { container } = renderAnimGraph(locoGraph());
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    fireEvent.click(screen.getByTestId("anim-graph-open-rule-idle-to-run"));
    expect(screen.getByTestId("anim-rule-details-empty").textContent).toMatch(
      /Select a Node/,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-id="enter-state"]')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('[data-id="enter-state"]')!);
    await waitFor(() => {
      expect(screen.getByTestId("inspector-panel").textContent).toContain(
        "Enter State",
      );
    });
    expect(screen.queryByTestId("property-name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back To State Machine" }));
    expect(screen.getByTestId("property-idle-to-run-direction")).toBeTruthy();
  });

  it("hydrates typed row reads and offers Definition nodes in transition rules", async () => {
    const doc = locoGraph();
    machineOf(doc).transitions[0]!.ruleGraph.nodes.push({
      id: "read-data", type: "data.readEntry", position: { x: 300, y: 200 },
      data: { "default:tree": "settings", "default:entryPath": "Primary" },
    });
    const { container } = renderAnimGraph(doc);
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    fireEvent.click(screen.getByTestId("anim-graph-open-rule-idle-to-run"));
    await waitFor(() => {
      expect(container.querySelector('[data-id="read-data"]')?.textContent).toContain("Read Stats Data");
    });
    const pane = screen.getByTestId("anim-rule-graph").querySelector(".react-flow__pane");
    fireEvent.click(pane!);
    fireEvent.click(pane!);
    fireEvent.change(await screen.findByPlaceholderText("Search nodes"), { target: { value: "Stats" } });
    await waitFor(() => {
      expect(screen.getByTestId("node-palette-item-data.readEntry:stats")).toBeTruthy();
      expect(screen.getByTestId("node-palette-item-struct.break:stats")).toBeTruthy();
    });
  });

  it("disables Exit State in a one-way To State rule", async () => {
    renderAnimGraph(locoGraph());
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    fireEvent.click(screen.getByTestId("anim-graph-open-rule-idle-to-run"));
    await waitFor(() => {
      expect(screen.getByTestId("anim-rule-graph")).toBeTruthy();
    });
    expect(
      screen.getByTestId("anim-rule-graph").querySelector('[data-disabled="true"]'),
    ).not.toBeNull();
  });

  it("flips a one-way transition from Details and disables Flip Direction for Both Ways", () => {
    renderAnimGraph(locoGraph());
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    const flip = screen.getByTestId("anim-graph-flip-direction-idle-to-run");
    expect(flip).toHaveProperty("disabled", false);
    fireEvent.click(flip);
    expect(machineOf(lastCommit()).transitions[0]).toMatchObject({
      id: "idle-to-run",
      fromStateId: "run",
      toStateId: "idle",
    });
    expect(screen.queryByTestId("anim-rule-graph")).toBeNull();
    expect(screen.getByTestId("anim-graph-flip-direction-idle-to-run")).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByTestId("anim-graph-open-rule-idle-to-run")).toBeTruthy();
  });

  it("sets breakpoints on a state from its menu and on each direction of a Both Ways transition in Details", () => {
    const breakpoints = new BreakpointStore();
    const both = setTransitionBidirectional(locoGraph(), "idle-to-run", true);
    const reverseId = machineOf(both).transitions.find((row) => row.fromStateId === "run")!.id;
    store.reset(both as unknown as Record<string, unknown>);
    render(
      <BreakpointStoreProvider store={breakpoints}>
        <ValidationProvider>
          <DocumentWorkspaceProvider documentId={DOC_ID}>
            <AnimGraphEditingProvider>
              <PrefabEditingProvider>
                <GraphEditingProvider>
                  <AnimGraphVariablesPanel {...panelProps} />
                  <AnimGraphGraphPanel {...panelProps} />
                  <AnimGraphDetailsPanel {...panelProps} />
                </GraphEditingProvider>
              </PrefabEditingProvider>
            </AnimGraphEditingProvider>
          </DocumentWorkspaceProvider>
        </ValidationProvider>
      </BreakpointStoreProvider>,
    );
    const at = (nodeId: string) => ({ assetGuid: "loco-graph", graphId: ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, nodeId });
    const run = screen.getByTestId("anim-state-node-run");
    fireEvent.contextMenu(run);
    fireEvent.click(screen.getByText("Add Breakpoint"));
    expect(breakpoints.get(at("run"))?.label).toEqual({ className: "Loco", graphName: "State Machine", nodeTitle: "Run" });
    expect(run.querySelector("[data-breakpoint]")?.getAttribute("data-breakpoint")).toBe("enabled");

    // The selected state's transition shows a button for each direction.
    fireEvent.click(screen.getByTestId("anim-graph-state-run"));
    fireEvent.click(screen.getByText("Add Breakpoint"));
    expect(breakpoints.get(at(reverseId))?.label.nodeTitle).toBe("Run To Idle");
    expect(screen.getByTestId(`anim-graph-breakpoint-${reverseId}`).textContent).toBe("Remove Breakpoint");
    fireEvent.click(screen.getByText("Add Reverse Breakpoint"));
    expect(breakpoints.get(at("idle-to-run"))?.label.nodeTitle).toBe("Idle To Run");
  });

  it("disables Flip Direction when the transition is Both Ways", () => {
    const both = setTransitionBidirectional(locoGraph(), "idle-to-run", true);
    renderAnimGraph(both);
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    expect(
      screen.getByTestId("anim-graph-flip-direction-idle-to-run"),
    ).toHaveProperty("disabled", true);
    expect(screen.getByTestId("anim-graph-open-rule-idle-to-run")).toBeTruthy();
  });

  it("renames an Animation Graph variable on Get nodes in both graphs", () => {
    const doc = locoGraph();
    doc.variables = [
      { id: "var-speed", name: "Speed", typeId: "float", defaultValue: 0 },
    ];
    doc.animationObject = {
      ...doc.animationObject,
      nodes: [
        ...doc.animationObject.nodes,
        {
          id: "get-speed",
          type: "variables.get",
          position: { x: 0, y: 0 },
          data: {
            variableId: "var-speed",
            variableName: "Speed",
            typeId: "float",
            title: "Get Speed",
          },
        },
      ],
    };
    machineOf(doc).transitions[0]!.ruleGraph.nodes.push({
      id: "get-speed-rule",
      type: "variables.get",
      position: { x: 0, y: 0 },
      data: {
        variableId: "var-speed",
        variableName: "Speed",
        typeId: "float",
        title: "Get Speed",
      },
    });
    renderAnimGraph(doc);
    fireEvent.change(screen.getByTestId("anim-graph-variable-name-var-speed"), {
      target: { value: "MoveSpeed" },
    });
    const next = lastCommit();
    expect(
      next.animationObject.nodes.find((node) => node.id === "get-speed")?.data
        .variableName,
    ).toBe("MoveSpeed");
    expect(
      machineOf(next).transitions[0]?.ruleGraph.nodes.find((node) => node.id === "get-speed-rule")
        ?.data.variableName,
    ).toBe("MoveSpeed");
  });

  it("picks an Animation clip for the selected state", async () => {
    renderAnimGraph();
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    fireEvent.click(screen.getByTestId("property-clipAsset"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-anim-1")).toBeTruthy();
    });
    expect(screen.queryByTestId("search-item-model-1")).toBeNull();
    expect(screen.queryByTestId("search-item-tex-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-anim-1"));
    expect(playerData(lastCommit(), "idle")).toMatchObject({ assetGuid: "anim-1", clipName: "Walk" });
  });

  it("offers only Animations on the graph's Skeleton, and sets the Skeleton in the Graph rows", async () => {
    renderAnimGraph(createDefaultAnimGraph("Loco", { dimension: "3d", skeletonGuid: "rig" }));
    expect(screen.getByTestId("property-skeleton").textContent).toContain("Knight_Skeleton");
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    fireEvent.click(screen.getByTestId("property-clipAsset"));
    await waitFor(() => expect(screen.getByTestId("search-item-anim-rig")).toBeTruthy());
    // Hero_Walk has no Skeleton, so only a graph without one offers it.
    expect(screen.queryByTestId("search-item-anim-1")).toBeNull();
    expect(screen.queryByTestId("search-item-walk-anim")).toBeNull();
  });

  it("offers no Clip Name for a state whose clip still names a Model", () => {
    // Clips are Animation assets: a Model plus a glTF clip name is no longer a clip.
    const doc = createDefaultAnimGraph();
    machineOf(doc).states[0]!.stateGraph = createStateGraph("3d", { assetGuid: "model-1", clipName: "Idle", durationMs: 1000 });
    renderAnimGraph(doc);
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    expect(screen.getByTestId("property-clipAsset")).toBeTruthy();
    expect(screen.queryByTestId("property-clipName")).toBeNull();
    expect(screen.getByTestId("anim-state-node-clip-idle").textContent).toContain("HeroModel");
  });

  it("picks only Sprite Animations in a 2D graph", async () => {
    const doc = createDefaultAnimGraph("Loco", { dimension: "2d" });
    renderAnimGraph(doc, "anim-graph-2d");
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    fireEvent.click(screen.getByTestId("property-clipAsset"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-walk-anim")).toBeTruthy();
    });
    expect(screen.queryByTestId("search-item-spr-1")).toBeNull();
    expect(screen.queryByTestId("search-item-model-1")).toBeNull();
    expect(screen.queryByTestId("search-item-anim-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-walk-anim"));
    const player = singlePlayerOf(machineOf(lastCommit()).states[0]!.stateGraph);
    expect(player?.type).toBe("anim.frame.spritePlayer");
    expect(player?.data).toMatchObject({ assetGuid: "walk-anim", durationMs: 250 });
  });

  it("opens a state's graph on double-click, ending in its Output Pose, and steps back out with the breadcrumbs", async () => {
    const { container } = renderAnimGraph(locoGraph());
    await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="run"]')).not.toBeNull());
    fireEvent.doubleClick(container.querySelector('.react-flow__node[data-id="run"]')!);
    await waitFor(() => expect(screen.getByTestId("anim-pose-graph")).toBeTruthy());
    expect(screen.getByTestId("anim-graph-crumb-machine").textContent).toBe("State Machine");
    expect(screen.getByTestId("anim-graph-crumb-state").textContent).toBe("Run");
    await waitFor(() => {
      expect(container.querySelector('.react-flow__node[data-id="output"] .anim-pose-output-node')).not.toBeNull();
      expect(container.querySelector('.react-flow__node[data-id="player"]')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId("anim-graph-back"));
    await waitFor(() => expect(screen.getByTestId("anim-graph-editor")).toBeTruthy());
    expect(screen.queryByTestId("anim-pose-graph")).toBeNull();
  });

  it("opens the selected state's graph from Details", () => {
    renderAnimGraph(locoGraph());
    fireEvent.click(screen.getByTestId("anim-graph-state-run"));
    fireEvent.click(screen.getByTestId("anim-graph-open-state-graph"));
    expect(screen.getByTestId("anim-graph-crumb-state").textContent).toBe("Run");
    expect(screen.getByTestId("anim-pose-graph")).toBeTruthy();
  });

  it("opens on the State Machine, the root, with nothing to step back to and no Name row", () => {
    renderAnimGraph(locoGraph());
    expect(screen.getByTestId("anim-graph-editor")).toBeTruthy();
    expect(screen.getByTestId("anim-graph-crumb-machine").textContent).toBe("State Machine");
    expect(screen.queryByTestId("anim-graph-crumb-state")).toBeNull();
    expect(screen.getByTestId("anim-graph-back")).toHaveProperty("disabled", true);
    expect(screen.queryByTestId("property-machineName")).toBeNull();
  });
});

describe("AnimGraphEditor while a Simulation debugs the graph", () => {
  const target = { kind: "animationGraph", assetGuid: "loco-graph" } as const;
  let animated: Element[] = [];
  let frames: Array<() => void> = [];
  let debug: GraphDebugStore | null = null;
  function DebugProbe() {
    debug = useGraphDebugStore();
    return null;
  }

  beforeEach(() => {
    animated = [];
    frames = [];
    Element.prototype.animate = function (this: Element) {
      animated.push(this);
      return { cancel() {}, play() {} } as unknown as Animation;
    };
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    delete (Element.prototype as { animate?: unknown }).animate;
    vi.unstubAllGlobals();
    debug = null;
  });

  function renderDebugged() {
    store.reset(locoGraph() as unknown as Record<string, unknown>);
    return render(
      <GraphDebugProvider>
        <DebugProbe />
        <ValidationProvider>
          <DocumentWorkspaceProvider documentId={DOC_ID}>
            <AnimGraphEditingProvider>
              <PrefabEditingProvider>
                <GraphEditingProvider>
                  <AnimGraphGraphPanel {...panelProps} />
                </GraphEditingProvider>
              </PrefabEditingProvider>
            </AnimGraphEditingProvider>
          </DocumentWorkspaceProvider>
        </ValidationProvider>
      </GraphDebugProvider>,
    );
  }
  const trace = (nodes: string[]) => ({
    target, instanceId: "hero", tickIndex: 1,
    graphs: [{ assetGuid: "loco-graph", graphId: "state-machine", nodes, edges: [], values: [] }],
  });
  const runFrames = () => act(() => { const pending = frames; frames = []; for (const frame of pending) frame(); });

  it("lights the state the followed instance samples, and nothing before the debugger watches the graph", async () => {
    const { container } = renderDebugged();
    await waitFor(() => expect(container.querySelector('[data-id="run"] [data-node-role="anim-state"]')).not.toBeNull());
    const runState = container.querySelector('[data-id="run"] [data-node-role="anim-state"]')!;

    // Not watched yet: a trace has nowhere to go.
    act(() => debug!.receiveTrace(trace(["run"])));
    runFrames();
    expect(animated).toEqual([]);

    act(() => {
      debug!.setTarget(target);
      debug!.receiveRoster({ target, reset: true, added: [{ id: "hero", kind: "component", label: "Hero" }], removed: [] });
    });
    act(() => debug!.receiveTrace(trace(["run"])));
    runFrames();
    expect(animated).toContain(runState);
    expect(animated).not.toContain(container.querySelector('[data-id="idle"] [data-node-role="anim-state"]'));
  });
});
