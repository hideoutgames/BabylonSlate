import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import { GraphConnectionLineView } from "./connection-line";
import type { SerializedPin } from "./graph-types";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const execOut: SerializedPin = {
  id: "execOut",
  name: "then",
  kind: "exec",
  direction: "out",
  type: { kind: "exec" },
};

const execIn: SerializedPin = {
  id: "execIn",
  name: "exec",
  kind: "exec",
  direction: "in",
  type: { kind: "exec" },
};

const stringOut: SerializedPin = {
  id: "value",
  name: "value",
  kind: "data",
  direction: "out",
  type: { kind: "string" },
};

const nodes = [
  { id: "source", data: { __pins: [execOut, stringOut] } },
  { id: "log", data: { __pins: [execIn] } },
];

function mockRect(
  el: Element,
  rect: { left: number; top: number; width: number; height: number },
) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON() {
        return {};
      },
    }),
  });
}

function mountHandles(centers: Array<{ nodeId: string; pinId: string; x: number; y: number }>) {
  for (const center of centers) {
    const handle = document.createElement("div");
    handle.className = "react-flow__handle";
    handle.dataset.nodeid = center.nodeId;
    handle.dataset.handleid = center.pinId;
    mockRect(handle, {
      left: center.x - 22,
      top: center.y - 22,
      width: 44,
      height: 44,
    });
    document.body.append(handle);
  }
}

function renderLine(
  overrides: Partial<Parameters<typeof GraphConnectionLineView>[0]> = {},
) {
  return render(
    <svg>
      <GraphConnectionLineView
        fromX={0}
        fromY={0}
        toX={200}
        toY={0}
        fromPosition={Position.Right}
        toPosition={Position.Left}
        fromNode={{ id: "source", data: { __pins: [execOut, stringOut] } }}
        fromHandle={{ id: "execOut" }}
        toHandle={null}
        pointer={{ x: 200, y: 0 }}
        nodes={nodes}
        {...overrides}
      />
    </svg>,
  );
}

describe("GraphConnectionLineView", () => {
  it("shows a Tap to Cancel hint when the drop would open the palette", () => {
    mountHandles([{ nodeId: "source", pinId: "execOut", x: 0, y: 0 }]);
    const { getByTestId, queryByRole } = renderLine();

    const hint = getByTestId("add-node-hint");
    expect(hint.textContent).toBe("Tap to Cancel");
    expect(hint.getAttribute("aria-hidden")).toBe("true");
    expect(queryByRole("button", { name: "Tap to Cancel" })).toBeNull();
    const host = hint.closest("foreignObject");
    expect(host).not.toBeNull();
    expect(Number(host?.getAttribute("width"))).toBeGreaterThanOrEqual(140);
  });

  it("shows a Tap to Cancel hint in add-node mode", () => {
    mountHandles([{ nodeId: "source", pinId: "execOut", x: 0, y: 0 }]);
    const { getByTestId, queryByRole } = renderLine({
      connectEndMode: "add-node",
    });
    const hint = getByTestId("add-node-hint");
    expect(hint.textContent).toBe("Tap to Cancel");
    expect(queryByRole("button", { name: "Tap to Cancel" })).toBeNull();
  });

  it("hides the hint near the source pin", () => {
    mountHandles([{ nodeId: "source", pinId: "execOut", x: 0, y: 0 }]);
    const { queryByTestId } = renderLine({
      toX: 40,
      pointer: { x: 40, y: 0 },
    });
    expect(queryByTestId("add-node-hint")).toBeNull();
  });

  it("hides the hint near a compatible pin", () => {
    mountHandles([
      { nodeId: "source", pinId: "execOut", x: 0, y: 0 },
      { nodeId: "log", pinId: "execIn", x: 200, y: 0 },
    ]);
    const { queryByTestId } = renderLine({
      pointer: { x: 210, y: 0 },
    });
    expect(queryByTestId("add-node-hint")).toBeNull();
  });

  it("hides the hint when snapping to a target handle", () => {
    mountHandles([{ nodeId: "source", pinId: "execOut", x: 0, y: 0 }]);
    const { queryByTestId } = renderLine({
      toHandle: { id: "execIn" },
    });
    expect(queryByTestId("add-node-hint")).toBeNull();
  });

  it("strokes the preview with the dragged pin color", () => {
    mountHandles([{ nodeId: "source", pinId: "execOut", x: 0, y: 0 }]);
    const { container } = renderLine({
      fromHandle: { id: "value" },
    });
    const path = container.querySelector(".react-flow__connection-path");
    expect(path).not.toBeNull();
    expect(path?.getAttribute("style") ?? "").toMatch(/--pin-string/);
  });
});
