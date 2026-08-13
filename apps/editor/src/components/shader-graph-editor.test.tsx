import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultShaderGraph } from "@babylonslate/shader-graph";
import { ShaderGraphEditor } from "./shader-graph-editor";

afterEach(() => {
  cleanup();
});

describe("ShaderGraphEditor", () => {
  it("shows a preview canvas and hydrates catalog pins on the default graph", async () => {
    const { container } = render(
      <ShaderGraphEditor
        payload={createDefaultShaderGraph() as unknown as Record<string, unknown>}
        onChange={() => {}}
        enableLivePreview={false}
      />,
    );
    const preview = screen.getByTestId("shader-preview");
    expect(preview.getAttribute("data-compiled")).toBe("true");
    expect(preview.getAttribute("data-post-process")).toBe("false");
    await waitFor(() => {
      expect(container.querySelector('[data-handleid="uv"]')).not.toBeNull();
      expect(container.querySelector('[data-handleid="color"]')).not.toBeNull();
    });
  });

  it("lists shader catalog nodes with pins in Add Node", async () => {
    const { container } = render(
      <ShaderGraphEditor
        payload={createDefaultShaderGraph() as unknown as Record<string, unknown>}
        onChange={() => {}}
        enableLivePreview={false}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".react-flow__pane")).not.toBeNull();
    });
    const pane = container.querySelector(".react-flow__pane");
    fireEvent.click(pane!);
    fireEvent.click(pane!);
    await waitFor(() => {
      expect(screen.getByTestId("node-palette-item-math.multiply")).toBeTruthy();
      expect(screen.getByTestId("node-palette-item-input.uv")).toBeTruthy();
    });
  });
});
