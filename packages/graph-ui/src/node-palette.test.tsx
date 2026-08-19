import { act, cleanup, fireEvent, render } from "@testing-library/react";
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

  function paletteItems() {
    return document.querySelectorAll('[data-testid^="node-palette-item-"]');
  }

  function manyNodes(count: number): PaletteNode[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `n${index}`,
      title: `Node ${index}`,
      category: "Math",
      pins: [],
    }));
  }

  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );

  function stubPaletteBodyHeight(height: number) {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        if (
          (this as HTMLElement).getAttribute?.("data-testid") ===
          "node-palette-body"
        ) {
          return height;
        }
        return clientHeightDescriptor?.get?.call(this) ?? 0;
      },
    });
  }

  afterEach(() => {
    if (clientHeightDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientHeight",
        clientHeightDescriptor,
      );
    }
  });

  it("mounts every palette item when the catalog body height is 0", () => {
    const nodes = manyNodes(80);
    render(
      <NodePalette
        open
        onOpenChange={() => {}}
        paletteNodes={nodes}
        onAddNode={() => {}}
      />,
    );
    expect(paletteItems()).toHaveLength(80);
    expect(document.querySelector('[data-testid="node-palette-item-n79"]')).toBeTruthy();
  });

  it("mounts only viewport-near rows for a ~1000-node palette", () => {
    stubPaletteBodyHeight(440);
    const nodes = manyNodes(1000);
    const { queryByTestId } = render(
      <NodePalette
        open
        onOpenChange={() => {}}
        paletteNodes={nodes}
        onAddNode={() => {}}
      />,
    );
    const mounted = paletteItems();
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(40);
    expect(queryByTestId("node-palette-item-n0")).toBeTruthy();
    expect(queryByTestId("node-palette-item-n999")).toBeNull();
    expect(
      document.querySelector('[data-testid="node-palette-category-all"]')
        ?.textContent,
    ).toContain("1000");
  });

  it("search finds the last item without mounting the full palette", () => {
    stubPaletteBodyHeight(440);
    const nodes = manyNodes(1000);
    const { getByPlaceholderText, getByTestId, queryByTestId } = render(
      <NodePalette
        open
        onOpenChange={() => {}}
        paletteNodes={nodes}
        onAddNode={() => {}}
      />,
    );

    act(() => {
      fireEvent.change(getByPlaceholderText("Search nodes"), {
        target: { value: "Node 999" },
      });
    });

    expect(getByTestId("node-palette-item-n999")).toBeTruthy();
    expect(queryByTestId("node-palette-item-n0")).toBeNull();
    expect(paletteItems()).toHaveLength(1);
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
