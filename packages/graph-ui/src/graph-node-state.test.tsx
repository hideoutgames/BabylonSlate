import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Profiler, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mathExpressionPins } from "@haptic/scripting";
import { GraphEditor } from "./graph-editor";
import { graphNodeTypes } from "./graph-nodes";
import { GraphInteractionSettingsContext } from "./graph-interaction-settings";
import type { GraphDiagnostic, GraphDocument, SerializedPin } from "./graph-types";

afterEach(cleanup);

const interactions = { assistantEnabled: true, assistantDistance: 48, shakeEnabled: true, readOnlyPinDefaults: false, tapToConnectEnabled: true };

const pin = (id: string, direction: SerializedPin["direction"]): SerializedPin =>
  ({ id, name: id, kind: "data", direction, type: { kind: "float" } });

const formulaData = { __nodeType: "math.expression", formula: "y = a * k" };
const graph: GraphDocument = {
  nodes: [
    ...["a", "b", "c"].map((id, index) => ({
      id,
      type: "test.node",
      position: { x: index * 400, y: 0 },
      data: { title: id.toUpperCase(), __pins: [pin("in", "in"), pin("out", "out")] },
    })),
    { id: "m", type: "math.expression", position: { x: 0, y: 400 }, data: { ...formulaData, __pins: mathExpressionPins(formulaData) } },
  ],
  edges: [],
};

const NODE_IDS = ["a", "b", "c", "m"];

/** Commits of each node's whole subtree (its pins included), counted through React's Profiler. */
function renderCounted() {
  const commits = new Map<string, number>();
  const counted = (Node: typeof graphNodeTypes.pinNode) => (props: ComponentProps<typeof Node>) => (
    <Profiler id={props.id} onRender={() => commits.set(props.id, (commits.get(props.id) ?? 0) + 1)}>
      <Node {...props} />
    </Profiler>
  );
  const nodeTypes = { pinNode: counted(graphNodeTypes.pinNode), mathExpression: counted(graphNodeTypes.mathExpression) };
  type Host = Partial<ComponentProps<typeof GraphEditor>>;
  const editor = (host: Host) => (
    <GraphInteractionSettingsContext.Provider value={interactions}>
      <GraphEditor initialGraph={graph} nodeTypes={nodeTypes} commitPositionsOnDragEnd {...host} />
    </GraphInteractionSettingsContext.Provider>
  );
  const view = render(editor({}));
  return {
    ...view,
    commits,
    /** Renders with `host`, returning each node's commits since the call. */
    update(host: Host) {
      const before = new Map(commits);
      view.rerender(editor(host));
      return Object.fromEntries(NODE_IDS.map((id) => [id, (commits.get(id) ?? 0) - (before.get(id) ?? 0)]));
    },
    node: (id: string) => view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!,
  };
}

/** Host props as a host that rebuilds its callbacks on every edit passes them. */
function freshCallbacks() {
  return {
    contextMenuItemsForNode: () => [],
    contextMenuItemsForPin: () => [],
    onNavigateRequest: vi.fn(),
    onNodeRenameCommit: vi.fn(),
    onNodeRenameCancel: vi.fn(),
  };
}

describe("GraphEditor node state", () => {
  it("renders no node again when a host passes new callbacks, and calls the newest one", () => {
    const canvas = renderCounted();
    canvas.update(freshCallbacks());
    const latest = freshCallbacks();
    expect(canvas.update(latest)).toEqual({ a: 0, b: 0, c: 0, m: 0 });
    const diagnostics: GraphDiagnostic[] = [{ nodeId: "b", severity: "error", message: "Broken" }];
    canvas.update({ ...latest, diagnostics });
    fireEvent.click(canvas.node("b").querySelector("button[aria-label=\"1 Error\"]")!);
    expect(latest.onNavigateRequest).toHaveBeenCalledWith({ nodeId: "b" });
  });

  it("renders only the nodes whose diagnostics, pending pin, rename or preview changed", () => {
    const canvas = renderCounted();
    const host = freshCallbacks();
    canvas.update(host);

    const diagnostics: GraphDiagnostic[] = [
      { nodeId: "b", severity: "error", message: "Broken" },
      { nodeId: "b", pinId: "in", severity: "error", message: "Bad input" },
    ];
    expect(canvas.update({ ...host, diagnostics })).toEqual({ a: 0, b: 1, c: 0, m: 0 });
    expect(canvas.node("b").textContent).toContain("2 Errors");
    expect(canvas.node("b").querySelector('[data-handleid="in"][data-error="true"]')).not.toBeNull();
    expect(canvas.node("b").querySelector('[data-handleid="out"][data-error="true"]')).toBeNull();
    // A new diagnostics list with the same errors renders nothing.
    expect(canvas.update({ ...host, diagnostics: [...diagnostics] })).toEqual({ a: 0, b: 0, c: 0, m: 0 });

    expect(canvas.update({ ...host, diagnostics, renamingNodeId: "c", renamingNodeValue: "Renamed" })).toEqual({ a: 0, b: 0, c: 1, m: 0 });
    expect(canvas.node("c").querySelector<HTMLInputElement>("[data-testid=\"graph-node-rename\"] input, input[data-testid=\"graph-node-rename\"]")?.value).toBe("Renamed");

    expect(canvas.update({ ...host, diagnostics, previewedNode: { nodeId: "a", label: "Previewed" } })).toEqual({ a: 1, b: 0, c: 1, m: 0 });
    expect(canvas.node("a").querySelector('[data-testid="graph-node-preview-tag"]')?.textContent).toContain("Previewed");
    expect(canvas.node("c").querySelector<HTMLInputElement>("[data-testid=\"graph-node-rename\"] input, input[data-testid=\"graph-node-rename\"]")).toBeNull();
    expect(canvas.update({ ...host })).toEqual({ a: 1, b: 1, c: 0, m: 0 });
    expect(canvas.node("b").textContent).not.toContain("Error");
  });

  it("marks the pin chosen to connect on its node alone", () => {
    const canvas = renderCounted();
    const before = new Map(canvas.commits);
    act(() => { fireEvent.click(canvas.node("a").querySelector('[data-handleid="out"]')!); });
    expect(canvas.node("a").querySelector('[data-handleid="out"]')?.className).toContain("ring-2");
    expect((canvas.commits.get("b") ?? 0) - (before.get("b") ?? 0)).toBe(0);
    expect((canvas.commits.get("c") ?? 0) - (before.get("c") ?? 0)).toBe(0);
  });

  it("renders only a Math Expression node while its formula is typed, and commits through the newest onChange", () => {
    const canvas = renderCounted();
    canvas.update({ ...freshCallbacks(), onChange: vi.fn() });
    const onChange = vi.fn();
    expect(canvas.update({ ...freshCallbacks(), onChange })).toEqual({ a: 0, b: 0, c: 0, m: 0 });

    const before = new Map(canvas.commits);
    const since = () => Object.fromEntries(NODE_IDS.map((id) => [id, (canvas.commits.get(id) ?? 0) - (before.get(id) ?? 0)]));
    fireEvent.doubleClick(canvas.node("m").querySelector('[data-testid="math-expression-formula"]')!);
    const field = canvas.node("m").querySelector<HTMLTextAreaElement>('[data-testid="math-expression-formula-input"]')!;
    expect(field.value).toBe("y = a * k");
    expect(since()).toMatchObject({ a: 0, b: 0, c: 0 });
    fireEvent.change(field, { target: { value: "y = a * b" } });
    act(() => { fireEvent.blur(field); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const formulaNode = onChange.mock.calls[0]![0].nodes.find((node: { id: string }) => node.id === "m");
    expect(formulaNode.data.formula).toBe("y = a * b");
    expect(since()).toMatchObject({ a: 0, b: 0, c: 0 });
    expect(since().m).toBeGreaterThan(0);
  });

  it("shows the body the newest node body renderer draws", () => {
    const canvas = renderCounted();
    canvas.update({ renderNodeBody: (nodeId) => <span data-testid={`body-${nodeId}`}>first</span> });
    expect(canvas.getByTestId("body-a").textContent).toBe("first");
    canvas.update({ renderNodeBody: (nodeId) => <span data-testid={`body-${nodeId}`}>second</span> });
    expect(canvas.getByTestId("body-a").textContent).toBe("second");
  });
});
