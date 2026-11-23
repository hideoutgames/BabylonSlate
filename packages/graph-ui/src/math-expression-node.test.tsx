import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mathExpressionPins } from "@haptic/scripting";
import { GraphEditor, type GraphEditorProps } from "./graph-editor";
import type { GraphDocument } from "./graph-types";

afterEach(cleanup);

function mathNode(id: string, data: Record<string, unknown>) {
  return { id, type: "math.expression", position: { x: 0, y: 0 }, data: { __nodeType: "math.expression", ...data, __pins: mathExpressionPins(data) } };
}

const graph: GraphDocument = {
  nodes: [
    mathNode("mx", { formula: "y = a * k" }),
    { id: "src", type: "pinNode", position: { x: -400, y: 0 }, data: { title: "Source", __pins: [{ id: "out", name: "Out", kind: "data", direction: "out", type: { kind: "float" } }] } },
  ],
  edges: [{ id: "w", source: "src", target: "mx", sourceHandle: "out", targetHandle: "in_a" }],
};

function renderGraph(props: Partial<GraphEditorProps> = {}, initialGraph = graph) {
  return render(<GraphEditor initialGraph={initialGraph} sessionViewport={{ x: 0, y: 0, zoom: 1 }} {...props} />);
}

const card = (container: HTMLElement) => container.querySelector('[data-testid="math-expression-mx"]') as HTMLElement;

describe("Math Expression node", () => {
  it("draws its formula and its variables as ordinary pins, inputs left and outputs right, named as typed", () => {
    const { container, getByTestId } = renderGraph();
    expect(getByTestId("math-expression-formula").textContent).toBe("y = a * k");
    const inputs = [...card(container).querySelectorAll('[data-pin-side="in"]')].map((cell) => cell.getAttribute("data-pin-id"));
    const outputs = [...card(container).querySelectorAll('[data-pin-side="out"]')].map((cell) => cell.getAttribute("data-pin-id"));
    expect(inputs).toEqual(["in_a", "in_k"]);
    expect(outputs).toEqual(["out_y"]);
    expect(card(container).querySelector('[data-pin-label="k"]')?.textContent).toBe("k");
    // The unwired input has its inline value field; the wired one does not.
    expect(card(container).querySelector('[data-pin-id="in_k"] input')).not.toBeNull();
    expect(card(container).querySelector('[data-pin-id="in_a"] input')).toBeNull();
  });

  it("types the formula in place on double-click and commits the rename, its wire and the pins as one change", async () => {
    const onChange = vi.fn();
    const { container, getByTestId } = renderGraph({ onChange });
    fireEvent.doubleClick(getByTestId("math-expression-formula"));
    const field = await waitFor(() => getByTestId("math-expression-formula-input") as HTMLTextAreaElement);
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "y = speed * k" } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as GraphDocument;
    expect(next.edges.map((edge) => edge.targetHandle)).toEqual(["in_speed"]);
    expect(next.nodes.find((node) => node.id === "mx")!.data.formula).toBe("y = speed * k");
    await waitFor(() => expect(card(container).querySelector('[data-pin-id="in_speed"]')).not.toBeNull());
  });

  it("commits on blur, keeps Enter for a new line, and Escape cancels", async () => {
    const onChange = vi.fn();
    const { getByTestId, queryByTestId } = renderGraph({ onChange });
    fireEvent.doubleClick(getByTestId("math-expression-formula"));
    let field = await waitFor(() => getByTestId("math-expression-formula-input") as HTMLTextAreaElement);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(queryByTestId("math-expression-formula-input")).not.toBeNull();
    fireEvent.change(field, { target: { value: "y = a" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(queryByTestId("math-expression-formula-input")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.doubleClick(getByTestId("math-expression-formula"));
    field = await waitFor(() => getByTestId("math-expression-formula-input") as HTMLTextAreaElement);
    fireEvent.change(field, { target: { value: "y = a * 2" } });
    act(() => field.blur());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("starts typing on a second tap within the double-tap time", async () => {
    const { getByTestId } = renderGraph();
    const formula = getByTestId("math-expression-formula");
    fireEvent.pointerUp(formula, { pointerType: "touch" });
    fireEvent.pointerUp(formula, { pointerType: "touch" });
    await waitFor(() => expect(getByTestId("math-expression-formula-input")).toBeTruthy());
  });

  it("starts typing with Enter on the selected node", async () => {
    const { container, getByTestId, queryByTestId } = renderGraph();
    const wrapper = container.querySelector('.react-flow__node[data-id="mx"]') as HTMLElement;
    // Not selected yet: Enter does nothing.
    fireEvent.keyDown(wrapper, { key: "Enter" });
    expect(queryByTestId("math-expression-formula-input")).toBeNull();
    fireEvent.click(card(container));
    await waitFor(() => expect(wrapper.classList.contains("selected")).toBe(true));
    fireEvent.keyDown(wrapper, { key: "Enter" });
    await waitFor(() => expect(getByTestId("math-expression-formula-input")).toBeTruthy());
  });

  it("has a normal node's outline at rest and when selected", async () => {
    const { container } = renderGraph();
    const outline = ["border", "border-border", "shadow-sm", "rounded-lg"];
    const selection = ["ring-2", "ring-primary"];
    const shell = () => container.querySelector('.react-flow__node[data-id="src"] [data-node-role]') as HTMLElement;
    const has = (element: HTMLElement, classes: string[]) => classes.every((name) => element.classList.contains(name));
    expect(has(shell(), outline) && has(card(container), outline)).toBe(true);
    expect(has(card(container), selection)).toBe(false);
    fireEvent.click(card(container));
    await waitFor(() => expect(has(card(container), selection)).toBe(true));
    expect(card(container).classList.contains("anim-state-node-selected")).toBe(false);
    fireEvent.click(shell());
    await waitFor(() => expect(has(shell(), selection)).toBe(true));
    expect(has(card(container), selection)).toBe(false);
  });

  it("shows a formula error with its position and keeps the last formula's pins", () => {
    const { container, getByTestId } = renderGraph({}, { nodes: [mathNode("mx", { formula: "y = a +", pinFormula: "y = a + b" })], edges: [] });
    expect(getByTestId("math-expression-error").textContent).toBe("Line 1, column 8: Expected a number, a name or '(' but found the end of the formula");
    expect(card(container).querySelectorAll('[data-pin-side="in"]')).toHaveLength(2);
  });

  it("does not type in a read-only graph", () => {
    const { getByTestId, queryByTestId } = renderGraph({ readOnly: true });
    fireEvent.doubleClick(getByTestId("math-expression-formula"));
    expect(queryByTestId("math-expression-formula-input")).toBeNull();
  });
});
