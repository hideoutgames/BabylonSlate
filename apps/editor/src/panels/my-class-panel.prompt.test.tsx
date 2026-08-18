import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { MyClassPanel } from "./my-class-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointerup",
  init: { clientX: number; clientY: number },
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

const applyGraphChange = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "graph:assets/Hero.class.babasset",
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "graph:assets/Hero.class.babasset",
        ref: {
          kind: "graph",
          path: "assets/Hero.class.babasset",
          label: "Hero Class",
        },
        content: {
          nodes: [],
          edges: [],
          members: [
            { id: "fn-1", kind: "function", name: "Jump", pins: [] },
            { id: "var-1", kind: "variable", name: "Health", typeId: "float" },
            { id: "if-1", kind: "interface", name: "Damageable" },
          ],
          functionGraphs: { "fn-1": { nodes: [], edges: [] } },
        },
        layout: null,
        dirty: false,
      },
    ],
    applyGraphChange,
    assetRegistry: { list: () => [] },
  }),
}));

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({ setFocusDiagnostic: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
});

describe("MyClassPanel name prompt", () => {
  it("adds a function through AddFunctionDialog instead of window.prompt", () => {
    const prompt = vi.spyOn(window, "prompt");
    render(
      <GraphEditingProvider>
        <MyClassPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>,
    );
    expect(screen.queryByTestId("class-add-member")).toBeNull();
    expect(screen.queryByTestId("class-remove-member")).toBeNull();
    fireEvent.click(screen.getByTestId("class-add-functions"));
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("add-function-name"), {
      target: { value: "Dash" },
    });
    fireEvent.click(screen.getByTestId("add-function-confirm"));
    expect(applyGraphChange).toHaveBeenCalledWith(
      "graph:assets/Hero.class.babasset",
      expect.objectContaining({
        members: expect.arrayContaining([
          expect.objectContaining({ kind: "function", name: "Dash" }),
        ]),
      }),
    );
    prompt.mockRestore();
  });

  it("adds an event through Add Event dialog instead of window.prompt", () => {
    const prompt = vi.spyOn(window, "prompt");
    render(
      <GraphEditingProvider>
        <MyClassPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("class-add-events"));
    expect(prompt).not.toHaveBeenCalled();
    expect(screen.getByTestId("add-event-dialog")).toBeTruthy();
    fireEvent.change(screen.getByTestId("add-event-name"), {
      target: { value: "On Hit" },
    });
    fireEvent.click(screen.getByTestId("add-event-confirm"));
    expect(applyGraphChange).toHaveBeenCalledWith(
      "graph:assets/Hero.class.babasset",
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            type: "flow.event.custom",
            data: expect.objectContaining({ name: "On Hit" }),
          }),
        ]),
      }),
    );
    prompt.mockRestore();
  });

  it("hides Local Variables on the event graph and shows them on a function graph", () => {
    const { rerender } = render(
      <GraphEditingProvider key="event">
        <MyClassPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>,
    );
    expect(screen.queryByTestId("class-add-local-variables")).toBeNull();
    rerender(
      <GraphEditingProvider key="fn" initialActiveFunctionId="fn-1">
        <MyClassPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>,
    );
    expect(screen.getByTestId("class-add-local-variables")).toBeTruthy();
  });

  it("adds a local variable with the open function id", () => {
    render(
      <GraphEditingProvider initialActiveFunctionId="fn-1">
        <MyClassPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("class-add-local-variables"));
    fireEvent.change(screen.getByTestId("name-prompt-input"), {
      target: { value: "Temp" },
    });
    fireEvent.click(screen.getByTestId("name-prompt-confirm"));
    expect(applyGraphChange).toHaveBeenCalledWith(
      "graph:assets/Hero.class.babasset",
      expect.objectContaining({
        members: expect.arrayContaining([
          expect.objectContaining({
            kind: "variable",
            name: "Temp",
            functionId: "fn-1",
          }),
        ]),
      }),
    );
  });

  it("keeps the function graph open when selecting a class variable", () => {
    render(
      <GraphEditingProvider initialActiveFunctionId="fn-1">
        <MyClassPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>,
    );
    expect(screen.getByTestId("class-add-local-variables")).toBeTruthy();
    const row = screen.getByTestId("tree-row-var-1");
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 10 });
    dispatchPointerEvent(row, "pointerup", { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("class-add-local-variables")).toBeTruthy();
  });

  it("keeps the function graph open when selecting an interface", () => {
    render(
      <GraphEditingProvider initialActiveFunctionId="fn-1">
        <MyClassPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>,
    );
    expect(screen.getByTestId("class-add-local-variables")).toBeTruthy();
    const row = screen.getByTestId("tree-row-if-1");
    dispatchPointerEvent(row, "pointerdown", { clientX: 10, clientY: 10 });
    dispatchPointerEvent(row, "pointerup", { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("class-add-local-variables")).toBeTruthy();
  });
});
