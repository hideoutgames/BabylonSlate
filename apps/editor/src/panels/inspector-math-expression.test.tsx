import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import { MathExpressionDetails } from "./inspector-math-expression";
import { commitMathExpressionFormula } from "../lib/math-expression-edit";

afterEach(cleanup);

describe("Math Expression Details", () => {
  it("edits the formula in the dialog and commits it once, on Done", () => {
    const onFormula = vi.fn();
    render(<MathExpressionDetails data={{ formula: "y = a * 2" }} onFormula={onFormula} onPatch={() => {}} />);
    expect(screen.getByTestId("math-expression-formula-field").textContent).toBe("y = a * 2");
    fireEvent.click(screen.getByTestId("math-expression-formula-field"));
    const editor = screen.getByTestId("math-expression-formula-field-editor");
    fireEvent.change(editor, { target: { value: "y = a * 3" } });
    fireEvent.change(editor, { target: { value: "y = b * 3" } });
    expect(onFormula).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("math-expression-formula-field-done"));
    expect(onFormula.mock.calls).toEqual([["y = b * 3"]]);
  });

  it("shows the formula's error with its position", () => {
    render(<MathExpressionDetails data={{ formula: "y = (a", pinFormula: "y = a" }} onFormula={() => {}} onPatch={() => {}} />);
    expect(screen.getByTestId("math-expression-formula-error").textContent).toBe("Line 1, column 7: Expected ')' but found the end of the formula");
  });

  it("gives each input a type row that follows its wire (Auto) until a type is chosen", async () => {
    const onPatch = vi.fn();
    render(<MathExpressionDetails data={{ formula: "y = p * s", wiredInputTypes: { p: "vec3" }, "default:in_s": 2 }} onFormula={() => {}} onPatch={onPatch} />);
    expect(screen.getByTestId("property-math-input-type-p").textContent).toContain("Auto");
    expect(screen.getByText("Vector3")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-math-input-type-s"));
    const option = await screen.findByRole("option", { name: "Vector2" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    expect(onPatch.mock.calls).toEqual([[{ inputTypes: { s: "vec2" }, "default:in_s": undefined }]]);
  });

  it("shows no type rows for a formula without inputs", () => {
    render(<MathExpressionDetails data={{ formula: "y = pi" }} onFormula={() => {}} onPatch={() => {}} />);
    expect(screen.queryByTestId("property-math-input-type-pi")).toBeNull();
  });
});

describe("commitMathExpressionFormula", () => {
  const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
  const graph: SerializedGraph = {
    nodes: [node("src", "variables.get"), node("mx", "math.expression", { formula: "y = a + b" })],
    edges: [
      { id: "ea", source: "src", target: "mx", sourceHandle: "value", targetHandle: "in_a" },
      { id: "eb", source: "src", target: "mx", sourceHandle: "value", targetHandle: "in_b" },
    ],
  };

  it("renames the wire of a renamed input and drops the wire of a removed one in the same change", () => {
    const renamed = commitMathExpressionFormula(graph, "mx", "y = speed + b", null);
    expect(renamed.edges.map((edge) => edge.targetHandle)).toEqual(["in_speed", "in_b"]);
    const removed = commitMathExpressionFormula(graph, "mx", "y = a", null);
    expect(removed.edges.map((edge) => edge.targetHandle)).toEqual(["in_a"]);
    expect(removed.nodes[1]!.data.formula).toBe("y = a");
  });

  it("edits the open function's slice", () => {
    const withFunction: SerializedGraph = { nodes: [], edges: [], functionGraphs: { fn: { nodes: graph.nodes, edges: graph.edges } } };
    const next = commitMathExpressionFormula(withFunction, "mx", "y = b", "fn");
    expect(next.functionGraphs!.fn!.edges.map((edge) => edge.targetHandle)).toEqual(["in_b"]);
    expect(next.nodes).toEqual([]);
  });
});
