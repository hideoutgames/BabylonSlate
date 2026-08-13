import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import { AnimGraphEditor } from "./anim-graph-editor";

afterEach(() => {
  cleanup();
});

describe("AnimGraphEditor", () => {
  it("hydrates in/out pins on state nodes", async () => {
    const { container } = render(
      <AnimGraphEditor
        payload={createDefaultAnimGraph() as unknown as Record<string, unknown>}
        onChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-handleid="in"]')).not.toBeNull();
      expect(container.querySelector('[data-handleid="out"]')).not.toBeNull();
    });
  });

  it("lists the state node in Add Node", async () => {
    const { container } = render(
      <AnimGraphEditor
        payload={createDefaultAnimGraph() as unknown as Record<string, unknown>}
        onChange={() => {}}
      />,
    );
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
});
