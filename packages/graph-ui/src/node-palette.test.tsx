import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodePalette } from "./node-palette";
import type { PaletteNode, SerializedPin } from "./graph-types";

afterEach(() => {
  cleanup();
});

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

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

const stringIn: SerializedPin = {
  id: "message",
  name: "message",
  kind: "data",
  direction: "in",
  type: { kind: "string" },
};

const log: PaletteNode = {
  id: "debug.log",
  title: "Log",
  category: "Debug",
  pins: [execIn, execOut, stringIn],
};

const begin: PaletteNode = {
  id: "flow.event.beginPlay",
  title: "Event Begin Play",
  category: "Flow",
  pins: [execOut],
};

describe("NodePalette", () => {
  it("defaults the Context Sensitive switch to on", () => {
    const { getByTestId, getByText } = render(
      <NodePalette
        open
        onOpenChange={() => {}}
        paletteNodes={[log, begin]}
        onAddNode={() => {}}
      />,
    );

    const toggle = getByTestId("node-palette-context-sensitive");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(getByText("Context Sensitive")).toBeTruthy();
    expect(toggle.closest("[data-slot='field']")?.className).toMatch(
      /min-h-\[var\(--touch-target,44px\)\]|min-h-11/,
    );
  });

  it("clears search when the palette is opened again", () => {
    const props = {
      onOpenChange: vi.fn(),
      paletteNodes: [log, begin],
      onAddNode: vi.fn(),
    };
    const { getByPlaceholderText, rerender } = render(
      <NodePalette open {...props} />,
    );

    fireEvent.change(getByPlaceholderText("Search nodes"), {
      target: { value: "log" },
    });
    expect(getByPlaceholderText("Search nodes")).toHaveProperty("value", "log");

    rerender(<NodePalette open={false} {...props} />);
    rerender(<NodePalette open {...props} />);

    expect(getByPlaceholderText("Search nodes")).toHaveProperty("value", "");
  });

  it("resets the category to All when the palette is opened again", () => {
    const props = {
      onOpenChange: vi.fn(),
      paletteNodes: [log, begin],
      onAddNode: vi.fn(),
    };
    const { getByTestId, rerender } = render(
      <NodePalette open {...props} />,
    );

    fireEvent.click(getByTestId("node-palette-category-Debug"));
    expect(getByTestId("node-palette-category-Debug").className).toContain(
      "border-l-primary",
    );

    rerender(<NodePalette open={false} {...props} />);
    rerender(<NodePalette open {...props} />);

    expect(getByTestId("node-palette-category-all").className).toContain(
      "border-l-primary",
    );
  });

  it("lists only compatible opposite pins when Context Sensitive is on", () => {
    const { getByTestId, queryByTestId } = render(
      <NodePalette
        open
        onOpenChange={() => {}}
        paletteNodes={[log, begin]}
        onAddNode={() => {}}
        filterPin={execOut}
      />,
    );

    expect(
      getByTestId("node-palette-context-sensitive").getAttribute("aria-checked"),
    ).toBe("true");
    expect(getByTestId("node-palette-item-debug.log")).toBeTruthy();
    expect(queryByTestId("node-palette-item-flow.event.beginPlay")).toBeNull();
  });

  it("shows the full palette when Context Sensitive is turned off", () => {
    const { getByTestId } = render(
      <NodePalette
        open
        onOpenChange={() => {}}
        paletteNodes={[log, begin]}
        onAddNode={() => {}}
        filterPin={execOut}
      />,
    );

    fireEvent.click(getByTestId("node-palette-context-sensitive"));

    expect(
      getByTestId("node-palette-context-sensitive").getAttribute("aria-checked"),
    ).toBe("false");
    expect(getByTestId("node-palette-item-debug.log")).toBeTruthy();
    expect(getByTestId("node-palette-item-flow.event.beginPlay")).toBeTruthy();
  });

  it("counts categories from the search-filtered set", () => {
    const { getByPlaceholderText, getByTestId, queryByTestId } = render(
      <NodePalette
        open
        onOpenChange={() => {}}
        paletteNodes={[log, begin]}
        onAddNode={() => {}}
      />,
    );

    expect(getByTestId("node-palette-category-all").textContent).toContain("2");
    expect(getByTestId("node-palette-category-Debug").textContent).toContain("1");
    expect(getByTestId("node-palette-category-Flow").textContent).toContain("1");

    fireEvent.change(getByPlaceholderText("Search nodes"), {
      target: { value: "log" },
    });

    expect(getByTestId("node-palette-category-all").textContent).toContain("1");
    expect(getByTestId("node-palette-category-Debug").textContent).toContain("1");
    expect(queryByTestId("node-palette-category-Flow")).toBeNull();
  });

  it("keeps Context Sensitive off after close and reopen", () => {
    const props = {
      onOpenChange: vi.fn(),
      paletteNodes: [log, begin],
      onAddNode: vi.fn(),
      filterPin: execOut,
    };
    const { getByTestId, rerender } = render(
      <NodePalette open {...props} />,
    );

    fireEvent.click(getByTestId("node-palette-context-sensitive"));
    rerender(<NodePalette open={false} {...props} />);
    rerender(<NodePalette open {...props} />);

    expect(
      getByTestId("node-palette-context-sensitive").getAttribute("aria-checked"),
    ).toBe("false");
    expect(getByTestId("node-palette-item-flow.event.beginPlay")).toBeTruthy();
  });
});
