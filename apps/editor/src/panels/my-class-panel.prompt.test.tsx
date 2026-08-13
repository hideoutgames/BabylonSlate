import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { MyClassPanel } from "./my-class-panel";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
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
        content: { nodes: [], edges: [], members: [] },
        layout: null,
        dirty: false,
      },
    ],
    applyGraphChange,
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
  it("adds a function through NamePromptDialog instead of window.prompt", () => {
    const prompt = vi.spyOn(window, "prompt");
    render(<MyClassPanel {...({} as IDockviewPanelProps)} />);
    fireEvent.click(screen.getByTestId("class-add-functions"));
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("name-prompt-input"), {
      target: { value: "Dash" },
    });
    fireEvent.click(screen.getByTestId("name-prompt-confirm"));
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
});
