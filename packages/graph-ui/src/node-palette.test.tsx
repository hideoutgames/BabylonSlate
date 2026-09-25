import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodePalette } from "./node-palette";
import type { PaletteNode, SerializedPin } from "./graph-types";

afterEach(() => {
  cleanup();
});

if (
  typeof window !== "undefined" &&
  typeof window.PointerEvent === "undefined"
) {
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
  function paletteItems() {
    return document.querySelectorAll('[data-testid^="node-palette-item-"]');
  }

  function itemIds() {
    return [...paletteItems()].map((el) => el.getAttribute("data-testid"));
  }

  it("retains node contracts and selection when finding a node through its alias", () => {
    const onAddNode = vi.fn();
    const node = { ...log, description: "Changes only this running session.", searchAliases: ["session output"] };
    const { getByPlaceholderText, getByTestId } = render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={[node]} onAddNode={onAddNode} />,
    );
    fireEvent.change(getByPlaceholderText("Search nodes"), { target: { value: "session output" } });
    const row = getByTestId("node-palette-item-debug.log");
    expect(row.getAttribute("title")).toBe(node.description);
    expect(row.getAttribute("aria-description")).toBe(node.description);
    fireEvent.click(row);
    expect(onAddNode).toHaveBeenCalledWith(node);
  });

  it("collapses categories until expanded, and expands every match while searching", () => {
    const { getByPlaceholderText, getByTestId, queryByTestId } = render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={[log, begin]} onAddNode={() => {}} />,
    );
    const debug = getByTestId("node-palette-category-Debug");
    expect(debug.getAttribute("aria-expanded")).toBe("false");
    expect(paletteItems()).toHaveLength(0);

    fireEvent.click(debug);
    expect(getByTestId("node-palette-category-Debug").getAttribute("aria-expanded")).toBe("true");
    expect(itemIds()).toEqual(["node-palette-item-debug.log"]);

    fireEvent.change(getByPlaceholderText("Search nodes"), { target: { value: "e" } });
    expect(itemIds()).toEqual([
      "node-palette-item-debug.log",
      "node-palette-item-flow.event.beginPlay",
    ]);
    fireEvent.change(getByPlaceholderText("Search nodes"), { target: { value: "log" } });
    expect(queryByTestId("node-palette-category-Flow")).toBeNull();
    expect(getByTestId("node-palette-category-Debug").textContent).toBe("Debug1");
  });

  it("expands a lone category without a click", () => {
    render(<NodePalette open onOpenChange={() => {}} paletteNodes={[log]} onAddNode={() => {}} />);
    expect(itemIds()).toEqual(["node-palette-item-debug.log"]);
  });

  it("navigates the tree from the search field and adds the active node", () => {
    const onAddNode = vi.fn();
    const { getByPlaceholderText, getByTestId } = render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={[log, begin]} onAddNode={onAddNode} />,
    );
    const input = getByPlaceholderText("Search nodes");
    const selected = (testId: string) => getByTestId(testId).getAttribute("aria-selected");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected("node-palette-category-Flow")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected("node-palette-item-flow.event.beginPlay")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(
      getByTestId("node-palette-item-flow.event.beginPlay").id,
    );

    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(selected("node-palette-category-Flow")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(getByTestId("node-palette-category-Flow").getAttribute("aria-expanded")).toBe("false");
    expect(paletteItems()).toHaveLength(0);

    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onAddNode).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAddNode).toHaveBeenCalledWith(begin);

    onAddNode.mockClear();
    fireEvent.change(input, { target: { value: "no-such-node" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAddNode).not.toHaveBeenCalled();
  });

  it("adds the first search match on Enter without moving through rows", () => {
    const onAddNode = vi.fn();
    const { getByPlaceholderText } = render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={[log, begin]} onAddNode={onAddNode} />,
    );
    const input = getByPlaceholderText("Search nodes");
    fireEvent.change(input, { target: { value: "begin" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAddNode).toHaveBeenCalledWith(begin);
  });

  it("opens at the anchor and stays inside the viewport near its edge", () => {
    const props = { onOpenChange: () => {}, paletteNodes: [log, begin], onAddNode: () => {} };
    const { getByTestId, rerender } = render(
      <NodePalette open {...props} anchor={{ x: 100, y: 120 }} />,
    );
    const popup = () => getByTestId("node-palette");
    expect(popup().style.left).toBe("100px");
    expect(popup().style.top).toBe("120px");

    rerender(<NodePalette open {...props} anchor={{ x: window.innerWidth - 4, y: window.innerHeight - 4 }} />);
    const left = Number.parseFloat(popup().style.left);
    const top = Number.parseFloat(popup().style.top);
    expect(left + Number.parseFloat(popup().style.width)).toBeLessThanOrEqual(window.innerWidth);
    expect(top + Number.parseFloat(popup().style.height)).toBeLessThanOrEqual(window.innerHeight);
  });

  it("clears search and category expansion when the palette is opened again", () => {
    const props = { onOpenChange: vi.fn(), paletteNodes: [log, begin], onAddNode: vi.fn() };
    const { getByPlaceholderText, getByTestId, rerender } = render(<NodePalette open {...props} />);

    fireEvent.click(getByTestId("node-palette-category-Debug"));
    fireEvent.change(getByPlaceholderText("Search nodes"), { target: { value: "log" } });
    rerender(<NodePalette open={false} {...props} />);
    rerender(<NodePalette open {...props} />);

    expect(getByPlaceholderText("Search nodes")).toHaveProperty("value", "");
    expect(getByTestId("node-palette-category-Debug").getAttribute("aria-expanded")).toBe("false");
  });

  it("defaults Context Sensitive to on and lists only compatible opposite pins", () => {
    const { getByTestId, getByRole, queryByTestId } = render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={[log, begin]} onAddNode={() => {}} filterPin={execOut} />,
    );
    expect(getByTestId("node-palette-context-sensitive").getAttribute("aria-checked")).toBe("true");
    expect(getByRole("tree", { name: "Suggested Nodes" })).toBeTruthy();
    expect(itemIds()).toEqual(["node-palette-item-debug.log"]);
    expect(queryByTestId("node-palette-category-Debug")).toBeNull();
  });

  it("shows the full catalog when Context Sensitive is turned off, and keeps it off after reopening", () => {
    const props = { onOpenChange: vi.fn(), paletteNodes: [log, begin], onAddNode: vi.fn(), filterPin: execOut };
    const { getByTestId, rerender } = render(<NodePalette open {...props} />);

    fireEvent.click(getByTestId("node-palette-context-sensitive"));
    expect(getByTestId("node-palette-context-sensitive").getAttribute("aria-checked")).toBe("false");
    expect(getByTestId("node-palette-category-Debug")).toBeTruthy();
    expect(getByTestId("node-palette-category-Flow")).toBeTruthy();

    rerender(<NodePalette open={false} {...props} />);
    rerender(<NodePalette open {...props} />);
    expect(getByTestId("node-palette-context-sensitive").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(getByTestId("node-palette-category-Flow"));
    expect(getByTestId("node-palette-item-flow.event.beginPlay")).toBeTruthy();
  });

  it("finds symbol and formula aliases without confusing multiply with power", () => {
    const nodes: PaletteNode[] = [
      { id: "add", title: "Add", category: "math", pins: [], searchAliases: ["+", "a + b"] },
      { id: "multiply", title: "Multiply", category: "math", pins: [], searchAliases: ["*", "×", "a * b"] },
      { id: "power", title: "Power", category: "math", pins: [], searchAliases: ["**", "^", "pow(a, b)"] },
      { id: "sqrt", title: "Square Root", category: "math", pins: [], searchAliases: ["√", "sqrt(x)"] },
    ];
    const onAddNode = vi.fn();
    const { getByPlaceholderText, getByTestId } = render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={nodes} onAddNode={onAddNode} />,
    );
    const search = getByPlaceholderText("Search nodes");
    for (const [query, expectedId] of [
      ["+", "add"],
      ["*", "multiply"],
      ["×", "multiply"],
      ["**", "power"],
      ["√", "sqrt"],
      [" A+B ", "add"],
      [" POW ( A, B ) ", "power"],
      ["SQRT (x)", "sqrt"],
      ["square root", "sqrt"],
    ]) {
      fireEvent.change(search, { target: { value: query } });
      expect(itemIds()).toEqual([`node-palette-item-${expectedId}`]);
      expect(getByTestId("node-palette-category-math").textContent).toBe("Math1");
    }
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onAddNode).toHaveBeenCalledWith(nodes[3]);
  });

  it("keeps symbol searches inside pin-compatible results until context sensitivity is disabled", () => {
    const compatible = { ...log, searchAliases: ["+"] };
    const incompatible = { ...begin, searchAliases: ["+"] };
    const { getByPlaceholderText, getByTestId, queryByTestId } = render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={[compatible, incompatible]}
        onAddNode={() => {}} filterPin={execOut} />,
    );
    fireEvent.change(getByPlaceholderText("Search nodes"), { target: { value: "+" } });
    expect(getByTestId("node-palette-item-debug.log")).toBeTruthy();
    expect(queryByTestId("node-palette-item-flow.event.beginPlay")).toBeNull();
    fireEvent.click(getByTestId("node-palette-context-sensitive"));
    expect(getByTestId("node-palette-item-flow.event.beginPlay")).toBeTruthy();
  });

  it("shows readable category labels and sorts categories by them", () => {
    const nodes = [
      { ...log, category: "uv" },
      { ...begin, category: "math.vector" },
    ];
    const { getByTestId } = render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={nodes} onAddNode={() => {}} />,
    );
    expect(getByTestId("node-palette-category-math.vector").textContent).toBe("Math Vector1");
    expect(getByTestId("node-palette-category-uv").textContent).toBe("UV1");
    const categories = [...document.querySelectorAll('[data-testid^="node-palette-category-"]')];
    expect(categories.map((el) => el.textContent)).toEqual(["Math Vector1", "UV1"]);
    fireEvent.click(getByTestId("node-palette-category-math.vector"));
    expect(itemIds()).toEqual(["node-palette-item-flow.event.beginPlay"]);
  });

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
    } else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  it("mounts every palette item when the catalog body height is 0", () => {
    render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={manyNodes(80)} onAddNode={() => {}} />,
    );
    expect(paletteItems()).toHaveLength(80);
    expect(document.querySelector('[data-testid="node-palette-item-n79"]')).toBeTruthy();
  });

  it("mounts only viewport-near rows for a ~1000-node palette", () => {
    stubPaletteBodyHeight(440);
    const { getByTestId, queryByTestId } = render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={manyNodes(1000)} onAddNode={() => {}} />,
    );
    const mounted = paletteItems();
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(40);
    expect(queryByTestId("node-palette-item-n0")).toBeTruthy();
    expect(queryByTestId("node-palette-item-n999")).toBeNull();
    expect(getByTestId("node-palette-category-Math").textContent).toContain("1000");
  });

  it("search finds the last item without mounting the full palette", () => {
    stubPaletteBodyHeight(440);
    const { getByPlaceholderText, getByTestId, queryByTestId } = render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={manyNodes(1000)} onAddNode={() => {}} />,
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

  const boolOut: SerializedPin = {
    id: "value",
    name: "value",
    kind: "data",
    direction: "out",
    type: { kind: "bool" },
  };
  const boolIn: SerializedPin = {
    id: "condition",
    name: "condition",
    kind: "data",
    direction: "in",
    type: { kind: "bool" },
  };
  const wildcardIn: SerializedPin = {
    id: "message",
    name: "message",
    kind: "data",
    direction: "in",
    type: { kind: "boxedWildcard" },
  };
  const print: PaletteNode = {
    id: "debug.print",
    title: "Print",
    category: "Debug",
    pins: [execIn, wildcardIn],
  };
  const branch: PaletteNode = {
    id: "flow.branch",
    title: "Branch",
    category: "flow",
    pins: [execIn, boolIn],
  };
  const and: PaletteNode = {
    id: "logic.and",
    title: "AND",
    category: "logic",
    pins: [
      { id: "a", name: "A", kind: "data", direction: "in", type: { kind: "bool" } },
      { id: "b", name: "B", kind: "data", direction: "in", type: { kind: "bool" } },
    ],
  };

  it("titles the menu Add Node without a pin-type subtitle", () => {
    const { getByText, queryByText, container } = render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={[print, branch]} onAddNode={() => {}} filterPin={boolOut} />,
    );
    expect(getByText("Add Node")).toBeTruthy();
    expect(queryByText(/Compatible with/)).toBeNull();
    expect(container.querySelector('[data-slot="dialog-description"]')).toBeNull();
  });

  it("lists pin-filtered suggestions in relevance order with their category labels", () => {
    const { getByTestId } = render(
      <NodePalette open onOpenChange={() => {}} paletteNodes={[print, branch]} onAddNode={() => {}} filterPin={boolOut} />,
    );
    expect(itemIds()).toEqual([
      "node-palette-item-flow.branch",
      "node-palette-item-debug.print",
    ]);
    expect(getByTestId("node-palette-item-flow.branch").textContent).toMatch(/Flow/i);
  });

  it("ranks Branch above AND when source pins include Exec and Bool", () => {
    render(
      <NodePalette
        open
        onOpenChange={() => {}}
        paletteNodes={[print, and, branch]}
        onAddNode={() => {}}
        filterPin={boolOut}
        sourcePins={[execOut, boolOut]}
      />,
    );
    expect(itemIds()).toEqual([
      "node-palette-item-flow.branch",
      "node-palette-item-logic.and",
      "node-palette-item-debug.print",
    ]);
  });
});
