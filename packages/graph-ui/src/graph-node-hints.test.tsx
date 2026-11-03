import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { TooltipProvider } from "@haptic/ui/components/tooltip";
import { GraphEditor } from "./graph-editor";
import type { GraphDocument, SerializedPin } from "./graph-types";

afterEach(() => cleanup());

const pins: SerializedPin[] = [
  { id: "execIn", name: "exec", kind: "exec", direction: "in", type: { kind: "exec" } },
  { id: "message", name: "Message", kind: "data", direction: "in", type: { kind: "string" }, description: "Text written to the Output Log." },
  { id: "severity", name: "Severity", kind: "data", direction: "in", type: { kind: "string" } },
  { id: "execOut", name: "then", kind: "exec", direction: "out", type: { kind: "exec" } },
];

function graph(): GraphDocument {
  return {
    nodes: [
      { id: "log", type: "debug.log", position: { x: 0, y: 0 }, data: { title: "Log", __nodeType: "debug.log", __pins: pins } },
      { id: "other", type: "flow.branch", position: { x: 400, y: 0 }, data: { title: "Branch", __nodeType: "flow.branch", __pins: pins.slice(0, 1) } },
    ],
    edges: [],
  };
}

const describeNode = (nodeType: string) => (nodeType === "debug.log" ? "Writes a message to the Output Log." : undefined);
const openTip = () => document.querySelector('[data-slot="tooltip-content"][data-open]');

function tap(element: Element) {
  fireEvent.pointerDown(element, { pointerType: "touch" });
  fireEvent.click(element);
}

describe("graph node and pin tooltips", () => {
  it("explain a node from its title and a pin from its name, only where the host has a description", () => {
    const { container } = render(
      <TooltipProvider>
        <GraphEditor initialGraph={graph()} describeNode={describeNode} />
      </TooltipProvider>,
    );
    const title = container.querySelector('[data-id="log"] [data-node-title-hint]')!;
    expect(title.closest("[data-label-hint]")).toBeTruthy();
    // A node title carries no underline; its tooltip is expected.
    expect(title.closest("[data-label-hint]")!.className).not.toContain("decoration-dotted");
    tap(title);
    expect(openTip()?.textContent).toBe("Writes a message to the Output Log.");
    tap(title);
    expect(openTip()).toBeNull();

    // A node without a description keeps a plain title.
    expect(container.querySelector('[data-id="other"] [data-node-title-hint]')).toBeNull();

    const message = container.querySelector('[data-id="log"] [data-pin-label="Message"]')!;
    expect(message.closest("[data-label-hint]")).toBeTruthy();
    tap(message);
    expect(openTip()?.textContent).toBe("Text written to the Output Log.");
    expect(container.querySelector('[data-id="log"] [data-pin-label="Severity"]')!.closest("[data-label-hint]")).toBeNull();
  });
});
