import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  addDecorator,
  createDefaultBehaviourTree,
  validateBehaviourTree,
  type BehaviourTreeDocument,
} from "@haptic/behaviour-tree";
import { BT_DEBUG_GRAPH_ID } from "@haptic/bridge";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { BehaviourTreeEditingProvider } from "../context/behaviour-tree-editing-context";
import { GraphDebugProvider, useGraphDebugStore } from "../context/graph-debug-context";
import { BreakpointStoreProvider } from "../context/breakpoints-context";
import { BreakpointStore } from "../services/breakpoint-store";
import type { GraphDebugStore } from "../services/graph-debug-store";
import {
  BehaviourTreeBlackboardPanel,
  BehaviourTreeCompilerResultsPanel,
  BehaviourTreeDetailsPanel,
  BehaviourTreeGraphPanel,
} from "./behaviour-tree-editor";

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

/** The graph context values the tree nodes have seen, and the last one. */
const graphContext = vi.hoisted(() => ({
  seen: new Set<unknown>(),
  last: undefined as unknown,
}));

vi.mock("@haptic/graph-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@haptic/graph-ui")>();
  const { createElement } = await import("react");
  const ProbedTreeNode = (props: ComponentProps<typeof actual.TreeNode>) => {
    const value = actual.useGraphEditorContext();
    graphContext.seen.add(value);
    graphContext.last = value;
    return createElement(actual.TreeNode, props);
  };
  return { ...actual, treeNodeTypes: { ...actual.treeNodeTypes, "bt.node": ProbedTreeNode } };
});

vi.mock("@haptic/behaviour-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@haptic/behaviour-tree")>();
  return { ...actual, validateBehaviourTree: vi.fn(actual.validateBehaviourTree) };
});

const DOC_ID = "behaviour-tree:assets/Patrol.bt.hasset";
const BB_ID = "blackboard:assets/Guard.blackboard.hasset";
const BB_PATH = "assets/Guard.blackboard.hasset";
const openDocument = vi.hoisted(() => vi.fn());
const loadAssetDocument = vi.hoisted(() => vi.fn());

/** The document tab the host reports as active; a panel is on screen only for its own document. */
const tabs = vi.hoisted(() => ({ active: null as string | null }));

const defaultBlackboard = vi.hoisted(() => ({
  name: "Guard",
  keys: [
    { name: "alert", type: { kind: "bool" } },
    { name: "hp", type: { kind: "float" } },
  ],
}));

const store = vi.hoisted(() => {
  let content: Record<string, unknown> = {};
  let blackboard: Record<string, unknown> = { ...defaultBlackboard };
  const listeners = new Set<() => void>();
  return {
    applyAssetDocumentChange: vi.fn(
      async (id: string, next: Record<string, unknown>) => {
        if (id === DOC_ID) content = next;
        else if (id === BB_ID) blackboard = next;
        listeners.forEach((listener) => listener());
        return true;
      },
    ),
    getSnapshot: () => content,
    getBlackboard: () => blackboard,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: (next: Record<string, unknown>) => {
      content = next;
      blackboard = { ...defaultBlackboard };
      listeners.forEach((listener) => listener());
    },
  };
});

vi.mock("../context/document-context", async () => {
  const { useSyncExternalStore } = await import("react");
  return (await import("../testing/document-context-mock")).documentContextMock(() => {
    const content = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const blackboard = useSyncExternalStore(store.subscribe, store.getBlackboard);
    return {
      activeDocumentId: tabs.active,
      openDocuments: [
        {
          id: DOC_ID,
          ref: { kind: "behaviour-tree", path: "assets/Patrol.bt.hasset" },
          content,
        },
        {
          id: BB_ID,
          ref: { kind: "blackboard", path: BB_PATH },
          content: blackboard,
        },
      ],
      applyAssetDocumentChange: store.applyAssetDocumentChange,
      openDocument,
      loadAssetDocument,
      assetRegistry: {
        list: () => [
          {
            header: {
              guid: "class-1",
              name: "BTTask_Custom",
              type: "Class",
              parentClass: "BTTask",
            },
            path: "assets/BTTask_Custom.class.hasset",
          },
          {
            header: {
              guid: "class-2",
              name: "BTDecorator_Alert",
              type: "Class",
              parentClass: "BTDecorator",
            },
            path: "assets/BTDecorator_Alert.class.hasset",
          },
          {
            header: {
              guid: "class-3",
              name: "MyBrain",
              type: "Class",
              parentClass: "BTComposite",
            },
            path: "assets/MyBrain.class.hasset",
          },
          {
            header: {
              guid: "bb-1",
              name: "Guard",
              type: "Blackboard",
              parentClass: null,
            },
            path: BB_PATH,
          },
          {
            header: {
              guid: "audio-1",
              name: "Jump",
              type: "Audio",
              parentClass: null,
            },
            path: "assets/jump.hasset",
          },
          {
            header: {
              guid: "anim-walk",
              name: "Walk",
              type: "Animation",
              parentClass: null,
              payload: { clipName: "Walk", durationMs: 200 },
            },
            path: "assets/walk.anim.hasset",
          },
          {
            header: {
              guid: "sprite-run",
              name: "Run",
              type: "SpriteAnimation",
              parentClass: null,
            },
            path: "assets/run.spriteanim.hasset",
          },
        ],
        getByPath: (path: string) =>
          path === "assets/Patrol.bt.hasset"
            ? { header: { guid: "tree-1", name: "Patrol", type: "BehaviourTree" }, path }
            : undefined,
        getByGuid: (guid: string) =>
          guid === "bb-1"
            ? {
                header: { guid: "bb-1", name: "Guard", type: "Blackboard" },
                path: BB_PATH,
              }
            : guid === "bb-scout" || guid === "bb-missing"
              ? {
                  header: { guid, name: guid, type: "Blackboard" },
                  path: `assets/${guid}.blackboard.hasset`,
                }
            : guid === "audio-1"
              ? {
                  header: { guid: "audio-1", name: "Jump", type: "Audio" },
                  path: "assets/jump.hasset",
                }
              : guid === "anim-walk"
                ? {
                    header: {
                      guid: "anim-walk",
                      name: "Walk",
                      type: "Animation",
                      payload: { clipName: "Walk", durationMs: 200 },
                    },
                    path: "assets/walk.anim.hasset",
                  }
                : guid === "sprite-run"
                  ? {
                      header: {
                        guid: "sprite-run",
                        name: "Run",
                        type: "SpriteAnimation",
                      },
                      path: "assets/run.spriteanim.hasset",
                    }
              : guid === "class-1"
              ? {
                  header: {
                    guid: "class-1",
                    name: "BTTask_Custom",
                    type: "Class",
                    parentClass: "BTTask",
                  },
                  path: "assets/BTTask_Custom.class.hasset",
                }
              : undefined,
      },
    };
  });
});

const livePlay = vi.hoisted(() => ({ playing: false }));
vi.mock("../context/play-context", () => ({
  usePlay: () => ({
    playing: livePlay.playing,
    focusedNodeId: null,
  }),
}));

afterEach(() => {
  cleanup();
  openDocument.mockClear();
  loadAssetDocument.mockClear();
});

beforeEach(() => {
  graphContext.seen.clear();
  graphContext.last = undefined;
  tabs.active = DOC_ID;
  livePlay.playing = false;
  debug.store = null;
  store.applyAssetDocumentChange.mockClear();
  loadAssetDocument.mockResolvedValue(defaultBlackboard);
  store.reset(
    createDefaultBehaviourTree() as unknown as Record<string, unknown>,
  );
});

const panelProps = {} as IDockviewPanelProps;

/** The graph debugger store the panels read, as the Simulation's overlay feeds it. */
const debug = { store: null as GraphDebugStore | null };
function DebugProbe() {
  debug.store = useGraphDebugStore();
  return null;
}

function renderTree(payload: BehaviourTreeDocument = createDefaultBehaviourTree()) {
  store.reset(payload as unknown as Record<string, unknown>);
  return render(<TreePanels />);
}

function TreePanels() {
  return (
    <GraphDebugProvider>
      <DebugProbe />
      <DocumentWorkspaceProvider documentId={DOC_ID}>
        <BehaviourTreeEditingProvider>
          <BehaviourTreeGraphPanel {...panelProps} />
          <BehaviourTreeDetailsPanel {...panelProps} />
          <BehaviourTreeBlackboardPanel {...panelProps} />
          <BehaviourTreeCompilerResultsPanel {...panelProps} />
        </BehaviourTreeEditingProvider>
      </DocumentWorkspaceProvider>
    </GraphDebugProvider>
  );
}

function lastCommit(): BehaviourTreeDocument {
  const calls = store.applyAssetDocumentChange.mock.calls.filter(
    (call) => call[0] === DOC_ID,
  );
  return calls[calls.length - 1]![1] as unknown as BehaviourTreeDocument;
}

function treeWithWait(): BehaviourTreeDocument {
  const doc = createDefaultBehaviourTree();
  doc.blackboardGuid = "bb-1";
  const task = doc.nodes.find((node) => node.id === "task")!;
  task.classId = "bt.task.wait";
  task.properties = { durationMs: 500 };
  return doc;
}

function treeWithSetBlackboard(
  key: string,
  value: unknown = true,
): BehaviourTreeDocument {
  const doc = createDefaultBehaviourTree();
  doc.blackboardGuid = "bb-1";
  const task = doc.nodes.find((node) => node.id === "task")!;
  task.classId = "bt.task.setBlackboard";
  task.properties = { key, value };
  return doc;
}

function treeWithMisorderedSiblings(): BehaviourTreeDocument {
  const doc = createDefaultBehaviourTree();
  doc.nodes.push({
    id: "wait",
    kind: "task",
    classId: "bt.task.wait",
    children: [],
    decorators: [],
    services: [],
    properties: { durationMs: 100 },
  });
  const sequence = doc.nodes.find((node) => node.id === "sequence")!;
  sequence.children = ["task", "wait"];
  doc.editorPositions = {
    root: { x: 0, y: 0 },
    sequence: { x: 0, y: 180 },
    task: { x: 400, y: 360 },
    wait: { x: 0, y: 360 },
  };
  return doc;
}

describe("BehaviourTreeEditor", () => {
  it("leaves the graph context and validation alone when only the selection changes", async () => {
    renderTree(treeWithWait());
    await waitFor(() => expect(graphContext.last).toBeDefined());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const context = graphContext.last;
    const validations = vi.mocked(validateBehaviourTree).mock.calls.length;
    graphContext.seen.clear();

    fireEvent.click(screen.getByTestId("bt-node-task"));
    await waitFor(() => expect(screen.getByTestId("property-durationMs")).toBeTruthy());

    // A new context value re-renders every node, so selecting one node must not make one.
    expect([...graphContext.seen].every((seen) => seen === context)).toBe(true);
    expect(vi.mocked(validateBehaviourTree).mock.calls.length).toBe(validations);

    // The menu and canvas callbacks still act on the tree as it is now.
    fireEvent.contextMenu(screen.getByTestId("bt-node-task"));
    fireEvent.click(screen.getByTestId("bt-menu-wrap"));
    expect(lastCommit().nodes.find((node) => node.id === "sequence")?.children[0]).not.toBe("task");
  });

  describe("while a Simulation follows an instance of the tree", () => {
    const target = { kind: "behaviourTree", assetGuid: "tree-1" } as const;
    const btState = (instanceId: string, patch: Record<string, unknown>) => ({
      instanceId, btNodeId: null, lastResults: {}, stack: [], blackboard: {}, ...patch,
    });
    function follow(...instances: string[]) {
      act(() => {
        debug.store!.setTarget(target);
        debug.store!.receiveRoster({
          target, reset: true, removed: [],
          added: instances.map((id) => ({ id, kind: "component" as const, label: id })),
        });
      });
    }

    it("shows the followed instance's node status and Blackboard, and clears them when the follow ends", async () => {
      livePlay.playing = true;
      const view = renderTree(treeWithWait());
      const task = () => view.container.querySelector('[data-id="task"] [data-bt-state]');
      expect(task()?.getAttribute("data-bt-state")).toBe("idle");
      follow("guard");

      act(() => debug.store!.receiveBtState(btState("guard", {
        btNodeId: "task", blackboard: { hp: 3 }, stack: [{ nodeId: "sequence" }],
      })));
      await waitFor(() => expect(task()?.getAttribute("data-bt-state")).toBe("running"));
      expect(screen.getByTestId("bt-blackboard-watch").textContent).toContain("hp: 3");

      act(() => debug.store!.receiveBtState(btState("guard", { lastResults: { task: "success" }, blackboard: { hp: 2 } })));
      await waitFor(() => expect(task()?.getAttribute("data-bt-state")).toBe("success"));
      expect(screen.getByTestId("bt-blackboard-watch").textContent).toContain("hp: 2");

      act(() => debug.store!.setTarget(null));
      await waitFor(() => expect(task()?.getAttribute("data-bt-state")).toBe("idle"));
      expect(screen.queryByTestId("bt-blackboard-watch")).toBeNull();
    });

    it("explains a node's status in a tip only while a Simulation debugs the tree", async () => {
      livePlay.playing = true;
      renderTree(treeWithWait());
      const hover = () => fireEvent.pointerOver(screen.getByTestId("bt-node-task"));
      hover();
      expect(screen.queryByTestId("graph-node-status-tip")).toBeNull();

      follow("guard");
      hover();
      expect(screen.getByTestId("graph-node-status-tip").textContent).toBe("No status yet");
      act(() => debug.store!.receiveBtState(btState("guard", { btNodeId: "task", stack: [{ nodeId: "task" }] })));
      await waitFor(() => expect(screen.getByTestId("graph-node-status-tip").textContent).toBe("Running"));
    });

    it("shows nothing of another instance than the followed one", async () => {
      livePlay.playing = true;
      const view = renderTree(treeWithWait());
      follow("guard", "scout");
      act(() => debug.store!.receiveBtState(btState("scout", { btNodeId: "task", blackboard: { hp: 9 } })));
      expect(view.container.querySelector('[data-id="task"] [data-bt-state]')?.getAttribute("data-bt-state")).toBe("idle");
      expect(screen.queryByTestId("bt-blackboard-watch")).toBeNull();

      act(() => debug.store!.select("scout"));
      act(() => debug.store!.receiveBtState(btState("scout", { btNodeId: "task", blackboard: { hp: 9 } })));
      await waitFor(() => expect(view.container.querySelector('[data-id="task"] [data-bt-state]')?.getAttribute("data-bt-state")).toBe("running"));
      expect(screen.getByTestId("bt-blackboard-watch").textContent).toContain("hp: 9");
    });

    it("leaves the graph context alone as the tree runs, so no node renders for a status change it does not show", async () => {
      livePlay.playing = true;
      renderTree(treeWithWait());
      await waitFor(() => expect(graphContext.last).toBeDefined());
      follow("guard");
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      const context = graphContext.last;
      graphContext.seen.clear();
      for (let tick = 0; tick < 5; tick++) {
        act(() => debug.store!.receiveBtState(btState("guard", {
          btNodeId: "task", lastResults: { task: tick % 2 ? "running" : "success" }, stack: [{ nodeId: "task" }],
        })));
      }
      expect([...graphContext.seen].every((seen) => seen === context)).toBe(true);
    });
  });

  it("adds Move To Blackboard Key and offers only spatial linked keys", async () => {
    const doc = treeWithWait();
    renderTree(doc);
    await act(() => store.applyAssetDocumentChange(BB_ID, {
      name: "Guard",
      keys: [
        ...defaultBlackboard.keys,
        { name: "position", type: { kind: "vec3" } },
        { name: "position2d", type: { kind: "vec2" } },
        { name: "target", type: { kind: "objectRef", classId: "BObject" } },
        { name: "actor", type: { kind: "actorRef", classId: "Actor" } },
      ],
    }));
    fireEvent.click(screen.getByTestId("graph-add-node"));
    fireEvent.change(screen.getByTestId("node-palette-search"), { target: { value: "Move To" } });
    fireEvent.click(await screen.findByTestId("node-palette-item-bt.task.moveToBlackboardKey"));
    await waitFor(() => expect(screen.queryByTestId("node-palette")).toBeNull());
    const added = lastCommit().nodes.find((node) => node.classId === "bt.task.moveToBlackboardKey")!;
    expect(added).toBeDefined();
    fireEvent.click(screen.getByTestId(`bt-node-${added.id}`));
    fireEvent.click(screen.getByTestId("property-key"));
    expect(await screen.findByRole("option", { name: "Position 2D" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Alert" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Hp" })).toBeNull();
    expect(screen.getByRole("option", { name: "Actor" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Target" })).toBeTruthy();
    const option = screen.getByRole("option", { name: "Position" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    await waitFor(() => {
      expect(lastCommit().nodes.find((node) => node.id === added.id)?.properties).toEqual({
        key: "position",
        acceptRadius: 0.5,
      });
    });
  });

  it("keeps Move To Blackboard Key as a None-only selector when no compatible keys exist", () => {
    const doc = treeWithWait();
    const task = doc.nodes.find((node) => node.id === "task")!;
    task.classId = "bt.task.moveToBlackboardKey";
    task.properties = { key: "", acceptRadius: 0.5 };
    renderTree(doc);
    fireEvent.click(screen.getByTestId("bt-node-task"));
    const picker = screen.getByTestId("property-key");
    expect(picker.tagName).not.toBe("INPUT");
    fireEvent.click(picker);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["None"]);
  });

  it("renders the default selector/sequence/succeed tree and Auto Arrange", () => {
    renderTree(createDefaultBehaviourTree("Patrol"));
    expect(screen.getByTestId("behaviour-tree-editor")).toBeTruthy();
    expect(screen.getByTestId("bt-node-root")).toBeTruthy();
    fireEvent.click(screen.getByTestId("bt-auto-arrange"));
    expect(store.applyAssetDocumentChange).toHaveBeenCalled();
    expect(screen.queryByTestId("graph-break-links")).toBeNull();
    expect(screen.queryByTestId("graph-format")).toBeNull();
    expect(screen.queryByTestId("graph-copy")).toBeNull();
    expect(screen.queryByTestId("graph-paste")).toBeNull();
  });

  it("auto-arranges positions without changing children order", () => {
    const doc = treeWithMisorderedSiblings();
    renderTree(doc);
    fireEvent.click(screen.getByTestId("bt-auto-arrange"));
    const next = lastCommit();
    expect(next.nodes.find((node) => node.id === "sequence")?.children).toEqual([
      "task",
      "wait",
    ]);
    expect(next.editorPositions?.wait?.x).toBeGreaterThan(
      next.editorPositions?.task?.x ?? 0,
    );
  });

  it("links a Blackboard asset from the Blackboard dock", async () => {
    renderTree();
    fireEvent.click(
      within(screen.getByTestId("behaviour-tree-blackboard")).getByTestId(
        "property-blackboard",
      ),
    );
    fireEvent.click(await screen.findByTestId("search-item-bb-1"));
    expect(lastCommit().blackboardGuid).toBe("bb-1");
  });

  it("lists linked blackboard keys and types without the full editor", () => {
    renderTree(treeWithWait());
    expect(screen.queryByTestId("blackboard-editor")).toBeNull();
    expect(screen.queryByTestId("blackboard-add-key")).toBeNull();
    const alert = screen.getByTestId("bt-blackboard-key-alert");
    expect(alert.textContent).toMatch(/Alert/i);
    expect(alert.textContent).toMatch(/Bool/);
    expect(screen.getByTestId("bt-blackboard-key-hp").textContent).toMatch(/Float/);
  });

  it("drops the previous closed Blackboard's keys when the relinked one cannot load", async () => {
    loadAssetDocument.mockImplementation(async (_kind: string, path: string) =>
      path === "assets/bb-scout.blackboard.hasset"
        ? { name: "Scout", keys: [{ name: "target", type: { kind: "vector3" } }] }
        : null,
    );
    const doc = treeWithWait();
    doc.blackboardGuid = "bb-scout";
    renderTree(doc);
    expect(await screen.findByTestId("bt-blackboard-key-target")).toBeTruthy();
    act(() => store.reset({ ...doc, blackboardGuid: "bb-missing" } as unknown as Record<string, unknown>));
    await waitFor(() => expect(loadAssetDocument).toHaveBeenCalledWith("blackboard", "assets/bb-missing.blackboard.hasset"));
    await waitFor(() => expect(screen.queryByTestId("bt-blackboard-key-target")).toBeNull());
  });

  it("lists compiler diagnostics and focuses the node when tapped", async () => {
    const doc = createDefaultBehaviourTree();
    const sequence = doc.nodes.find((node) => node.id === "sequence")!;
    sequence.children = [];
    doc.nodes = doc.nodes.filter((node) => node.id !== "task");
    renderTree(doc);
    expect(screen.getByTestId("behaviour-tree-compiler-results")).toBeTruthy();
    fireEvent.click(
      screen.getByTestId("behaviour-tree-diagnostic-bt.composite_empty"),
    );
    expect(
      screen.getByTestId("behaviour-tree-diagnostic-bt.composite_empty").textContent,
    ).toContain("Error");
    await waitFor(() => {
      expect(screen.getByTestId("property-classId").textContent).toContain(
        "Sequence",
      );
    });
  });

  it("adds a decorator from the attachment catalog", () => {
    renderTree();
    fireEvent.click(screen.getByTestId("bt-add-decorator"));
    fireEvent.click(screen.getByTestId("bt-attachment-item-bt.decorator.loop"));
    const root = lastCommit().nodes.find((node) => node.id === "root");
    expect(root?.decorators.some((row) => row.classId === "bt.decorator.loop")).toBe(
      true,
    );
  });

  it("edits Wait duration in Details", () => {
    renderTree(treeWithWait());
    fireEvent.click(screen.getByTestId("bt-node-task"));
    const duration = screen.getByTestId("property-durationMs");
    fireEvent.change(duration, { target: { value: "250" } });
    fireEvent.blur(duration);
    const task = lastCommit().nodes.find((node) => node.id === "task");
    expect(task?.properties.durationMs).toBe(250);
  });

  it("clears Details when the selected node is deselected on the canvas", async () => {
    const { container } = renderTree(treeWithWait());
    fireEvent.click(screen.getByTestId("bt-node-task"));
    expect(screen.getByTestId("property-durationMs")).toBeTruthy();
    fireEvent.click(container.querySelector(".react-flow__pane")!);
    await waitFor(() => expect(screen.queryByTestId("property-durationMs")).toBeNull());
    expect(screen.queryByTestId("bt-add-decorator")).toBeNull();
  });

  it("picks an Audio asset on Play Sound in Details", async () => {
    const doc = createDefaultBehaviourTree();
    const task = doc.nodes.find((node) => node.id === "task")!;
    task.classId = "bt.task.playSound";
    task.properties = { audioAssetGuid: "", volume: 1 };
    renderTree(doc);
    fireEvent.click(screen.getByTestId("bt-node-task"));
    expect(screen.getByTestId("property-audioAssetGuid")).toBeTruthy();
    expect(screen.getByTestId("property-volume")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-audioAssetGuid"));
    fireEvent.click(await screen.findByTestId("search-item-audio-1"));
    const next = lastCommit().nodes.find((node) => node.id === "task");
    expect(next?.properties.audioAssetGuid).toBe("audio-1");
  });

  it("picks an Animation asset on Play Animation in Details", async () => {
    const doc = createDefaultBehaviourTree();
    const task = doc.nodes.find((node) => node.id === "task")!;
    task.classId = "bt.task.playAnimation";
    task.properties = { clipKind: "animation", clipAssetGuid: "" };
    renderTree(doc);
    fireEvent.click(screen.getByTestId("bt-node-task"));
    expect(screen.getByTestId("property-clipKind")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-clipAssetGuid"));
    fireEvent.click(await screen.findByTestId("search-item-anim-walk"));
    const next = lastCommit().nodes.find((node) => node.id === "task");
    expect(next?.properties).toMatchObject({
      clipAssetGuid: "anim-walk",
      clipName: "Walk",
    });
  });

  it("picks a Sprite Animation asset when Play Animation clip kind is sprite", async () => {
    const doc = createDefaultBehaviourTree();
    const task = doc.nodes.find((node) => node.id === "task")!;
    task.classId = "bt.task.playAnimation";
    task.properties = { clipKind: "sprite", clipAssetGuid: "" };
    renderTree(doc);
    fireEvent.click(screen.getByTestId("bt-node-task"));
    fireEvent.click(screen.getByTestId("property-clipAssetGuid"));
    fireEvent.click(await screen.findByTestId("search-item-sprite-run"));
    const next = lastCommit().nodes.find((node) => node.id === "task");
    expect(next?.properties.clipAssetGuid).toBe("sprite-run");
  });

  it("selects a Wait node added from the palette so Details show duration", async () => {
    const { container } = renderTree();
    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.click(pane!);
    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));
    fireEvent.change(screen.getByTestId("node-palette-search"), { target: { value: "Wait" } });
    fireEvent.click(screen.getByTestId("node-palette-item-bt.task.wait"));
    await waitFor(() => {
      expect(screen.getByTestId("property-durationMs")).toBeTruthy();
    });
  });

  it("lists a project BTTask in the add-node palette", () => {
    const { container } = renderTree();
    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.click(pane!);
    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));
    fireEvent.change(screen.getByTestId("node-palette-search"), { target: { value: "custom" } });
    expect(screen.getByTestId("node-palette-item-BTTask_Custom")).toBeTruthy();
  });

  it("adds a project BTComposite as a sequence rather than a task leaf", async () => {
    const { container } = renderTree();
    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.click(pane!);
    fireEvent.click(screen.getByRole("button", { name: "Add Node" }));
    fireEvent.change(screen.getByTestId("node-palette-search"), { target: { value: "brain" } });
    fireEvent.click(screen.getByTestId("node-palette-item-MyBrain"));
    await waitFor(() => {
      expect(
        (store.getSnapshot() as unknown as BehaviourTreeDocument).nodes.find(
          (node) => node.classId === "MyBrain",
        )?.kind,
      ).toBe("sequence");
    });
  });

  it("lists a project BTDecorator in the attachment catalog", () => {
    renderTree();
    fireEvent.click(screen.getByTestId("bt-add-decorator"));
    expect(screen.getByTestId("bt-attachment-item-BTDecorator_Alert")).toBeTruthy();
  });

  it("sets a breakpoint on any tree node, the root included, from its menu and marks the node", () => {
    const breakpoints = new BreakpointStore();
    store.reset(createDefaultBehaviourTree() as unknown as Record<string, unknown>);
    const { container } = render(
      <BreakpointStoreProvider store={breakpoints}>
        <TreePanels />
      </BreakpointStoreProvider>,
    );
    fireEvent.contextMenu(screen.getByTestId("bt-node-root"));
    fireEvent.click(screen.getByText("Add Breakpoint"));
    expect(breakpoints.list()).toEqual([{
      assetGuid: "tree-1",
      graphId: BT_DEBUG_GRAPH_ID,
      nodeId: "root",
      enabled: true,
      label: { className: "Patrol", graphName: "Behaviour Tree", nodeTitle: "Selector" },
    }]);
    const root = container.querySelector('.react-flow__node[data-id="root"]')!;
    expect(root.querySelector("[data-breakpoint]")?.getAttribute("data-breakpoint")).toBe("enabled");

    // The menu reads the breakpoint when it opens.
    fireEvent.contextMenu(screen.getByTestId("bt-node-root"));
    fireEvent.click(screen.getByText("Disable Breakpoint"));
    expect(breakpoints.list()[0]?.enabled).toBe(false);
    expect(root.querySelector("[data-breakpoint]")?.getAttribute("data-breakpoint")).toBe("disabled");
  });

  it("wraps the selected node from the long-press menu", () => {
    renderTree();
    fireEvent.contextMenu(screen.getByTestId("bt-node-task"));
    fireEvent.click(screen.getByTestId("bt-menu-wrap"));
    const sequence = lastCommit().nodes.find((node) => node.id === "sequence");
    expect(sequence?.children).toHaveLength(1);
    expect(sequence?.children[0]).not.toBe("task");
  });

  it("removes a selected decorator attachment", () => {
    const doc = addDecorator(
      createDefaultBehaviourTree(),
      "root",
      "bt.decorator.blackboardIsSet",
    );
    const decoratorId = doc.nodes.find((node) => node.id === "root")!.decorators[0]!.id;
    renderTree(doc);
    fireEvent.click(screen.getByTestId(`bt-decorator-${decoratorId}`));
    fireEvent.click(screen.getByTestId("bt-remove-attachment"));
    expect(lastCommit().nodes.find((node) => node.id === "root")?.decorators).toEqual(
      [],
    );
  });

  it("uses blackboard keys for Blackboard Is Set", () => {
    const doc = addDecorator(
      createDefaultBehaviourTree(),
      "task",
      "bt.decorator.blackboardIsSet",
    );
    doc.blackboardGuid = "bb-1";
    const decoratorId = doc.nodes.find((node) => node.id === "task")!.decorators[0]!.id;
    renderTree(doc);
    fireEvent.click(screen.getByTestId(`bt-decorator-${decoratorId}`));
    expect(screen.getByTestId("property-key").tagName).not.toBe("INPUT");
  });

  it("hides Set Blackboard value until a key is chosen", () => {
    const doc = treeWithSetBlackboard("");
    renderTree(doc);
    fireEvent.click(screen.getByTestId("bt-node-task"));
    expect(screen.getByTestId("property-key")).toBeTruthy();
    expect(screen.queryByTestId("property-value")).toBeNull();
  });

  it("shows a bool checkbox for a Set Blackboard bool key", () => {
    const doc = treeWithSetBlackboard("alert", true);
    renderTree(doc);
    fireEvent.click(screen.getByTestId("bt-node-task"));
    const value = screen.getByTestId("property-value");
    expect(value.getAttribute("role")).toBe("checkbox");
    expect(value.tagName).not.toBe("INPUT");
  });

  it("shows a number field for a Set Blackboard float key", () => {
    const doc = treeWithSetBlackboard("hp", 12);
    renderTree(doc);
    fireEvent.click(screen.getByTestId("bt-node-task"));
    const value = screen.getByTestId("property-value");
    expect(value.tagName).toBe("INPUT");
    fireEvent.change(value, { target: { value: "13" } });
    fireEvent.blur(value);
    const task = lastCommit().nodes.find((node) => node.id === "task");
    expect(task?.properties.value).toBe(13);
  });

  it("resets Set Blackboard value when the key type changes", async () => {
    const doc = treeWithSetBlackboard("alert", true);
    renderTree(doc);
    fireEvent.click(screen.getByTestId("bt-node-task"));
    fireEvent.click(screen.getByTestId("property-key"));
    const option = await screen.findByRole("option", { name: "Hp" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    const task = lastCommit().nodes.find((node) => node.id === "task");
    expect(task?.properties.key).toBe("hp");
    expect(task?.properties.value).toBe(0);
  });

  it("types Compare Blackboard Value from the selected key", () => {
    const doc = addDecorator(
      createDefaultBehaviourTree(),
      "task",
      "bt.decorator.compareBlackboardValue",
    );
    doc.blackboardGuid = "bb-1";
    const decorator = doc.nodes.find((node) => node.id === "task")!.decorators[0]!;
    decorator.properties = { key: "alert", op: "eq", value: true };
    renderTree(doc);
    fireEvent.click(screen.getByTestId(`bt-decorator-${decorator.id}`));
    expect(screen.getByTestId("property-value").getAttribute("role")).toBe(
      "checkbox",
    );
  });

  it("shows a canvas diagnostic on an empty composite", () => {
    const doc = createDefaultBehaviourTree();
    const sequence = doc.nodes.find((node) => node.id === "sequence")!;
    sequence.children = [];
    doc.nodes = doc.nodes.filter((node) => node.id !== "task");
    renderTree(doc);
    expect(screen.getByLabelText("1 error")).toBeTruthy();
  });
});
