import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createDefaultAnimGraph, createDefaultTransitionRuleGraph, setTransitionBidirectional, type AnimGraphDocument } from "@babylonslate/anim-graph";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { AnimGraphEditingProvider } from "../context/anim-graph-editing-context";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";
import { ValidationProvider } from "../context/validation-context";
import {
  AnimGraphDetailsPanel,
  AnimGraphGraphPanel,
  AnimGraphParametersPanel,
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

const DOC_ID = "anim-graph:assets/Loco.anim.babasset";

const store = vi.hoisted(() => {
  let content: Record<string, unknown> = {};
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
  };
});

vi.mock("../context/document-context", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
  useDocuments: () => {
    const content = useSyncExternalStore(store.subscribe, store.getSnapshot);
    return {
      openDocuments: [
        {
          id: DOC_ID,
          ref: { kind: "anim-graph", path: "assets/Loco.anim.babasset" },
          content,
        },
      ],
      applyAssetDocumentChange: store.applyAssetDocumentChange,
      applyGraphChange: vi.fn(),
      projectDocument: { settings: { input: { actions: [], axes: [] } } },
      activeDocumentId: DOC_ID,
      animEditorMode: "stateMachine",
      assetRegistry: {
        list: () => [
          {
            header: { guid: "spr-1", name: "Hero", type: "Sprite" },
            path: "assets/Hero.sprite.babasset",
          },
          {
            header: {
              guid: "walk-anim",
              name: "WalkClip",
              type: "SpriteAnimation",
              payload: { durationMs: 250 },
            },
            path: "assets/Walk.spriteanim.babasset",
          },
          {
            header: {
              guid: "model-1",
              name: "HeroModel",
              type: "Model",
              payload: { clipNames: ["Idle", "Walk"] },
              dependencies: ["anim-1"],
            },
            path: "assets/Hero.model.babasset",
          },
          {
            header: {
              guid: "model-empty",
              name: "EmptyModel",
              type: "Model",
              payload: { clipNames: [] },
            },
            path: "assets/Empty.model.babasset",
          },
          {
            header: {
              guid: "anim-1",
              name: "Hero_Walk",
              type: "Animation",
              payload: { clipName: "Walk" },
            },
            path: "assets/Walk.animation.babasset",
          },
          {
            header: { guid: "tex-1", name: "Atlas", type: "Texture" },
            path: "assets/Atlas.texture.babasset",
          },
        ],
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
                      payload: { clipNames: ["Idle", "Walk"] },
                    },
                  }
                : guid === "model-empty"
                  ? {
                      header: {
                        guid: "model-empty",
                        name: "EmptyModel",
                        type: "Model",
                        payload: { clipNames: [] },
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
  },
  };
});

vi.mock("../context/play-context", () => ({
  usePlay: () => ({ focusedNodeId: null }),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  store.applyAssetDocumentChange.mockClear();
  store.reset(createDefaultAnimGraph() as unknown as Record<string, unknown>);
});

const panelProps = {} as IDockviewPanelProps;

function renderAnimGraph(payload: AnimGraphDocument = createDefaultAnimGraph()) {
  store.reset(payload as unknown as Record<string, unknown>);
  return render(
    <ValidationProvider>
      <DocumentWorkspaceProvider documentId={DOC_ID}>
        <AnimGraphEditingProvider>
          <PrefabEditingProvider>
            <GraphEditingProvider>
              <AnimGraphParametersPanel {...panelProps} />
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

function locoGraph(): AnimGraphDocument {
  const doc = createDefaultAnimGraph();
  doc.parameters = ["moving"];
  doc.states.push({
    id: "run",
    name: "Run",
    clipId: "run-clip",
    speed: 1,
    loop: true,
    position: { x: 300, y: 80 },
  });
  doc.clips.push({
    id: "run-clip",
    kind: "sprite",
    assetGuid: "spr-1",
    clipName: "Run",
    durationMs: 400,
  });
  doc.transitions.push({
    id: "idle-to-run",
    fromStateId: "idle",
    toStateId: "run",
    condition: "moving",
    blendSeconds: 0.25,
    hasExitTime: false,
    exitTime: 0,
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

  it("uses compact action-height controls in Variables and States", () => {
    renderAnimGraph();
    fireEvent.click(screen.getByTestId("anim-graph-add-variable"));
    const addVariable = screen.getByTestId("anim-graph-add-variable");
    const addState = screen.getByTestId("anim-graph-add-state");
    const stateRow = screen.getByTestId("anim-graph-state-idle");
    const remove = screen.getByTestId(/anim-graph-variable-remove-/);
    expect(addVariable.className).not.toMatch(/min-h-\[var\(--touch-target/);
    expect(addState.className).not.toMatch(/min-h-\[var\(--touch-target/);
    expect(stateRow.className).not.toMatch(/min-h-\[var\(--touch-target/);
    expect(remove.getAttribute("aria-label")).toMatch(/remove/i);
    expect(remove.className).not.toMatch(/min-h-\[var\(--touch-target/);
  });

  it("adds a typed Animation Graph variable", () => {
    renderAnimGraph();
    fireEvent.click(screen.getByTestId("anim-graph-add-variable"));
    expect(lastCommit().variables).toEqual([
      expect.objectContaining({ name: "Variable", typeId: "bool" }),
    ]);
  });

  it("renders Unreal-style state nodes", async () => {
    renderAnimGraph(locoGraph());
    await waitFor(() => {
      expect(screen.getByTestId("anim-state-node-idle")).toBeTruthy();
    });
  });

  it("adds a state from the States list", () => {
    renderAnimGraph();
    fireEvent.click(screen.getByTestId("anim-graph-add-state"));
    expect(lastCommit()).toEqual(
      expect.objectContaining({
        states: expect.arrayContaining([
          expect.objectContaining({ id: "idle" }),
          expect.objectContaining({ name: "State" }),
        ]),
      }),
    );
    expect(lastCommit().states).toHaveLength(2);
    expect(lastCommit().states[1]!.position.x).toBeGreaterThan(
      lastCommit().states[0]!.position.x,
    );
  });

  it("shows Details after selecting a state and toggles loop", () => {
    renderAnimGraph();
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    expect(screen.getByTestId("property-name")).toBeTruthy();
    expect(screen.getByTestId("property-loop")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-loop"));
    expect(lastCommit()).toEqual(
      expect.objectContaining({
        states: [expect.objectContaining({ id: "idle", loop: false })],
      }),
    );
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

  it("opens a nested transition rule graph from Details", async () => {
    renderAnimGraph(locoGraph());
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    fireEvent.click(screen.getByTestId("anim-graph-open-rule-idle-to-run"));
    expect(screen.getByTestId("anim-rule-graph")).toBeTruthy();
    expect(screen.getByTestId("anim-rule-breadcrumb").textContent).toBe(
      "Idle To Run",
    );
    await waitFor(() => {
      expect(screen.getByTestId("graph-editor")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("anim-rule-breadcrumb-state-machine"));
    expect(screen.queryByTestId("anim-rule-graph")).toBeNull();
    expect(screen.getByTestId("anim-graph-editor")).toBeTruthy();
    expect(screen.getByTestId("property-idle-to-run-direction")).toBeTruthy();
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
    fireEvent.click(screen.getByTestId("anim-rule-breadcrumb-state-machine"));
    expect(screen.getByTestId("property-idle-to-run-direction")).toBeTruthy();
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
    expect(lastCommit().transitions[0]).toMatchObject({
      id: "idle-to-run",
      fromStateId: "run",
      toStateId: "idle",
    });
    expect(screen.queryByTestId("anim-rule-graph")).toBeNull();
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
    doc.transitions[0]!.ruleGraph.nodes.push({
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
      next.transitions[0]?.ruleGraph.nodes.find((node) => node.id === "get-speed-rule")
        ?.data.variableName,
    ).toBe("MoveSpeed");
  });

  it("picks an Animation clip for the selected state and hides Clip Name", async () => {
    renderAnimGraph();
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    fireEvent.click(screen.getByTestId("property-clipAsset"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-anim-1")).toBeTruthy();
    });
    expect(screen.queryByTestId("search-item-model-1")).toBeNull();
    expect(screen.queryByTestId("search-item-tex-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-anim-1"));
    expect(lastCommit()).toEqual(
      expect.objectContaining({
        clips: expect.arrayContaining([
          expect.objectContaining({
            id: "idle-clip",
            kind: "animation",
            assetGuid: "anim-1",
            clipName: "Walk",
          }),
        ]),
      }),
    );
    expect(screen.queryByTestId("property-clipName")).toBeNull();
  });

  it("picks a Sprite Animation for sprite clip kind and hides Clip Name", async () => {
    const doc = createDefaultAnimGraph();
    doc.clips[0] = {
      id: "idle-clip",
      kind: "sprite",
      assetGuid: "",
      clipName: "",
      durationMs: 1000,
    };
    renderAnimGraph(doc);
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    expect(screen.queryByTestId("property-clipName")).toBeNull();
    fireEvent.click(screen.getByTestId("property-clipAsset"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-walk-anim")).toBeTruthy();
    });
    expect(screen.queryByTestId("search-item-spr-1")).toBeNull();
    expect(screen.queryByTestId("search-item-model-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-walk-anim"));
    expect(lastCommit()).toEqual(
      expect.objectContaining({
        clips: expect.arrayContaining([
          expect.objectContaining({
            id: "idle-clip",
            kind: "sprite",
            assetGuid: "walk-anim",
            clipName: "",
            durationMs: 250,
          }),
        ]),
      }),
    );
    expect(screen.queryByTestId("property-clipName")).toBeNull();
  });
});
