import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@haptic/core";
import { InspectorPanel } from "./inspector-panel";
import { GraphPanel } from "./graph-panel";
import { GraphEditingProvider } from "../context/graph-editing-context";
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

/** The document as the last applied change left it; null for the fixture below. */
const docState = vi.hoisted(() => ({ content: null as SerializedGraph | null }));
const applyGraphChange = vi.hoisted(() =>
  vi.fn<(id: string, next: SerializedGraph) => Promise<boolean>>(
    async (_id, next) => {
      docState.content = next;
      return true;
    },
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
      content: docState.content ?? {
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
  docState.content = null;
  eventState.qualifier = "";
});

const panelProps = {} as IDockviewPanelProps;

/** The node header's inline rename field, focused with `name` selected. */
async function headerRename(name: string): Promise<HTMLInputElement> {
  const input = (await screen.findByTestId("graph-node-rename")) as HTMLInputElement;
  await act(async () => {});
  expect(input.value).toBe(name);
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, name.length]);
  return input;
}

describe("Inspector custom event details", () => {
  it("keeps inherited event names bound to their parent", () => {
    eventState.qualifier = "Inherited";
    renderEventInspector();
    expect(screen.queryByRole("button", { name: "Rename Event" })).toBeNull();
  });

  it("renames an event, its member and its call inline in the node header from its graph node menu", async () => {
    render(
      <GraphEditingProvider>
        <GraphPanel {...panelProps} />
      </GraphEditingProvider>,
    );
    fireEvent.contextMenu(screen.getByText("Event On Hit"));
    fireEvent.click(screen.getByText("Rename Event"));
    const input = await headerRename("On Hit");
    fireEvent.change(input, { target: { value: "onDamage" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(applyGraphChange).toHaveBeenCalledTimes(1);
    const next = applyGraphChange.mock.calls[0]![1];
    expect(next.members?.[0]?.name).toBe("On Damage");
    expect(next.nodes[0]?.data).toMatchObject({ name: "On Damage", title: "Event On Damage" });
    expect(next.nodes[1]?.data).toMatchObject({ name: "On Damage", title: "Call On Damage" });
    expect(screen.queryByTestId("graph-node-rename")).toBeNull();
  });

  it("starts the header rename when the event's title is double-clicked, and Escape keeps the name", async () => {
    render(
      <GraphEditingProvider>
        <GraphPanel {...panelProps} />
      </GraphEditingProvider>,
    );
    fireEvent.doubleClick(screen.getByText("Event On Hit"));
    const input = await headerRename("On Hit");
    fireEvent.change(input, { target: { value: "Other" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("graph-node-rename")).toBeNull();
    expect(screen.getByText("Event On Hit")).toBeTruthy();
    expect(applyGraphChange).not.toHaveBeenCalled();
    // A Call's title is not a rename.
    fireEvent.doubleClick(screen.getByText("Call On Hit"));
    await act(async () => {});
    expect(screen.queryByTestId("graph-node-rename")).toBeNull();
  });

  it("renames the selected custom event with the Rename key its menu item shows", async () => {
    const { container } = render(
      <KeybindProvider>
        <GraphEditingProvider>
          <GraphPanel {...panelProps} />
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
    await headerRename("On Hit");
  });

  it("renames the selected custom event in the Event Graph's node header from Details", async () => {
    // The Event Graph opens after the click, as the window does when it was closed.
    const view = (graphOpen: boolean) => (
      <PrefabEditingProvider initialSelectedId={null}>
        <GraphEditingProvider initialSelectedNodeIds={["evt-1"]}>
          <InspectorPanel {...panelProps} />
          {graphOpen ? <GraphPanel {...panelProps} /> : null}
        </GraphEditingProvider>
      </PrefabEditingProvider>
    );
    const { rerender } = render(view(false));
    fireEvent.click(screen.getByRole("button", { name: "Rename Event" }));
    // The mock reports no open windows, so the Event Graph is opened.
    expect(toggleDockWindow).toHaveBeenCalledWith("graph");
    rerender(view(true));
    const input = await headerRename("On Hit");
    fireEvent.change(input, { target: { value: "On Damage" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(applyGraphChange.mock.calls[0]?.[1].members?.[0]?.name).toBe("On Damage");
  });

  it("adds Create New Custom Event… under a free name and renames it in its node header", async () => {
    render(
      <GraphEditingProvider>
        <GraphPanel {...panelProps} />
      </GraphEditingProvider>,
    );
    fireEvent.click(screen.getByTestId("graph-add-node"));
    const row = await screen.findByTestId("node-palette-item-flow.event.custom");
    expect(row.textContent).toContain("Create New Custom Event…");
    fireEvent.click(row);
    const added = applyGraphChange.mock.calls.at(-1)![1].nodes.find((node) => node.type === "flow.event.custom" && node.id !== "evt-1")!;
    expect(added.data).toMatchObject({ name: "NewEvent", title: "Event NewEvent" });
    const input = await headerRename("NewEvent");
    expect(input.closest(`.react-flow__node[data-id="${added.id}"]`)).not.toBeNull();
    fireEvent.change(input, { target: { value: "Open Door" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const renamed = applyGraphChange.mock.calls.at(-1)![1].nodes.find((node) => node.id === added.id);
    expect(renamed?.data).toMatchObject({ name: "Open Door", title: "Event Open Door" });
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
