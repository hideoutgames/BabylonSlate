import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphEditor, type GraphEditorProps } from "./graph-editor";
import type { GraphDocument, PaletteNode, SerializedPin } from "./graph-types";
import { GraphInteractionSettingsContext, type GraphInteractionSettings } from "./graph-interaction-settings";

afterEach(() => {
  cleanup();
});

/** Nodes measure 180 × 80, so React Flow mounts their handles and draws wires; jsdom has no layout. */
function stubMeasuredGraphLayout(): () => void {
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 180 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 80 });
  class ImmediateResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback(
        [{ target, contentRect: { x: 0, y: 0, width: 180, height: 80, top: 0, left: 0, bottom: 80, right: 180 } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  const observer = globalThis.ResizeObserver;
  globalThis.ResizeObserver = ImmediateResizeObserver as unknown as typeof ResizeObserver;
  return () => {
    if (width) Object.defineProperty(HTMLElement.prototype, "offsetWidth", width);
    if (height) Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
    globalThis.ResizeObserver = observer;
  };
}

const wildcard = { kind: "resolvingWildcard" };
const reroutePins: SerializedPin[] = [
  { id: "in", name: "In", kind: "data", direction: "in", type: wildcard, anyKind: true },
  { id: "out", name: "Out", kind: "data", direction: "out", type: wildcard, anyKind: true },
];
const reroutePalette: PaletteNode = {
  id: "flow.reroute",
  title: "Reroute",
  category: "flow",
  pure: true,
  pins: reroutePins,
  defaultData: { __reroute: true },
};
const reroute = { paletteNode: reroutePalette };

const makePins: SerializedPin[] = [
  { id: "then", name: "Then", kind: "exec", direction: "out", type: { kind: "exec" } },
  { id: "value", name: "Value", kind: "data", direction: "out", type: { kind: "float" } },
];
const logPins: SerializedPin[] = [
  { id: "exec", name: "Exec", kind: "exec", direction: "in", type: { kind: "exec" } },
  { id: "message", name: "Message", kind: "data", direction: "in", type: { kind: "float" } },
];
const posePins = {
  out: [{ id: "pose", name: "Pose", kind: "data", direction: "out", type: { kind: "pose" } }] satisfies SerializedPin[],
  in: [{ id: "pose", name: "Pose", kind: "data", direction: "in", type: { kind: "pose" } }] satisfies SerializedPin[],
};

const EXEC_WIRE = "e:make:then:log:exec";
const DATA_WIRE = "e:make:value:log:message";
const POSE_WIRE = "e:player:pose:output:pose";

function wire(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return { id: `e:${source}:${sourceHandle}:${target}:${targetHandle}`, source, sourceHandle, target, targetHandle };
}

/** Make --exec--> Log, Make.Value --> Log.Message, and a Pose wire between two animation nodes. */
function wiredGraph(): GraphDocument {
  return {
    nodes: [
      { id: "make", type: "math.make", position: { x: 0, y: 0 }, data: { title: "Make", __pins: makePins } },
      { id: "log", type: "debug.log", position: { x: 600, y: 0 }, data: { title: "Log", __pins: logPins } },
      { id: "player", type: "anim.pose.player", position: { x: 0, y: 400 }, data: { title: "Player", __pins: posePins.out } },
      { id: "output", type: "anim.pose.blend", position: { x: 600, y: 400 }, data: { title: "Blend", __pins: posePins.in } },
    ],
    edges: [
      wire("make", "then", "log", "exec"),
      wire("make", "value", "log", "message"),
      wire("player", "pose", "output", "pose"),
    ],
  };
}

/** Make.Value --> knot-a --> knot-b --> Log.Message, and Make.Then --> knot-x --> Log.Exec. */
function knotChainGraph(): GraphDocument {
  const knot = (id: string, x: number) => ({
    id,
    type: "flow.reroute",
    position: { x, y: 0 },
    data: { __reroute: true, __pure: true, __pins: reroutePins },
  });
  return {
    nodes: [
      { id: "make", type: "math.make", position: { x: 0, y: 0 }, data: { title: "Make", __pins: makePins } },
      knot("knot-a", 250),
      knot("knot-b", 350),
      knot("knot-x", 300),
      { id: "log", type: "debug.log", position: { x: 600, y: 0 }, data: { title: "Log", __pins: logPins } },
    ],
    edges: [
      wire("make", "value", "knot-a", "in"),
      wire("knot-a", "out", "knot-b", "in"),
      wire("knot-b", "out", "log", "message"),
      wire("make", "then", "knot-x", "in"),
      wire("knot-x", "out", "log", "exec"),
    ],
  };
}

function renderGraph(props: Partial<GraphEditorProps> & { initialGraph: GraphDocument }, settings?: Partial<GraphInteractionSettings>) {
  const ui: ReactElement = <GraphEditor sessionViewport={{ x: 0, y: 0, zoom: 1 }} {...props} />;
  return render(
    <GraphInteractionSettingsContext.Provider
      value={{ assistantEnabled: true, assistantDistance: 48, shakeEnabled: true, ...settings }}
    >
      {ui}
    </GraphInteractionSettingsContext.Provider>,
  );
}

async function findWire(container: HTMLElement, id: string): Promise<Element> {
  return waitFor(() => {
    const found = container.querySelector(`.react-flow__edge[data-id="${id}"]`);
    expect(found).not.toBeNull();
    return found!;
  });
}

function lastGraph(onChange: ReturnType<typeof vi.fn>): GraphDocument {
  return onChange.mock.calls.at(-1)?.[0] as GraphDocument;
}

function edgeEnds(graph: GraphDocument): string[] {
  return graph.edges.map((edge) => `${edge.source}.${edge.sourceHandle}>${edge.target}.${edge.targetHandle}`).sort();
}

describe("Reroute insertion", () => {
  it("splits a data wire double-clicked, centring the selected knot on the pointer, as one change", async () => {
    const restore = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const onEdgeDoubleClick = vi.fn();
      const { container } = renderGraph({ initialGraph: wiredGraph(), reroute, onChange, onEdgeDoubleClick });
      fireEvent.doubleClick(await findWire(container, DATA_WIRE), { clientX: 300, clientY: 200 });

      expect(onChange).toHaveBeenCalledTimes(1);
      const graph = lastGraph(onChange);
      const knot = graph.nodes.find((node) => node.type === "flow.reroute")!;
      expect(knot.position).toEqual({ x: 265, y: 185 });
      expect(knot.data).toMatchObject({ __reroute: true, __pins: reroutePins });
      expect(edgeEnds(graph)).toEqual([
        `${knot.id}.out>log.message`,
        "make.then>log.exec",
        `make.value>${knot.id}.in`,
        "player.pose>output.pose",
      ]);
      expect(onEdgeDoubleClick).not.toHaveBeenCalled();
      await waitFor(() => {
        const element = container.querySelector(`.react-flow__node[data-id="${knot.id}"]`);
        expect(element?.classList.contains("selected")).toBe(true);
        expect(element?.querySelector('[aria-label="Reroute"]')).not.toBeNull();
      });
      const selected = Array.from(container.querySelectorAll(".react-flow__node.selected")).map((element) => element.getAttribute("data-id"));
      expect(selected).toEqual([knot.id]);
    } finally {
      restore();
    }
  });

  it("splits an exec wire tapped twice within the double-tap time, once", async () => {
    const restore = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const { container } = renderGraph({ initialGraph: wiredGraph(), reroute, onChange });
      const execWire = await findWire(container, EXEC_WIRE);
      fireEvent.click(execWire, { clientX: 300, clientY: 40 });
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.click(execWire, { clientX: 300, clientY: 40 });
      fireEvent.doubleClick(execWire, { clientX: 300, clientY: 40 });

      expect(onChange).toHaveBeenCalledTimes(1);
      const graph = lastGraph(onChange);
      const knots = graph.nodes.filter((node) => node.type === "flow.reroute");
      expect(knots).toHaveLength(1);
      expect(edgeEnds(graph)).toContain(`make.then>${knots[0]!.id}.in`);
      expect(edgeEnds(graph)).toContain(`${knots[0]!.id}.out>log.exec`);
    } finally {
      restore();
    }
  });

  it("still selects a wire on a single click, adding nothing", async () => {
    const restore = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const onEdgeSelectionChange = vi.fn();
      const { container } = renderGraph({ initialGraph: wiredGraph(), reroute, onChange, onEdgeSelectionChange });
      fireEvent.click(await findWire(container, DATA_WIRE), { clientX: 300, clientY: 200 });
      await waitFor(() => expect(onEdgeSelectionChange).toHaveBeenLastCalledWith([DATA_WIRE]));
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("leaves a Pose wire whole and lets the host handle its double-click", async () => {
    const restore = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const onEdgeDoubleClick = vi.fn();
      const { container } = renderGraph({ initialGraph: wiredGraph(), reroute, onChange, onEdgeDoubleClick });
      fireEvent.doubleClick(await findWire(container, POSE_WIRE), { clientX: 300, clientY: 400 });
      expect(onChange).not.toHaveBeenCalled();
      expect(onEdgeDoubleClick).toHaveBeenCalledWith(POSE_WIRE, { x: 300, y: 400 });
    } finally {
      restore();
    }
  });

  it("only reports the double-click without a reroute row, and splits nothing when read-only", async () => {
    const restore = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const onEdgeDoubleClick = vi.fn();
      const first = renderGraph({ initialGraph: wiredGraph(), onChange, onEdgeDoubleClick });
      fireEvent.doubleClick(await findWire(first.container, DATA_WIRE), { clientX: 300, clientY: 200 });
      expect(onEdgeDoubleClick).toHaveBeenCalledWith(DATA_WIRE, { x: 300, y: 200 });
      first.unmount();

      const second = renderGraph({ initialGraph: wiredGraph(), reroute, onChange, readOnly: true });
      fireEvent.doubleClick(await findWire(second.container, DATA_WIRE), { clientX: 300, clientY: 200 });
      expect(onChange).not.toHaveBeenCalled();
      expect(second.container.querySelector('[aria-label="Reroute"]')).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("Reroute knot", () => {
  it("draws its pins and outgoing wire in the type that reaches it through other knots", async () => {
    const restore = stubMeasuredGraphLayout();
    try {
      const { container } = renderGraph({ initialGraph: knotChainGraph() });
      const knotB = await waitFor(() => {
        const found = container.querySelector('.react-flow__node[data-id="knot-b"] [aria-label="Reroute"]');
        expect(found).not.toBeNull();
        return found!;
      });
      expect(knotB.querySelector('.react-flow__handle[data-handleid="in"]')?.getAttribute("data-handlepos")).toBe("left");
      expect(knotB.querySelector('.react-flow__handle[data-handleid="out"]')?.getAttribute("data-handlepos")).toBe("right");
      const outGlyph = knotB.querySelector('.react-flow__handle[data-handleid="out"] [data-pin-shape]') as HTMLElement;
      expect(outGlyph.getAttribute("style")).toMatch(/color: var\(--pin-float\)/);

      // The exec knot draws exec diamonds, and its outgoing wire the exec stroke and width.
      const knotX = container.querySelector('.react-flow__node[data-id="knot-x"]')!;
      expect(knotX.querySelector('.react-flow__handle[data-handleid="out"] [data-pin-shape]')?.getAttribute("data-pin-shape")).toBe("diamond");
      const execPath = (await findWire(container, "e:knot-x:out:log:exec")).querySelector(".react-flow__edge-path") as SVGPathElement;
      expect(execPath.style.stroke).toBe("var(--pin-exec)");
      expect(execPath.style.strokeWidth).toBe("var(--graph-wire-exec, 5px)");
    } finally {
      restore();
    }
  });
});

describe("Cut Links", () => {
  function toggle(getByTestId: (id: string) => HTMLElement) {
    fireEvent.click(getByTestId("graph-cut-links"));
  }

  it("turns on and off from the toolbar, marking the canvas", () => {
    const { getByTestId } = renderGraph({ initialGraph: wiredGraph() });
    const button = getByTestId("graph-cut-links");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(getByTestId("graph-editor").getAttribute("data-graph-tool")).toBeNull();
    toggle(getByTestId);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(getByTestId("graph-editor").getAttribute("data-graph-tool")).toBe("cut");
    toggle(getByTestId);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("removes only the clicked wire, without selecting it", async () => {
    const restore = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const onEdgeSelectionChange = vi.fn();
      const { container, getByTestId } = renderGraph({ initialGraph: wiredGraph(), onChange, onEdgeSelectionChange });
      const dataWire = await findWire(container, DATA_WIRE);
      toggle(getByTestId);
      fireEvent.click(dataWire);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(edgeEnds(lastGraph(onChange))).toEqual(["make.then>log.exec", "player.pose>output.pose"]);
      expect(onEdgeSelectionChange.mock.calls.every(([ids]) => (ids as string[]).length === 0)).toBe(true);
    } finally {
      restore();
    }
  });

  it("does not cut a wire a press panned across", async () => {
    const restore = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const { container, getByTestId } = renderGraph({ initialGraph: wiredGraph(), onChange });
      const dataWire = await findWire(container, DATA_WIRE);
      toggle(getByTestId);
      dataWire.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 }));
      fireEvent.click(dataWire, { clientX: 160, clientY: 100 });
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("removes every wire on a clicked pin, and deletes a clicked knot with its wires", async () => {
    const restore = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const { container, getByTestId } = renderGraph({ initialGraph: knotChainGraph(), onChange });
      await findWire(container, "e:knot-x:out:log:exec");
      toggle(getByTestId);
      fireEvent.click(container.querySelector('.react-flow__node[data-id="make"] .react-flow__handle[data-handleid="value"]')!);
      expect(edgeEnds(lastGraph(onChange))).toEqual([
        "knot-a.out>knot-b.in",
        "knot-b.out>log.message",
        "knot-x.out>log.exec",
        "make.then>knot-x.in",
      ]);

      fireEvent.click(container.querySelector('.react-flow__node[data-id="knot-x"] [aria-label="Reroute"]')!);
      const graph = lastGraph(onChange);
      expect(graph.nodes.map((node) => node.id)).toEqual(["make", "knot-a", "knot-b", "log"]);
      expect(edgeEnds(graph)).toEqual(["knot-a.out>knot-b.in", "knot-b.out>log.message"]);
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it("selects other nodes as usual while on", async () => {
    const restore = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const onSelectionChange = vi.fn();
      const { container, getByTestId } = renderGraph({ initialGraph: wiredGraph(), onChange, onSelectionChange });
      await findWire(container, DATA_WIRE);
      toggle(getByTestId);
      fireEvent.click(container.querySelector('.react-flow__node[data-id="log"]')!);
      await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith(["log"]));
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("with One Use, stays on after a click that removed nothing and turns off after a cut", async () => {
    const restore = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const graph = wiredGraph();
      graph.nodes.push({ id: "lone", type: "debug.log", position: { x: 0, y: 800 }, data: { title: "Lone", __pins: logPins } });
      const { container, getByTestId } = renderGraph({ initialGraph: graph, onChange }, { cutToolOneShot: true });
      await findWire(container, DATA_WIRE);
      toggle(getByTestId);
      fireEvent.click(container.querySelector('.react-flow__node[data-id="lone"] .react-flow__handle[data-handleid="exec"]')!);
      expect(onChange).not.toHaveBeenCalled();
      expect(getByTestId("graph-cut-links").getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(container.querySelector(`.react-flow__edge[data-id="${DATA_WIRE}"]`)!);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(getByTestId("graph-cut-links").getAttribute("aria-pressed")).toBe("false");
    } finally {
      restore();
    }
  });

  it("turns off with Escape and toggles with its key while the graph is engaged", () => {
    const { getByTestId } = renderGraph({ initialGraph: wiredGraph() });
    const editor = getByTestId("graph-editor");
    fireEvent.pointerDown(editor);
    fireEvent.keyDown(document, { key: "x", code: "KeyX", altKey: true });
    expect(editor.getAttribute("data-graph-tool")).toBe("cut");
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(editor.getAttribute("data-graph-tool")).toBeNull();
  });

  it("turns off when the canvas becomes read-only, and is hidden with hiddenToolbarActions", () => {
    const graph = wiredGraph();
    const { getByTestId, rerender } = renderGraph({ initialGraph: graph });
    toggle(getByTestId);
    rerender(
      <GraphInteractionSettingsContext.Provider value={{ assistantEnabled: true, assistantDistance: 48, shakeEnabled: true }}>
        <GraphEditor initialGraph={graph} sessionViewport={{ x: 0, y: 0, zoom: 1 }} readOnly />
      </GraphInteractionSettingsContext.Provider>,
    );
    expect(getByTestId("graph-editor").getAttribute("data-graph-tool")).toBeNull();
    cleanup();
    const hidden = renderGraph({ initialGraph: graph, hiddenToolbarActions: ["cutLinks"] });
    expect(hidden.queryByTestId("graph-cut-links")).toBeNull();
    expect(hidden.getByTestId("graph-break-links")).toBeTruthy();
  });

  it("suppresses the wire double-click that would add a knot", async () => {
    const restore = stubMeasuredGraphLayout();
    try {
      const onChange = vi.fn();
      const { container, getByTestId } = renderGraph({ initialGraph: wiredGraph(), reroute, onChange });
      const dataWire = await findWire(container, DATA_WIRE);
      toggle(getByTestId);
      act(() => {
        dataWire.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 300, clientY: 200 }));
      });
      expect(container.querySelector('[aria-label="Reroute"]')).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("node header", () => {
  it("paints a header colour override with a contrasting title colour", async () => {
    const graph: GraphDocument = {
      nodes: [
        { id: "light", type: "reroute.declaration", position: { x: 0, y: 0 }, data: { title: "Light", __headerColor: "#ffee88", __pins: logPins } },
        { id: "dark", type: "reroute.usage", position: { x: 0, y: 300 }, data: { title: "Dark", __headerColor: "rgb(20, 30, 90)", __pins: logPins } },
      ],
      edges: [],
    };
    const { container } = renderGraph({ initialGraph: graph });
    const header = (id: string) => container.querySelector(`.react-flow__node[data-id="${id}"] [data-node-title]`) as HTMLElement;
    await waitFor(() => expect(header("light")).not.toBeNull());
    expect(header("light").style.backgroundColor).toBe("rgb(255, 238, 136)");
    expect(header("light").style.color).toBe("rgb(0, 0, 0)");
    expect(header("dark").style.color).toBe("rgb(255, 255, 255)");
    expect(header("dark").querySelector('[data-node-kind="namedReroute"]')).not.toBeNull();
  });

  it("renames inline: Enter commits the new name, Escape cancels", async () => {
    const onNodeRenameCommit = vi.fn();
    const onNodeRenameCancel = vi.fn();
    const graph: GraphDocument = {
      nodes: [{ id: "named", type: "reroute.declaration", position: { x: 0, y: 0 }, data: { title: "Reroute", __pins: logPins } }],
      edges: [],
    };
    const props = { initialGraph: graph, renamingNodeId: "named", onNodeRenameCommit, onNodeRenameCancel };
    const first = renderGraph(props);
    const input = await waitFor(() => first.getByTestId("graph-node-rename") as HTMLInputElement);
    expect(document.activeElement).toBe(input);
    expect(input.closest(".nodrag")).not.toBeNull();
    fireEvent.change(input, { target: { value: "Albedo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNodeRenameCommit).toHaveBeenCalledWith("named", "Albedo");
    first.unmount();

    const second = renderGraph(props);
    fireEvent.keyDown(await waitFor(() => second.getByTestId("graph-node-rename")), { key: "Escape" });
    expect(onNodeRenameCancel).toHaveBeenCalledTimes(1);
    expect(onNodeRenameCommit).toHaveBeenCalledTimes(1);
  });
});

describe("rename after Add Node", () => {
  function RenamingHost({ onCommit }: { onCommit: (nodeId: string, name: string) => void }) {
    const [renaming, setRenaming] = useState<string | null>(null);
    const [graph, setGraph] = useState<GraphDocument>({ nodes: [], edges: [] });
    return (
      <GraphEditor
        initialGraph={graph}
        onChange={setGraph}
        sessionViewport={{ x: 0, y: 0, zoom: 1 }}
        paletteNodes={[{ id: "reroute.declaration", title: "Reroute", category: "Reroute", pins: logPins }]}
        onPaletteNodeAdded={(_row, nodeId) => setRenaming(nodeId)}
        renamingNodeId={renaming}
        onNodeRenameCommit={(nodeId, name) => {
          onCommit(nodeId, name);
          setRenaming(null);
        }}
        onNodeRenameCancel={() => setRenaming(null)}
      />
    );
  }

  it("focuses the new node's name with its text selected once Add Node closes", async () => {
    const onCommit = vi.fn();
    const { getByTestId, queryByTestId } = render(<RenamingHost onCommit={onCommit} />);
    fireEvent.click(getByTestId("graph-add-node"));
    fireEvent.click(await waitFor(() => getByTestId("node-palette-item-reroute.declaration")));
    await waitFor(() => expect(queryByTestId("node-palette")).toBeNull());
    const input = await waitFor(() => {
      const field = getByTestId("graph-node-rename") as HTMLInputElement;
      expect(document.activeElement).toBe(field);
      return field;
    });
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Reroute".length]);
    fireEvent.change(input, { target: { value: "Albedo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(expect.any(String), "Albedo");
  });
});
