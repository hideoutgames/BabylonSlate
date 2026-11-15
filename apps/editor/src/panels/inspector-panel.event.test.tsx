import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@haptic/core";
import { InspectorPanel } from "./inspector-panel";
import { GraphPanel } from "./graph-panel";
import { MyClassPanel } from "./my-class-panel";
import { GraphEditingProvider, useGraphEditing } from "../context/graph-editing-context";
import { PrefabEditingProvider } from "../context/prefab-editing-context";
import { KeybindProvider } from "../context/keybind-context";

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
const toggleDockWindow = vi.hoisted(() => vi.fn<(panelId: string) => void>());

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "graph:assets/Hero.class.hasset",
  }),
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [
    {
      id: "graph:assets/Hero.class.hasset",
      ref: {
        kind: "graph",
        path: "assets/Hero.class.hasset",
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
  toggleDockWindow,
  projectDocument: { settings: {} },
  assetRegistry: { list: () => [], getByPath: () => undefined },
})));

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
  usePlayFocusedNodeId: () => null,
  usePlaySimulationDocumentId: () => null,
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
  toggleDockWindow.mockClear();
  eventState.qualifier = "";
});

const panelProps = {} as IDockviewPanelProps;

/** The Class panel row's inline rename, focused with its name selected. */
async function classPanelRename(nodeId: string, name: string): Promise<HTMLInputElement> {
  const input = (await screen.findByTestId(`tree-rename-${nodeId}`)) as HTMLInputElement;
  await act(async () => {});
  expect(input.value).toBe(name);
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, name.length]);
  // The Class panel was closed (the mock reports no open windows), so it opens.
  expect(toggleDockWindow).toHaveBeenCalledWith("my-class");
  return input;
}

function RenameRequest() {
  return <output data-testid="rename-request">{useGraphEditing().eventRenameRequest ?? ""}</output>;
}

describe("Inspector custom event details", () => {
  it("keeps inherited event names bound to their parent", () => {
    eventState.qualifier = "Inherited";
    renderEventInspector();
    expect(screen.queryByRole("button", { name: "Rename Event" })).toBeNull();
  });

  it("renames an event inline in the Class panel from its graph node menu", async () => {
    render(
      <GraphEditingProvider>
        <GraphPanel {...panelProps} />
        <MyClassPanel {...panelProps} />
      </GraphEditingProvider>,
    );
    fireEvent.contextMenu(screen.getByText("Event On Hit"));
    fireEvent.click(screen.getByText("Rename Event"));
    expect(screen.queryByLabelText("Event Name")).toBeNull();
    const input = await classPanelRename("evt-1", "On Hit");
    fireEvent.change(input, { target: { value: "On Damage" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(applyGraphChange.mock.calls[0]?.[1].nodes[0]?.data.name).toBe("On Damage");
    expect(applyGraphChange.mock.calls[0]?.[1].nodes[1]?.data.name).toBe("On Damage");
  });

  it("renames the selected custom event with the Rename key its menu item shows", async () => {
    const { container } = render(
      <KeybindProvider>
        <GraphEditingProvider>
          <GraphPanel {...panelProps} />
          <MyClassPanel {...panelProps} />
        </GraphEditingProvider>
      </KeybindProvider>,
    );
    fireEvent.contextMenu(screen.getByText("Event On Hit"));
    expect(screen.getByRole("menuitem", { name: /^Rename Event/ }).getAttribute("aria-keyshortcuts")).toBe("F2");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    // The key acts on the selection with focus in the graph, as after a click on the node.
    const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="evt-1"]')!;
    fireEvent.click(node);
    await act(async () => {});
    node.focus();
    fireEvent.keyDown(node, { key: "F2", code: "F2" });
    await classPanelRename("evt-1", "On Hit");
  });

  it("renames the selected custom event and its call inline from Details", async () => {
    render(
      <PrefabEditingProvider initialSelectedId={null}>
        <GraphEditingProvider initialSelectedNodeIds={["evt-1"]}>
          <InspectorPanel {...panelProps} />
          <MyClassPanel {...panelProps} />
        </GraphEditingProvider>
      </PrefabEditingProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename Event" }));
    const input = await classPanelRename("evt-1", "On Hit");
    fireEvent.change(input, { target: { value: "onDamage" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const next = applyGraphChange.mock.calls[0]?.[1];
    expect(next?.members?.[0]?.name).toBe("On Damage");
    expect(next?.nodes[0]?.data.title).toBe("Event On Damage");
    expect(next?.nodes[1]?.data.name).toBe("On Damage");
  });

  it("adds Create New Custom Event… under a free name and asks the Class panel to rename it", async () => {
    render(
      <GraphEditingProvider>
        <GraphPanel {...panelProps} />
        <RenameRequest />
      </GraphEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("graph-add-node"));
    const row = await screen.findByTestId("node-palette-item-flow.event.custom");
    expect(row.textContent).toContain("Create New Custom Event…");
    fireEvent.click(row);
    const next = applyGraphChange.mock.calls.at(-1)?.[1];
    const added = next?.nodes.find((node) => node.type === "flow.event.custom" && node.id !== "evt-1");
    expect(added?.data).toMatchObject({ name: "NewEvent", title: "Event NewEvent" });
    expect(screen.getByTestId("rename-request").textContent).toBe(added?.id);
    expect(toggleDockWindow).toHaveBeenCalledWith("my-class");
  });

  it("shows an Outputs pin list when the Class-panel event node is selected", () => {
    renderEventInspector();
    expect(screen.getByTestId("inspector-event-outputs")).toBeTruthy();
    expect(screen.getByTestId("event-out-add")).toBeTruthy();
    expect(screen.queryByTestId("inspector-member-inputs")).toBeNull();
  });

  it("commits Outputs onto the event member and matching Call nodes", async () => {
    renderEventInspector();
    fireEvent.click(screen.getByTestId("event-out-add"));
    fireEvent.click(await screen.findByTestId("search-item-float"));
    expect(applyGraphChange).toHaveBeenCalled();
    const next = applyGraphChange.mock.calls[0]?.[1] as {
      members?: Array<{ pins?: Array<{ name: string }> }>;
      nodes?: Array<{ data: { pins?: Array<{ name: string }> } }>;
    };
    expect(next.members?.[0]?.pins).toEqual([
      { name: "NewOutput", typeId: "float", direction: "out" },
    ]);
    expect(next.nodes?.[0]?.data.pins).toEqual([
      { name: "NewOutput", typeId: "float", direction: "out" },
    ]);
    expect(next.nodes?.[1]?.data.pins).toEqual([
      { name: "NewOutput", typeId: "float", direction: "out" },
    ]);
  });
});
