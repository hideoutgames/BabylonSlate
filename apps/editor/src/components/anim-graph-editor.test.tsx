import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createDefaultAnimGraph, type AnimGraphDocument } from "@babylonslate/anim-graph";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { AnimGraphEditingProvider } from "../context/anim-graph-editing-context";
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
      activeDocumentId: DOC_ID,
      animEditorMode: "stateMachine",
      assetRegistry: {
        list: () => [
          {
            header: { guid: "spr-1", name: "Hero", type: "Sprite" },
            path: "assets/Hero.sprite.babasset",
          },
          {
            header: { guid: "anim-1", name: "Walk", type: "Animation" },
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
            : guid === "anim-1"
              ? { header: { guid: "anim-1", name: "Walk", type: "Animation" } }
              : undefined,
      },
    };
  },
  };
});

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
          <AnimGraphParametersPanel {...panelProps} />
          <AnimGraphGraphPanel {...panelProps} />
          <AnimGraphDetailsPanel {...panelProps} />
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
  });
  return doc;
}

describe("AnimGraphEditor", () => {
  it("hydrates in/out pins on state nodes", async () => {
    const { container } = renderAnimGraph();
    await waitFor(() => {
      expect(container.querySelector('[data-handleid="in"]')).not.toBeNull();
      expect(container.querySelector('[data-handleid="out"]')).not.toBeNull();
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

  it("lists Parameters and Add State", () => {
    renderAnimGraph();
    expect(screen.getByTestId("anim-graph-parameters")).toBeTruthy();
    expect(screen.getByTestId("anim-graph-add-state")).toBeTruthy();
    expect(screen.getByTestId("anim-graph-state-idle")).toBeTruthy();
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

  it("edits outgoing transition blend and priority without a condition row", () => {
    renderAnimGraph(locoGraph());
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    expect(screen.queryByTestId("property-idle-to-run-hasExitTime")).toBeNull();
    expect(screen.queryByTestId("property-idle-to-run-condition")).toBeNull();
    expect(screen.getByTestId("property-idle-to-run-blendSeconds")).toBeTruthy();
    expect(screen.getByTestId("property-idle-to-run-priority")).toBeTruthy();
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
  });

  it("picks an Animation clip for the selected state", async () => {
    renderAnimGraph();
    fireEvent.click(screen.getByTestId("anim-graph-state-idle"));
    fireEvent.click(screen.getByTestId("property-clipAsset"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-anim-1")).toBeTruthy();
    });
    expect(screen.queryByTestId("search-item-tex-1")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-anim-1"));
    expect(lastCommit()).toEqual(
      expect.objectContaining({
        clips: expect.arrayContaining([
          expect.objectContaining({
            id: "idle-clip",
            kind: "animation",
            assetGuid: "anim-1",
          }),
        ]),
      }),
    );
  });
});
