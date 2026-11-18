import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphEditor, type GraphEditorProps } from "./graph-editor";
import type { GraphDocument, SerializedPin } from "./graph-types";
import { animGraphNodeTypes } from "./anim-graph-nodes";
import { treeNodeTypes } from "./tree-node";

afterEach(cleanup);

const execIn: SerializedPin = { id: "execIn", name: "Exec", kind: "exec", direction: "in", type: { kind: "exec" } };

const eventGraph: GraphDocument = {
  nodes: [{ id: "event", type: "flow.event.custom", position: { x: 0, y: 0 }, data: { title: "Event Jump", __pins: [execIn] } }],
  edges: [],
};

function titleOf(container: HTMLElement, nodeId: string): HTMLElement {
  return container.querySelector(`.react-flow__node[data-id="${nodeId}"] [data-node-title]`) as HTMLElement;
}

function renderGraph(props: Partial<GraphEditorProps>) {
  return render(<GraphEditor initialGraph={eventGraph} sessionViewport={{ x: 0, y: 0, zoom: 1 }} {...props} />);
}

describe("node title double-click", () => {
  it("fires once for a mouse double-click, and the node double-click does not", () => {
    const onNodeTitleDoubleClick = vi.fn();
    const onNodeDoubleClick = vi.fn();
    const { container } = renderGraph({ onNodeTitleDoubleClick, onNodeDoubleClick });
    const title = titleOf(container, "event");
    fireEvent.click(title);
    fireEvent.click(title);
    fireEvent.doubleClick(title);
    expect(onNodeTitleDoubleClick.mock.calls).toEqual([["event"]]);
    expect(onNodeDoubleClick).not.toHaveBeenCalled();
  });

  it("fires for two taps, and for a native double-click alone", () => {
    const onNodeTitleDoubleClick = vi.fn();
    const first = renderGraph({ onNodeTitleDoubleClick });
    fireEvent.click(titleOf(first.container, "event"));
    expect(onNodeTitleDoubleClick).not.toHaveBeenCalled();
    fireEvent.click(titleOf(first.container, "event"));
    expect(onNodeTitleDoubleClick).toHaveBeenCalledTimes(1);
    first.unmount();
    const second = renderGraph({ onNodeTitleDoubleClick });
    fireEvent.doubleClick(titleOf(second.container, "event"));
    expect(onNodeTitleDoubleClick).toHaveBeenCalledTimes(2);
  });

  it("keeps a body double-click for onNodeDoubleClick", () => {
    const onNodeTitleDoubleClick = vi.fn();
    const onNodeDoubleClick = vi.fn();
    const { container } = renderGraph({ onNodeTitleDoubleClick, onNodeDoubleClick });
    fireEvent.doubleClick(container.querySelector('.react-flow__node[data-id="event"] [data-pin-row]')!);
    expect(onNodeDoubleClick).toHaveBeenCalledWith("event");
    expect(onNodeTitleDoubleClick).not.toHaveBeenCalled();
  });

  it("does nothing read-only or with Cut Links on", () => {
    const onNodeTitleDoubleClick = vi.fn();
    const first = renderGraph({ onNodeTitleDoubleClick, readOnly: true });
    fireEvent.doubleClick(titleOf(first.container, "event"));
    first.unmount();
    const second = renderGraph({ onNodeTitleDoubleClick });
    fireEvent.click(second.getByTestId("graph-cut-links"));
    fireEvent.doubleClick(titleOf(second.container, "event"));
    expect(onNodeTitleDoubleClick).not.toHaveBeenCalled();
  });

  it("seeds the rename field with renamingNodeValue", async () => {
    const { getByTestId } = renderGraph({ renamingNodeId: "event", renamingNodeValue: "Jump" });
    const input = await waitFor(() => getByTestId("graph-node-rename") as HTMLInputElement);
    expect(input.value).toBe("Jump");
  });
});

describe("inline rename on custom nodes", () => {
  const stateGraph: GraphDocument = {
    nodes: [
      { id: "idle", type: "anim.state", position: { x: 0, y: 0 }, data: { title: "Idle" } },
      { id: "alias", type: "anim.alias", position: { x: 400, y: 0 }, data: { title: "From Air", stateCount: 2 } },
    ],
    edges: [],
  };

  it("renames an Animation state: Enter commits, Escape cancels", async () => {
    const onNodeRenameCommit = vi.fn();
    const onNodeRenameCancel = vi.fn();
    const onNodeTitleDoubleClick = vi.fn();
    const props = { initialGraph: stateGraph, nodeTypes: animGraphNodeTypes, onNodeRenameCommit, onNodeRenameCancel, onNodeTitleDoubleClick };
    const plain = render(<GraphEditor {...props} />);
    fireEvent.doubleClick(titleOf(plain.container, "alias"));
    expect(onNodeTitleDoubleClick).toHaveBeenCalledWith("alias");
    plain.unmount();

    const first = render(<GraphEditor {...props} renamingNodeId="idle" />);
    const input = await waitFor(() => first.getByTestId("graph-node-rename") as HTMLInputElement);
    expect(input.value).toBe("Idle");
    fireEvent.change(input, { target: { value: "Walk" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNodeRenameCommit).toHaveBeenCalledWith("idle", "Walk");
    first.unmount();

    const second = render(<GraphEditor {...props} renamingNodeId="alias" />);
    fireEvent.keyDown(await waitFor(() => second.getByTestId("graph-node-rename")), { key: "Escape" });
    expect(onNodeRenameCancel).toHaveBeenCalledTimes(1);
  });

  it("renames a Behaviour Tree node from its title, keeping the header's double-tap elsewhere", async () => {
    const treeGraph: GraphDocument = {
      nodes: [{ id: "task", type: "bt.node", position: { x: 0, y: 0 }, data: { title: "Move To", kind: "task" } }],
      edges: [],
    };
    const onNodeTitleDoubleClick = vi.fn();
    const onNavigateRequest = vi.fn();
    const onNodeRenameCommit = vi.fn();
    const props = { initialGraph: treeGraph, nodeTypes: treeNodeTypes, onNodeTitleDoubleClick, onNavigateRequest, onNodeRenameCommit };
    const plain = render(<GraphEditor {...props} />);
    const title = titleOf(plain.container, "task");
    fireEvent.click(title);
    fireEvent.click(title);
    expect(onNodeTitleDoubleClick).toHaveBeenCalledWith("task");
    expect(onNavigateRequest).not.toHaveBeenCalled();
    const header = plain.getByTestId("bt-node-task");
    fireEvent.click(header);
    fireEvent.click(header);
    expect(onNavigateRequest).toHaveBeenCalledWith({ nodeId: "task" });
    plain.unmount();

    const renaming = render(<GraphEditor {...props} renamingNodeId="task" />);
    const input = await waitFor(() => renaming.getByTestId("graph-node-rename") as HTMLInputElement);
    expect(input.closest("button")).toBeNull();
    fireEvent.change(input, { target: { value: "Chase" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNodeRenameCommit).toHaveBeenCalledWith("task", "Chase");
  });
});
