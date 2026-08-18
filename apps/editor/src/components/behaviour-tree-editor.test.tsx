import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  addDecorator,
  createDefaultBehaviourTree,
  type BehaviourTreeDocument,
} from "@babylonslate/behaviour-tree";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { BehaviourTreeEditingProvider } from "../context/behaviour-tree-editing-context";
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

const DOC_ID = "behaviour-tree:assets/Patrol.bt.babasset";
const BB_ID = "blackboard:assets/Guard.blackboard.babasset";
const BB_PATH = "assets/Guard.blackboard.babasset";
const openDocument = vi.hoisted(() => vi.fn());
const loadAssetDocument = vi.hoisted(() => vi.fn());

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
  return {
  useDocuments: () => {
    const content = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const blackboard = useSyncExternalStore(store.subscribe, store.getBlackboard);
    return {
      openDocuments: [
        {
          id: DOC_ID,
          ref: { kind: "behaviour-tree", path: "assets/Patrol.bt.babasset" },
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
            path: "assets/BTTask_Custom.class.babasset",
          },
          {
            header: {
              guid: "class-2",
              name: "BTDecorator_Alert",
              type: "Class",
              parentClass: "BTDecorator",
            },
            path: "assets/BTDecorator_Alert.class.babasset",
          },
          {
            header: {
              guid: "class-3",
              name: "MyBrain",
              type: "Class",
              parentClass: "BTComposite",
            },
            path: "assets/MyBrain.class.babasset",
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
            path: "assets/jump.babasset",
          },
        ],
        getByGuid: (guid: string) =>
          guid === "bb-1"
            ? {
                header: { guid: "bb-1", name: "Guard", type: "Blackboard" },
                path: BB_PATH,
              }
            : guid === "audio-1"
              ? {
                  header: { guid: "audio-1", name: "Jump", type: "Audio" },
                  path: "assets/jump.babasset",
                }
              : guid === "class-1"
              ? {
                  header: {
                    guid: "class-1",
                    name: "BTTask_Custom",
                    type: "Class",
                    parentClass: "BTTask",
                  },
                  path: "assets/BTTask_Custom.class.babasset",
                }
              : undefined,
      },
    };
  },
  };
});

vi.mock("../context/play-context", () => ({
  usePlay: () => ({
    playing: false,
    liveBtState: null,
    focusedNodeId: null,
  }),
}));

afterEach(() => {
  cleanup();
  openDocument.mockClear();
  loadAssetDocument.mockClear();
});

beforeEach(() => {
  store.applyAssetDocumentChange.mockClear();
  loadAssetDocument.mockResolvedValue(defaultBlackboard);
  store.reset(
    createDefaultBehaviourTree() as unknown as Record<string, unknown>,
  );
});

const panelProps = {} as IDockviewPanelProps;

function renderTree(payload: BehaviourTreeDocument = createDefaultBehaviourTree()) {
  store.reset(payload as unknown as Record<string, unknown>);
  return render(
    <DocumentWorkspaceProvider documentId={DOC_ID}>
      <BehaviourTreeEditingProvider>
        <BehaviourTreeGraphPanel {...panelProps} />
        <BehaviourTreeDetailsPanel {...panelProps} />
        <BehaviourTreeBlackboardPanel {...panelProps} />
        <BehaviourTreeCompilerResultsPanel {...panelProps} />
      </BehaviourTreeEditingProvider>
    </DocumentWorkspaceProvider>,
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

  it("keeps the Blackboard asset picker out of Details", () => {
    renderTree();
    expect(
      within(screen.getByTestId("bt-details")).queryByTestId("property-blackboard"),
    ).toBeNull();
    expect(screen.getByTestId("behaviour-tree-blackboard")).toBeTruthy();
    expect(
      within(screen.getByTestId("behaviour-tree-blackboard")).getByTestId(
        "property-blackboard",
      ),
    ).toBeTruthy();
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

  it("edits blackboard keys through the linked blackboard document", () => {
    renderTree(treeWithWait());
    expect(screen.getByTestId("blackboard-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("blackboard-add-key"));
    const call = store.applyAssetDocumentChange.mock.calls.find(
      (entry) => entry[0] === BB_ID,
    );
    expect(call).toBeTruthy();
    const next = call![1] as { keys: Array<{ name: string }> };
    expect(next.keys.some((key) => key.name === "key")).toBe(true);
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

  it("selects a Wait node added from the palette so Details show duration", async () => {
    const { container } = renderTree();
    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.click(pane!);
    fireEvent.click(pane!);
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
    fireEvent.click(pane!);
    expect(screen.getByTestId("node-palette-item-BTTask_Custom")).toBeTruthy();
  });

  it("adds a project BTComposite as a sequence rather than a task leaf", async () => {
    const { container } = renderTree();
    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.click(pane!);
    fireEvent.click(pane!);
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

  it("shows a canvas diagnostic on an empty composite", () => {
    const doc = createDefaultBehaviourTree();
    const sequence = doc.nodes.find((node) => node.id === "sequence")!;
    sequence.children = [];
    doc.nodes = doc.nodes.filter((node) => node.id !== "task");
    renderTree(doc);
    expect(screen.getByLabelText("1 error")).toBeTruthy();
  });
});
