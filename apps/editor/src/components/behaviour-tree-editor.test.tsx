import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  addDecorator,
  createDefaultBehaviourTree,
  type BehaviourTreeDocument,
} from "@babylonslate/behaviour-tree";
import { BehaviourTreeEditor } from "./behaviour-tree-editor";

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

const openDocument = vi.hoisted(() => vi.fn());

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
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
          header: { guid: "bb-1", name: "Guard", type: "Blackboard", parentClass: null },
          path: "assets/Guard.blackboard.babasset",
        },
      ],
      getByGuid: (guid: string) =>
        guid === "bb-1"
          ? {
              header: { guid: "bb-1", name: "Guard", type: "Blackboard" },
              path: "assets/Guard.blackboard.babasset",
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
    openDocuments: [
      {
        ref: { kind: "blackboard", path: "assets/Guard.blackboard.babasset" },
        content: {
          name: "Guard",
          keys: [
            { name: "alert", type: { kind: "bool" } },
            { name: "hp", type: { kind: "float" } },
          ],
        },
      },
    ],
    openDocument,
  }),
}));

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
});

function treeWithWait(): BehaviourTreeDocument {
  const doc = createDefaultBehaviourTree();
  doc.blackboardGuid = "bb-1";
  const task = doc.nodes.find((node) => node.id === "task")!;
  task.classId = "bt.task.wait";
  task.properties = { durationMs: 500 };
  return doc;
}

describe("BehaviourTreeEditor", () => {
  it("renders the default selector/sequence/succeed tree and relayout", () => {
    const onChange = vi.fn();
    render(
      <BehaviourTreeEditor
        payload={createDefaultBehaviourTree("Patrol") as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("behaviour-tree-editor")).toBeTruthy();
    expect(screen.getByTestId("bt-node-root")).toBeTruthy();
    fireEvent.click(screen.getByTestId("bt-relayout"));
    expect(onChange).toHaveBeenCalled();
    expect(screen.queryByTestId("graph-break-links")).toBeNull();
    expect(screen.queryByTestId("graph-format")).toBeNull();
  });

  it("adds a decorator from the attachment catalog", () => {
    const onChange = vi.fn();
    render(
      <BehaviourTreeEditor
        payload={createDefaultBehaviourTree() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("bt-add-decorator"));
    fireEvent.click(screen.getByTestId("bt-attachment-item-bt.decorator.loop"));
    const next = onChange.mock.calls.at(-1)?.[0] as {
      nodes: Array<{ id: string; decorators: Array<{ classId: string }> }>;
    };
    const root = next.nodes.find((node) => node.id === "root");
    expect(root?.decorators.some((row) => row.classId === "bt.decorator.loop")).toBe(
      true,
    );
  });

  it("edits Wait duration in Details", () => {
    const onChange = vi.fn();
    render(
      <BehaviourTreeEditor
        payload={treeWithWait() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("bt-node-task"));
    const duration = screen.getByTestId("property-durationMs");
    fireEvent.change(duration, { target: { value: "250" } });
    fireEvent.blur(duration);
    const next = onChange.mock.calls.at(-1)?.[0] as {
      nodes: Array<{ id: string; properties: { durationMs?: number } }>;
    };
    const task = next.nodes.find((node) => node.id === "task");
    expect(task?.properties.durationMs).toBe(250);
  });

  it("selects a Wait node added from the palette so Details show duration", async () => {
    function Harness() {
      const [payload, setPayload] = useState(
        () => createDefaultBehaviourTree() as unknown as Record<string, unknown>,
      );
      return <BehaviourTreeEditor payload={payload} onChange={setPayload} />;
    }
    const { container } = render(<Harness />);
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
    const { container } = render(
      <BehaviourTreeEditor
        payload={createDefaultBehaviourTree() as unknown as Record<string, unknown>}
        onChange={vi.fn()}
      />,
    );
    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.click(pane!);
    fireEvent.click(pane!);
    expect(screen.getByTestId("node-palette-item-BTTask_Custom")).toBeTruthy();
  });

  it("adds a project BTComposite as a sequence rather than a task leaf", async () => {
    function Harness() {
      const [payload, setPayload] = useState(
        () => createDefaultBehaviourTree() as unknown as Record<string, unknown>,
      );
      const kind = (payload as BehaviourTreeDocument).nodes.find(
        (node) => node.classId === "MyBrain",
      )?.kind;
      return (
        <>
          <div data-testid="custom-composite-kind">{kind ?? ""}</div>
          <BehaviourTreeEditor payload={payload} onChange={setPayload} />
        </>
      );
    }
    const { container } = render(<Harness />);
    const pane = container.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.click(pane!);
    fireEvent.click(pane!);
    fireEvent.click(screen.getByTestId("node-palette-item-MyBrain"));
    await waitFor(() => {
      expect(screen.getByTestId("custom-composite-kind").textContent).toBe(
        "sequence",
      );
    });
  });

  it("lists a project BTDecorator in the attachment catalog", () => {
    render(
      <BehaviourTreeEditor
        payload={createDefaultBehaviourTree() as unknown as Record<string, unknown>}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("bt-add-decorator"));
    expect(screen.getByTestId("bt-attachment-item-BTDecorator_Alert")).toBeTruthy();
  });

  it("wraps the selected node from the long-press menu", () => {
    const onChange = vi.fn();
    render(
      <BehaviourTreeEditor
        payload={createDefaultBehaviourTree() as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("bt-node-task"));
    fireEvent.click(screen.getByTestId("bt-menu-wrap"));
    const next = onChange.mock.calls.at(-1)?.[0] as {
      nodes: Array<{ id: string; children: string[] }>;
    };
    const sequence = next.nodes.find((node) => node.id === "sequence");
    expect(sequence?.children).toHaveLength(1);
    expect(sequence?.children[0]).not.toBe("task");
  });

  it("removes a selected decorator attachment", () => {
    const onChange = vi.fn();
    const doc = addDecorator(
      createDefaultBehaviourTree(),
      "root",
      "bt.decorator.blackboardIsSet",
    );
    const decoratorId = doc.nodes.find((node) => node.id === "root")!.decorators[0]!.id;
    render(
      <BehaviourTreeEditor
        payload={doc as unknown as Record<string, unknown>}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId(`bt-decorator-${decoratorId}`));
    fireEvent.click(screen.getByTestId("bt-remove-attachment"));
    const next = onChange.mock.calls.at(-1)?.[0] as {
      nodes: Array<{ id: string; decorators: unknown[] }>;
    };
    expect(next.nodes.find((node) => node.id === "root")?.decorators).toEqual([]);
  });

  it("uses blackboard keys for Blackboard Is Set", () => {
    const doc = addDecorator(
      createDefaultBehaviourTree(),
      "task",
      "bt.decorator.blackboardIsSet",
    );
    doc.blackboardGuid = "bb-1";
    const decoratorId = doc.nodes.find((node) => node.id === "task")!.decorators[0]!.id;
    render(
      <BehaviourTreeEditor
        payload={doc as unknown as Record<string, unknown>}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId(`bt-decorator-${decoratorId}`));
    expect(screen.getByTestId("property-key").tagName).not.toBe("INPUT");
  });

  it("shows a canvas diagnostic on an empty composite", () => {
    const doc = createDefaultBehaviourTree();
    const sequence = doc.nodes.find((node) => node.id === "sequence")!;
    sequence.children = [];
    doc.nodes = doc.nodes.filter((node) => node.id !== "task");
    render(
      <BehaviourTreeEditor
        payload={doc as unknown as Record<string, unknown>}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("1 error")).toBeTruthy();
  });
});
