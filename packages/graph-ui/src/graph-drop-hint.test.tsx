import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";
import { GraphDropHint } from "./graph-drop-hint";

describe("GraphDropHint", () => {
  afterEach(() => {
    cleanup();
  });

  it("defaults to the graph member test id and Add Node label", () => {
    const { getByTestId } = render(
      <GraphDropHint hint={{ clientX: 10, clientY: 20, allowed: true }} />,
    );
    const hint = getByTestId("graph-member-drop-hint");
    expect(hint.textContent).toContain("+");
    expect(hint.textContent).toContain("Add Node");
  });

  it("shows +Name on an allowed outliner drop", () => {
    const { getByTestId } = render(
      <GraphDropHint
        hint={{ clientX: 10, clientY: 20, allowed: true, label: "Cube" }}
        testId="outliner-drop-hint"
      />,
    );
    const hint = getByTestId("outliner-drop-hint");
    expect(hint.getAttribute("data-allowed")).toBe("true");
    expect(hint.textContent).toContain("+");
    expect(hint.textContent).toContain("Cube");
  });

  it("shows a ban mark when the drop is not allowed", () => {
    const { getByTestId } = render(
      <GraphDropHint
        hint={{ clientX: 10, clientY: 20, allowed: false }}
        testId="outliner-drop-hint"
      />,
    );
    expect(getByTestId("outliner-drop-hint").getAttribute("data-allowed")).toBe(
      "false",
    );
    expect(getByTestId("outliner-drop-hint").textContent).toContain("Cannot Drop");
  });
});
