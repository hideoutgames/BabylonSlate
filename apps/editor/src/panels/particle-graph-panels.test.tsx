import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { DocumentEditStack, SetAssetDocumentCommand } from "@babylonslate/edit";
import {
  PARTICLE_OUTPUT_NODE_TYPE,
  createDefaultParticleGraphDocument,
  normalizeParticleGraphDocument,
  type ParticleGraphDocument,
} from "@babylonslate/particle-graph";
import { ParticleGraphEditingProvider } from "../context/particle-graph-editing-context";
import {
  ParticleGraphCanvasPanel,
  ParticleGraphCompilerResultsPanel,
  ParticleGraphDetails,
  ParticleGraphDetailsPanel,
  ParticleGraphPreview,
} from "./particle-graph-panels";

if (typeof window !== "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    writable: true,
    value: PointerEventPolyfill,
  });
}

const DOC_ID = "particle-graph:assets/Embers.particlegraph.babasset";

const store = vi.hoisted(() => {
  let content: Record<string, unknown> = {};
  const listeners = new Set<() => void>();
  return {
    applyAssetDocumentChange: vi.fn(
      async (_id: string, next: Record<string, unknown>, _mergeKey?: string) => {
        void _mergeKey;
        content = next;
        listeners.forEach((listener) => listener());
        return true;
      },
    ),
    getSnapshot: () => content,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: (next: Record<string, unknown>) => {
      content = next;
      listeners.forEach((listener) => listener());
    },
  };
});

vi.mock("../context/play-context", () => ({ useOptionalPlay: () => null }));
vi.mock("../context/document-context", async () => {
  const { useSyncExternalStore } = await import("react");
  const assetRegistry = {
    list: () => [
      {
        header: { guid: "mat-surface", name: "Rock", type: "Material", payload: { domain: "surface" } },
        path: "assets/Rock.material.babasset",
      },
      {
        header: { guid: "mat-particle", name: "SparksMat", type: "Material", payload: { domain: "particle" } },
        path: "assets/SparksMat.material.babasset",
      },
    ],
  };
  return {
    useDocuments: () => {
      const content = useSyncExternalStore(store.subscribe, store.getSnapshot);
      return {
        openDocuments: [
          {
            id: DOC_ID,
            ref: { kind: "particle-graph", path: "assets/Embers.particlegraph.babasset" },
            content,
          },
        ],
        assetRegistry,
        registryVersion: 0,
        applyAssetDocumentChange: store.applyAssetDocumentChange,
      };
    },
  };
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  store.applyAssetDocumentChange.mockClear();
});

const panelProps = {} as IDockviewPanelProps;

/** Details over a real undo stack; `endGesture` stands in for the editor's gesture boundaries. */
function renderDetails(initial: ParticleGraphDocument, selectedNodeId: string | null = null) {
  const stack = new DocumentEditStack<Record<string, unknown>>({
    maxEntries: 50,
    maxBytes: 1_000_000,
  });
  let current = initial;
  function History() {
    const [doc, setDoc] = useState(current);
    current = doc;
    return (
      <ParticleGraphDetails
        document={normalizeParticleGraphDocument(doc)}
        selectedNodeId={selectedNodeId}
        onChange={(next, mergeKey) => {
          const before = doc as unknown as Record<string, unknown>;
          const after = next as unknown as Record<string, unknown>;
          current = stack.apply(before, new SetAssetDocumentCommand(before, after, mergeKey))
            .doc as unknown as ParticleGraphDocument;
          setDoc(current);
        }}
      />
    );
  }
  render(<History />);
  return { stack, read: () => normalizeParticleGraphDocument(current) };
}

function type(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

async function pickOption(testId: string, label: string) {
  fireEvent.click(screen.getByTestId(testId));
  const option = await screen.findByRole("option", { name: label });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

function nodeOf(doc: ParticleGraphDocument, id: string) {
  return doc.nodes.find((node) => node.id === id)!;
}

/** Create → Shape → Apply Velocity → Update Color → Update Position (unwired Position) → Emitter Output. */
function withUnwiredPosition(): ParticleGraphDocument {
  const doc = createDefaultParticleGraphDocument("Embers");
  return {
    ...doc,
    nodes: [
      ...doc.nodes,
      { id: "move", type: "update.position", position: { x: 1220, y: 0 }, properties: {} },
    ],
    edges: [
      ...doc.edges.filter((edge) => edge.targetNodeId !== "output"),
      { id: "e-color-move", sourceNodeId: "updateColor", sourcePinId: "out", targetNodeId: "move", targetPinId: "particle" },
      { id: "e-move-output", sourceNodeId: "move", sourcePinId: "out", targetNodeId: "output", targetPinId: "particle" },
    ],
  };
}

describe("ParticleGraphDetails", () => {
  it("shows the emitter settings and Emit Rate with nothing selected", () => {
    renderDetails(createDefaultParticleGraphDocument("Embers"));
    expect(screen.getByTestId("module-stage-emitter-output").textContent).toContain(
      "Emitter Output",
    );
    for (const id of [
      "material",
      "capacity",
      "loop",
      "duration",
      "prewarm",
      "blendMode",
      "billboard",
      "emitRate",
    ]) {
      expect(screen.getByTestId(`property-${id}`)).toBeTruthy();
    }
    // The unit comes verbatim from the catalog pin.
    expect(screen.getByRole("textbox", { name: "Emit Rate (/s)" })).toBeTruthy();
  });

  it("stores Capacity up to 4096 with one undo entry per gesture", () => {
    const history = renderDetails(createDefaultParticleGraphDocument("Embers"));
    type("property-capacity", "1000");
    type("property-capacity", "5000");
    expect(history.read().settings.capacity).toBe(4096);
    expect(history.stack.undoDepth).toBe(1);
    history.stack.endGesture();
    type("property-capacity", "600");
    expect(history.stack.undoDepth).toBe(2);
  });

  it("disables Pre Warm on Once loops", () => {
    const doc = createDefaultParticleGraphDocument("Embers");
    renderDetails({ ...doc, settings: { ...doc.settings, loop: "once" } });
    expect((screen.getByTestId("property-prewarm") as HTMLInputElement).disabled).toBe(true);
  });

  it("hides Emit Rate once a value feeds it", () => {
    const doc = createDefaultParticleGraphDocument("Embers");
    renderDetails({
      ...doc,
      nodes: [...doc.nodes, { id: "rate", type: "const.float", position: { x: 0, y: 400 }, properties: { value: [12] } }],
      edges: [
        ...doc.edges,
        { id: "e-rate", sourceNodeId: "rate", sourcePinId: "out", targetNodeId: "output", targetPinId: "emitRate" },
      ],
    });
    expect(screen.getByTestId("property-capacity")).toBeTruthy();
    expect(screen.queryByTestId("property-emitRate")).toBeNull();
  });

  it("picks only particle Materials", async () => {
    const history = renderDetails(createDefaultParticleGraphDocument("Embers"));
    fireEvent.click(screen.getByTestId("property-material"));
    await waitFor(() => expect(screen.getByTestId("search-item-mat-particle")).toBeTruthy());
    expect(screen.queryByTestId("search-item-mat-surface")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-mat-particle"));
    expect(history.read().materialGuid).toBe("mat-particle");
  });

  it("edits a node's unconnected inputs within the pin range, one undo entry per gesture", () => {
    const history = renderDetails(createDefaultParticleGraphDocument("Embers"), "create");
    expect(screen.getByTestId("module-stage-node").textContent).toContain("Create Particle");
    expect(screen.getByRole("textbox", { name: "Lifetime (s)" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Angle (rad)" })).toBeTruthy();
    type("property-lifetime", "2");
    type("property-lifetime", "0");
    expect(nodeOf(history.read(), "create").properties["default:lifetime"]).toEqual([0.01]);
    expect(history.stack.undoDepth).toBe(1);
    history.stack.endGesture();
    type("property-size", "0.5");
    expect(nodeOf(history.read(), "create").properties["default:size"]).toEqual([0.5]);
    expect(history.stack.undoDepth).toBe(2);
  });

  it("leaves wired inputs to the graph", () => {
    renderDetails(createDefaultParticleGraphDocument("Embers"), "updateColor");
    expect(screen.getByTestId("module-stage-node").textContent).toContain("Update Color");
    expect(screen.queryByTestId("property-color")).toBeNull();
  });

  it("edits Gradient stops for its value type", async () => {
    const history = renderDetails(createDefaultParticleGraphDocument("Embers"), "gradient");
    expect(screen.getByRole("button", { name: "Add Stop" })).toBeTruthy();

    await pickOption("property-valueType", "Float");
    const float = nodeOf(history.read(), "gradient");
    expect(float.properties.valueType).toBe("float");
    expect((float.properties.stops as Array<{ value: number[] }>).every((stop) => stop.value.length === 1)).toBe(true);
    expect(screen.getByRole("button", { name: "Add Key" })).toBeTruthy();

    // Float stops splat into the new width; editing one axis keeps the others.
    await pickOption("property-valueType", "Vector 3");
    type("property-stop-1-value-y", "2");
    const stops = nodeOf(history.read(), "gradient").properties.stops as Array<{
      position: number;
      value: number[];
    }>;
    expect(stops[1]).toEqual({ position: 1, value: [1, 2, 1] });
  });
});

describe("ParticleGraphPreview", () => {
  it("explains an empty Preview while the graph has never validated", () => {
    render(
      <ParticleGraphPreview
        document={createDefaultParticleGraphDocument("Embers")}
        previewDocument={null}
        errorCount={2}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("particle-preview-graph-errors").textContent).toContain(
      "Graph Has Errors",
    );
    expect(screen.queryByTestId("particle-graph-preview-canvas")).toBeNull();
  });

  it("keeps the last build with a notice and picks a Material from No Material", async () => {
    const onChange = vi.fn();
    const doc = createDefaultParticleGraphDocument("Embers");
    render(
      <ParticleGraphPreview
        document={doc}
        previewDocument={doc}
        errorCount={2}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("particle-graph-preview-stale").textContent).toBe(
      "Graph has 2 errors. Preview shows the last valid build.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Pick Material" }));
    await waitFor(() => expect(screen.getByTestId("search-item-mat-particle")).toBeTruthy());
    expect(screen.queryByTestId("search-item-mat-surface")).toBeNull();
    fireEvent.click(screen.getByTestId("search-item-mat-particle"));
    expect(onChange.mock.calls.at(-1)![0].materialGuid).toBe("mat-particle");
  });
});

describe("Particle Graph document panels", () => {
  function renderPanels(doc: ParticleGraphDocument, panels: "canvas" | "details") {
    store.reset(doc as unknown as Record<string, unknown>);
    return render(
      <ParticleGraphEditingProvider documentId={DOC_ID}>
        {panels === "canvas" ? (
          <ParticleGraphCanvasPanel {...panelProps} />
        ) : (
          <>
            <ParticleGraphDetailsPanel {...panelProps} />
            <ParticleGraphCompilerResultsPanel {...panelProps} />
          </>
        )}
      </ParticleGraphEditingProvider>,
    );
  }

  it("rings the pin a diagnostic names on the canvas", async () => {
    const { container } = renderPanels(withUnwiredPosition(), "canvas");
    await waitFor(() => {
      const pin = container.querySelector('[data-id="move"] [data-handleid="position"]');
      expect(pin?.getAttribute("data-error")).toBe("true");
    });
    expect(
      container
        .querySelector('[data-id="move"] [data-handleid="particle"]')
        ?.getAttribute("data-error"),
    ).toBeNull();
  });

  it("shows a diagnostic's node in Details when its row is tapped", () => {
    renderPanels(withUnwiredPosition(), "details");
    expect(screen.getByTestId("module-stage-emitter-output")).toBeTruthy();
    fireEvent.click(screen.getByTestId("particle-graph-diagnostic-particle.missingInput"));
    expect(screen.getByTestId("module-stage-node").textContent).toContain("Update Position");
  });

  it("commits Details edits to the open document", () => {
    renderPanels(createDefaultParticleGraphDocument("Embers"), "details");
    type("property-emitRate", "45");
    const committed = normalizeParticleGraphDocument(
      store.applyAssetDocumentChange.mock.calls.at(-1)![1],
    );
    const output = committed.nodes.find((node) => node.type === PARTICLE_OUTPUT_NODE_TYPE)!;
    expect(output.properties["default:emitRate"]).toEqual([45]);
    expect(store.applyAssetDocumentChange.mock.calls.at(-1)![2]).toBe(
      `particle-graph-field:${output.id}:emitRate`,
    );
  });
});
