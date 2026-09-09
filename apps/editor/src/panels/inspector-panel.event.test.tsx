import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@babylonslate/core";
import { InspectorPanel } from "./inspector-panel";
import { GraphPanel } from "./graph-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";

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

const applyGraphChange = vi.hoisted(() =>
  vi.fn<(id: string, next: SerializedGraph) => Promise<boolean>>(
    async () => true,
  ),
);
const eventState = vi.hoisted(() => ({ qualifier: "" }));

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
          nodes: [
            {
              id: "evt-1",
              type: "flow.event.custom",
              position: { x: 80, y: 80 },
              data: {
                title: "Event On Hit",
                name: "On Hit",
                pins: [],
                __nodeType: "flow.event.custom",
                eventQualifier: eventState.qualifier,
              },
            },
            {
              id: "call-1",
              type: "flow.event.call",
              position: { x: 280, y: 80 },
              data: {
                title: "Call On Hit",
                name: "On Hit",
                classId: "Hero",
                implicitSelf: true,
                __nodeType: "flow.event.call",
              },
            },
          ],
          edges: [],
          members: [{ id: "evt-1", kind: "event", name: "On Hit", pins: [] }],
        },
        layout: null,
        dirty: false,
      },
    ],
    applyGraphChange,
    projectDocument: { settings: { input: { actions: [], axes: [] } } },
    assetRegistry: { list: () => [] },
  }),
}));

vi.mock("../context/validation-context", () => ({
  useValidation: () => ({
    focusDiagnostic: null,
    diagnostics: [],
    setDiagnostics: vi.fn(),
    setFocusDiagnostic: vi.fn(),
  }),
}));

vi.mock("../context/play-context", () => ({
  usePlay: () => ({ focusedNodeId: null }),
}));

function renderEventInspector() {
  return render(
    <PrefabEditingProvider initialSelectedId={null}>
      <GraphEditingProvider initialSelectedNodeIds={["evt-1"]}>
        <InspectorPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>
    </PrefabEditingProvider>,
  );
}

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
  eventState.qualifier = "";
});

describe("Inspector custom event details", () => {
  it("keeps inherited event names bound to their parent", () => {
    eventState.qualifier = "Inherited";
    renderEventInspector();
    expect(screen.queryByRole("button", { name: "Rename Event" })).toBeNull();
  });

  it("renames an event through its graph node context menu", () => {
    render(
      <GraphEditingProvider>
        <GraphPanel {...({} as IDockviewPanelProps)} />
      </GraphEditingProvider>,
    );
    fireEvent.contextMenu(screen.getByText("Event On Hit"));
    fireEvent.click(screen.getByText("Rename Event"));
    fireEvent.change(screen.getByLabelText("Event Name"), { target: { value: "On Damage" } });
    fireEvent.click(screen.getByTestId("name-prompt-confirm"));
    expect(applyGraphChange.mock.calls[0]?.[1].nodes[0]?.data.name).toBe("On Damage");
    expect(applyGraphChange.mock.calls[0]?.[1].nodes[1]?.data.name).toBe("On Damage");
  });

  it("renames the selected custom event and its call from Details", () => {
    renderEventInspector();
    fireEvent.click(screen.getByRole("button", { name: "Rename Event" }));
    fireEvent.change(screen.getByLabelText("Event Name"), { target: { value: "onDamage" } });
    fireEvent.click(screen.getByTestId("name-prompt-confirm"));
    const next = applyGraphChange.mock.calls[0]?.[1];
    expect(next?.members?.[0]?.name).toBe("On Damage");
    expect(next?.nodes[0]?.data.title).toBe("Event On Damage");
    expect(next?.nodes[1]?.data.name).toBe("On Damage");
  });

  it("shows an Outputs pin list when the Class-panel event node is selected", () => {
    renderEventInspector();
    expect(screen.getByTestId("inspector-event-outputs")).toBeTruthy();
    expect(screen.getByTestId("event-out-add")).toBeTruthy();
    expect(screen.queryByTestId("inspector-member-inputs")).toBeNull();
  });

  it("commits Outputs onto the event member and matching Call nodes", () => {
    renderEventInspector();
    fireEvent.change(screen.getByPlaceholderText("name"), {
      target: { value: "amount" },
    });
    fireEvent.click(screen.getByTestId("event-out-add"));
    expect(applyGraphChange).toHaveBeenCalled();
    const next = applyGraphChange.mock.calls[0]?.[1] as {
      members?: Array<{ pins?: Array<{ name: string }> }>;
      nodes?: Array<{ data: { pins?: Array<{ name: string }> } }>;
    };
    expect(next.members?.[0]?.pins).toEqual([
      { name: "amount", typeId: "float", direction: "out" },
    ]);
    expect(next.nodes?.[0]?.data.pins).toEqual([
      { name: "amount", typeId: "float", direction: "out" },
    ]);
    expect(next.nodes?.[1]?.data.pins).toEqual([
      { name: "amount", typeId: "float", direction: "out" },
    ]);
  });
});
