import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createText3DComponent, type SerializedGraph } from "@babylonslate/core";
import { MyClassPanel } from "./my-class-panel";
import { EditorSessionStateProvider } from "../context/editor-session-state-context";
import { GraphEditingProvider, useGraphEditing } from "../context/graph-editing-context";
import { KeybindProvider } from "../context/keybind-context";
import { addClassMember, ensureEventNodeOnGraph } from "../lib/class-members";

type PointerInit = {
  clientX?: number;
  clientY?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  pointerType?: "mouse" | "touch";
  pointerId?: number;
};

/** jsdom has no PointerEvent; a MouseEvent with pointer fields drives TreeView. */
function dispatchPointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: PointerInit = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 10,
    clientY: init.clientY ?? 10,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  Object.defineProperty(event, "isPrimary", { value: (init.pointerId ?? 1) === 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

function click(id: string, init: PointerInit = {}): void {
  const row = screen.getByTestId(`tree-row-${id}`);
  dispatchPointer(row, "pointerdown", init);
  dispatchPointer(row, "pointerup", init);
}

const applyGraphChange = vi.hoisted(() =>
  vi.fn<(id: string, graph: SerializedGraph) => Promise<boolean>>(async () => true),
);
const harness = vi.hoisted(() => ({
  path: "assets/Hero.class.babasset",
  graphs: {} as Record<string, SerializedGraph>,
  assets: [] as Array<{ path: string; header: { type: string; name: string; guid: string; parentClass?: string } }>,
}));

vi.mock("../shell/use-platform-layout", () => ({ usePhoneLayout: () => false }));
vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: `graph:${harness.path}` }),
}));
vi.mock("../context/validation-context", () => ({
  useValidation: () => ({ setFocusDiagnostic: vi.fn() }),
}));
vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    openDocuments: [
      {
        id: `graph:${harness.path}`,
        ref: { kind: "graph", path: harness.path, label: harness.path },
        content: harness.graphs[harness.path],
        layout: null,
        dirty: false,
      },
    ],
    applyGraphChange,
    assetRegistry: { list: () => harness.assets },
  })),
);

const EVENT_PINS = [{ name: "Damage", typeId: "float", direction: "out" as const }];

function heroGraph(): SerializedGraph {
  let graph: SerializedGraph = { nodes: [], edges: [] };
  graph = addClassMember(graph, "function", "Jump", () => "fn-jump");
  graph = addClassMember(graph, "variable", "Health", () => "var-health", {
    typeId: "float",
    defaultValue: 100,
  });
  graph = {
    ...graph,
    members: graph.members!.map((member) =>
      member.id === "var-health" ? { ...member, category: "Stats" } : member,
    ),
  };
  graph = addClassMember(graph, "variable", "Mana", () => "var-mana", { typeId: "int", defaultValue: 5 });
  graph = addClassMember(graph, "variable", "Pawn", () => "var-pawn", {
    typeId: "actor",
    typeClassId: "Actor",
  });
  graph = ensureEventNodeOnGraph(graph, "flow.event.beginPlay", { idFactory: () => "evt-begin" });
  graph = addClassMember(graph, "event", "On Hit", () => "evt-hit", { pins: EVENT_PINS });
  graph = addClassMember(graph, "interface", "Damageable", () => "if-1", { assetGuid: "guid-1" });
  return graph;
}

function enemyGraph(): SerializedGraph {
  let graph: SerializedGraph = { nodes: [], edges: [] };
  graph = addClassMember(graph, "variable", "Health", () => "enemy-health", { typeId: "float" });
  graph = ensureEventNodeOnGraph(graph, "flow.event.beginPlay", { idFactory: () => "enemy-begin" });
  return graph;
}

function Probe() {
  const { selectedMemberId, selectedNodeIds, activeFunctionId } = useGraphEditing();
  return (
    <output data-testid="probe">
      {JSON.stringify({ member: selectedMemberId, nodes: selectedNodeIds, fn: activeFunctionId })}
    </output>
  );
}

const canvas = {
  containsClientPoint: (clientX: number) => clientX >= 200,
  clientToFlow: (clientX: number, clientY: number) => ({ x: clientX - 200, y: clientY }),
};
function Canvas() {
  const { setCanvasDropApi } = useGraphEditing();
  useEffect(() => {
    setCanvasDropApi(canvas);
    return () => setCanvasDropApi(null);
  }, [setCanvasDropApi]);
  return null;
}

function panel() {
  return (
    <KeybindProvider>
      <EditorSessionStateProvider>
        <GraphEditingProvider>
          <Canvas />
          <Probe />
          <MyClassPanel {...({} as IDockviewPanelProps)} />
        </GraphEditingProvider>
      </EditorSessionStateProvider>
    </KeybindProvider>
  );
}

function renderPanel(graph = heroGraph()) {
  harness.path = "assets/Hero.class.babasset";
  harness.graphs = {
    "assets/Hero.class.babasset": graph,
    "assets/Enemy.class.babasset": enemyGraph(),
  };
  const view = render(panel());
  const tree = screen.getByTestId("my-blueprint-tree");
  tree.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 180, bottom: 400, width: 180, height: 400 }) as DOMRect;
  return view;
}

const selected = () =>
  screen
    .getAllByRole("treeitem")
    .filter((row) => row.getAttribute("aria-selected") === "true")
    .map((row) => row.getAttribute("data-testid")!.replace("tree-row-", ""));

const probe = () => JSON.parse(screen.getByTestId("probe").textContent!) as {
  member: string | null;
  nodes: string[];
  fn: string | null;
};

/** The menu's labels, without the chord an item shows beside its label. */
const menuLabels = () =>
  screen
    .getAllByRole("menuitem")
    .map((item) => item.querySelector(".context-menu-item-label")!.textContent);

const menuItem = (name: string) =>
  screen.getAllByRole("menuitem").find((item) => item.querySelector(".context-menu-item-label")!.textContent === name)! as HTMLButtonElement;

/** The nodes a drop added to the open graph or to the open function, by title. */
const addedTitles = (graph: SerializedGraph) =>
  [...graph.nodes, ...Object.values(graph.functionGraphs ?? {}).flatMap((slice) => slice.nodes)]
    .filter((node) => /^(functions\.call|variables\.|flow\.event\.call)/.test(node.type))
    .map((node) => node.data.title);

function openMenu(id: string) {
  fireEvent.contextMenu(screen.getByTestId(`tree-row-${id}`), { clientX: 20, clientY: 30 });
}

function pressChord(target: Element, key: string) {
  fireEvent.keyDown(target, { key, code: `Key${key.toUpperCase()}`, ctrlKey: true });
}

beforeEach(() => {
  harness.graphs = {};
  harness.assets = [];
  applyGraphChange.mockImplementation(async (id, graph) => {
    harness.graphs[id.replace(/^graph:/, "")] = graph;
    return true;
  });
});

afterEach(() => {
  cleanup();
  applyGraphChange.mockClear();
  vi.useRealTimers();
});

describe("Class tree multi-selection", () => {
  it("toggles an entry with Ctrl click and keeps the graph on the one last chosen", () => {
    renderPanel();
    click("var-health");
    expect(selected()).toEqual(["var-health"]);
    click("var-pawn", { ctrlKey: true });
    expect(selected()).toEqual(["var-health", "var-pawn"]);
    expect(probe().member).toBe("var-pawn");
    click("var-health", { ctrlKey: true });
    expect(selected()).toEqual(["var-pawn"]);
    expect(screen.getByRole("tree").getAttribute("aria-multiselectable")).toBe("true");
  });

  it("selects a range in visible tree order with Shift click, never the section or folder rows", () => {
    renderPanel();
    click("fn-jump");
    expect(probe()).toMatchObject({ member: "fn-jump", fn: "fn-jump" });
    click("var-pawn", { shiftKey: true });
    // Visible order: Functions, Variables > Stats folder > Health, Mana, Pawn.
    expect(selected()).toEqual(["fn-jump", "var-health", "var-mana", "var-pawn"]);
    expect(probe().member).toBe("var-pawn");
    // A range can also run upwards from the same anchor.
    click("evt-begin");
    click("var-mana", { shiftKey: true });
    expect(selected()).toEqual(["var-mana", "var-pawn", "evt-begin"]);
  });

  it("extends the selection with Shift+Arrow and moves it with the arrows", () => {
    renderPanel();
    const tree = screen.getByRole("tree");
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(selected()).toEqual(["fn-jump"]);
    for (let step = 0; step < 3; step += 1) fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
    // Section and folder rows are passed over, not selected, and the range keeps its start.
    expect(selected()).toEqual(["fn-jump", "var-health"]);
    fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
    expect(selected()).toEqual(["fn-jump", "var-health", "var-mana"]);
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(selected()).toEqual(["var-pawn"]);
  });

  it("replaces the group with a plain click", () => {
    renderPanel();
    click("var-health");
    click("var-mana", { ctrlKey: true });
    click("var-pawn");
    expect(selected()).toEqual(["var-pawn"]);
  });
});

describe("Class tree touch multi-selection", () => {
  it("selects the range up to a row tapped with a second finger", () => {
    renderPanel();
    click("var-health", { pointerType: "touch" });
    // One finger rests on a row, a second taps another.
    const resting = screen.getByTestId("tree-row-var-health");
    const tapped = screen.getByTestId("tree-row-var-pawn");
    dispatchPointer(resting, "pointerdown", { pointerType: "touch", pointerId: 1 });
    dispatchPointer(tapped, "pointerdown", { pointerType: "touch", pointerId: 2 });
    dispatchPointer(tapped, "pointerup", { pointerType: "touch", pointerId: 2 });
    expect(selected()).toEqual(["var-health", "var-mana", "var-pawn"]);
  });

  it("adds an entry from the menu a long press opens, keeping what was selected", () => {
    vi.useFakeTimers();
    renderPanel();
    click("var-health", { pointerType: "touch" });
    const row = screen.getByTestId("tree-row-evt-hit");
    dispatchPointer(row, "pointerdown", { pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // The hold replaced the selection, as it does for a single entry ...
    expect(selected()).toEqual(["evt-hit"]);
    // ... and Select puts the previous selection back with it.
    fireEvent.click(screen.getByTestId("class-menu-select"));
    expect(selected()).toEqual(["var-health", "evt-hit"]);
    dispatchPointer(row, "pointerup", { pointerType: "touch" });
  });

  it("removes an entry of a group from the menu with Deselect", () => {
    renderPanel();
    click("var-health");
    click("var-mana", { ctrlKey: true });
    openMenu("var-mana");
    fireEvent.click(screen.getByTestId("class-menu-deselect"));
    expect(selected()).toEqual(["var-health"]);
  });
});

describe("Class tree context menu", () => {
  it("acts on the group of a selected entry: Copy, Paste and Delete, without single-entry items", () => {
    renderPanel();
    click("fn-jump");
    click("var-health", { ctrlKey: true });
    click("evt-begin", { ctrlKey: true });
    openMenu("var-health");
    expect(selected()).toEqual(["fn-jump", "var-health", "evt-begin"]);
    expect(menuLabels()).toEqual(["Deselect", "Copy", "Paste", "Delete"]);
    expect(menuItem("Paste").disabled).toBe(true);
  });

  it("offers no Copy when a Script Interface entry is selected, but still Delete", () => {
    renderPanel();
    click("var-health");
    click("if-1", { ctrlKey: true });
    openMenu("if-1");
    expect(menuLabels()).toEqual(["Deselect", "Paste", "Delete"]);
  });

  it("keeps the single-entry items for one entry and replaces the selection on an unselected one", () => {
    renderPanel();
    click("var-health");
    click("var-mana", { ctrlKey: true });
    openMenu("var-pawn");
    expect(selected()).toEqual(["var-pawn"]);
    expect(menuLabels()).toEqual(["Get", "Set", "Select", "Rename", "Copy", "Paste", "Delete"]);
  });

  it("offers Copy but no Delete when a component variable is selected", () => {
    const graph = heroGraph();
    graph.components = [createText3DComponent("text-1")];
    renderPanel(graph);
    click("var-health");
    click("component:text-1", { ctrlKey: true });
    openMenu("component:text-1");
    expect(menuLabels()).toEqual(["Deselect", "Copy", "Paste"]);
  });

  it("offers only Paste on a section row and on the tree background", () => {
    renderPanel();
    openMenu("section-variables");
    expect(menuLabels()).toEqual(["Paste"]);
    fireEvent.keyDown(document.body, { key: "Escape" });
    cleanup();
    renderPanel();
    fireEvent.contextMenu(screen.getByTestId("my-blueprint-tree"), { clientX: 5, clientY: 390 });
    expect(menuLabels()).toEqual(["Paste"]);
  });

  it("deletes the whole group as one change", () => {
    renderPanel();
    click("var-health");
    click("var-mana", { ctrlKey: true });
    click("fn-jump", { ctrlKey: true });
    openMenu("fn-jump");
    fireEvent.click(screen.getByTestId("class-menu-delete"));
    expect(applyGraphChange).toHaveBeenCalledTimes(1);
    const next = applyGraphChange.mock.calls[0]![1];
    expect(next.members!.map((member) => member.name)).toEqual(["Pawn", "On Hit", "Damageable"]);
    expect(Object.keys(next.functionGraphs ?? {})).toEqual([]);
  });
});

describe("Class tree copy and paste", () => {
  function copySelection() {
    click("var-health");
    click("var-mana", { ctrlKey: true });
    click("fn-jump", { ctrlKey: true });
    click("evt-begin", { ctrlKey: true });
    openMenu("evt-begin");
    fireEvent.click(screen.getByTestId("class-menu-copy"));
  }

  it("copies members of one Class and pastes them into another from its tree background", () => {
    const view = renderPanel();
    copySelection();
    expect(applyGraphChange).not.toHaveBeenCalled();

    harness.path = "assets/Enemy.class.babasset";
    view.rerender(panel());
    fireEvent.contextMenu(screen.getByTestId("my-blueprint-tree"), { clientX: 5, clientY: 390 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Paste" }));

    expect(applyGraphChange).toHaveBeenCalledTimes(1);
    const [documentId, next] = applyGraphChange.mock.calls[0]!;
    expect(documentId).toBe("graph:assets/Enemy.class.babasset");
    const pasted = (next.members ?? []).filter((member) => !["enemy-health"].includes(member.id));
    // Health exists in Enemy, so its copy is numbered; Mana and Jump keep their names.
    expect(pasted.map((member) => [member.kind, member.name, member.category ?? null])).toEqual([
      ["variable", "Health_1", "Stats"],
      ["variable", "Mana", null],
      ["event", "Begin Play 1", null],
      ["function", "Jump", null],
    ]);
    expect(Object.keys(next.functionGraphs ?? {})).toHaveLength(1);
    // Enemy already has Begin Play, so the copy is a numbered custom event.
    expect(next.nodes.map((node) => [node.type, node.data.name ?? null])).toEqual([
      ["flow.event.beginPlay", null],
      ["flow.event.custom", "Begin Play 1"],
    ]);
    // The pasted copies become the selection once the Class shows them.
    view.rerender(panel());
    expect(selected().sort()).toEqual(
      next.members!.filter((member) => !member.functionId && member.id !== "enemy-health").map((member) => member.id).sort(),
    );
  });

  it("pastes into the same Class as duplicates, with the keyboard while the tree has focus", () => {
    renderPanel();
    copySelection();
    const tree = screen.getByRole("tree");
    tree.focus();
    pressChord(tree, "v");
    expect(applyGraphChange).toHaveBeenCalledTimes(1);
    const next = applyGraphChange.mock.calls[0]![1];
    expect(next.members!.map((member) => member.name)).toEqual([
      "Jump",
      "Health",
      "Mana",
      "Pawn",
      "On Hit",
      "Damageable",
      "Health_1",
      "Mana_1",
      "Begin Play 1",
      "Jump_1",
    ]);
  });

  it("copies with the keyboard while the tree has focus", () => {
    const view = renderPanel();
    click("var-pawn");
    pressChord(screen.getByRole("tree"), "c");
    harness.path = "assets/Enemy.class.babasset";
    view.rerender(panel());
    screen.getByRole("tree").focus();
    pressChord(screen.getByRole("tree"), "v");
    expect(applyGraphChange).toHaveBeenCalledTimes(1);
    expect(applyGraphChange.mock.calls[0]![1].members!.at(-1)).toMatchObject({ kind: "variable", name: "Pawn" });
  });

  it("leaves the copy key alone while focus is elsewhere", () => {
    renderPanel();
    click("var-pawn");
    (document.activeElement as HTMLElement).blur();
    pressChord(document.body, "c");
    fireEvent.contextMenu(screen.getByTestId("my-blueprint-tree"), { clientX: 5, clientY: 390 });
    expect(menuItem("Paste").disabled).toBe(true);
  });

  it("tells what a paste left out, and changes nothing when that is everything", () => {
    const view = renderPanel();
    click("evt-begin");
    openMenu("evt-begin");
    fireEvent.click(screen.getByTestId("class-menu-copy"));
    // A Function Library has no Event Graph.
    harness.graphs["assets/Lib.class.babasset"] = { nodes: [], edges: [] };
    harness.assets = [
      { path: "assets/Lib.class.babasset", header: { type: "Class", name: "Lib", guid: "lib", parentClass: "FunctionLibrary" } },
    ];
    harness.path = "assets/Lib.class.babasset";
    view.rerender(panel());
    fireEvent.contextMenu(screen.getByTestId("my-blueprint-tree"), { clientX: 5, clientY: 390 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Paste" }));
    expect(applyGraphChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("class-notice").textContent).toBe(
      "Event Begin Play can't be added to this Class.",
    );
  });

  describe("local variables", () => {
    function copyLocal() {
      const hero = heroGraph();
      hero.members = [
        ...hero.members!,
        { id: "var-temp", kind: "variable", name: "Temp", typeId: "float", functionId: "fn-jump" },
      ];
      const view = renderPanel(hero);
      // Opening the function shows its local variables.
      click("fn-jump");
      click("var-temp");
      openMenu("var-temp");
      fireEvent.click(screen.getByTestId("class-menu-copy"));
      harness.graphs["assets/Enemy.class.babasset"] = addClassMember(enemyGraph(), "function", "Run", () => "fn-run");
      harness.path = "assets/Enemy.class.babasset";
      view.rerender(panel());
    }

    it("go into the function selected in the target tree", () => {
      copyLocal();
      click("fn-run");
      openMenu("fn-run");
      fireEvent.click(screen.getByTestId("class-menu-paste"));
      expect(applyGraphChange).toHaveBeenCalledTimes(1);
      expect(applyGraphChange.mock.calls[0]![1].members!.at(-1)).toMatchObject({
        kind: "variable",
        name: "Temp",
        functionId: "fn-run",
      });
    });

    it("are left out, and named, when the target has no function selected or open", () => {
      copyLocal();
      click("enemy-health");
      fireEvent.contextMenu(screen.getByTestId("my-blueprint-tree"), { clientX: 5, clientY: 390 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Paste" }));
      expect(applyGraphChange).not.toHaveBeenCalled();
      expect(screen.getByTestId("class-notice").textContent).toBe("Temp needs a function. Select or open one first.");
    });
  });
});

describe("Class tree drag to the graph", () => {
  function drag(id: string, to = { clientX: 300, clientY: 120 }) {
    const row = screen.getByTestId(`tree-row-${id}`);
    dispatchPointer(row, "pointerdown", { clientX: 10, clientY: 20 });
    dispatchPointer(row, "pointermove", to);
    return {
      drop: () => dispatchPointer(row, "pointerup", to),
    };
  }

  it("drops every selected function and event as one stack of Call nodes from the drop point", () => {
    renderPanel();
    click("fn-jump");
    click("evt-hit", { ctrlKey: true });
    const gesture = drag("fn-jump");
    expect(screen.getByTestId("graph-member-drop-hint").textContent).toContain("Add 2 Nodes");
    gesture.drop();

    expect(applyGraphChange).toHaveBeenCalledTimes(1);
    const added = applyGraphChange.mock.calls[0]![1].nodes.filter(
      (node) => node.type === "functions.call" || node.type === "flow.event.call",
    );
    expect(added.map((node) => [node.type, node.data.functionName ?? node.data.name])).toEqual([
      ["functions.call", "Jump"],
      ["flow.event.call", "On Hit"],
    ]);
    expect(added[0]!.position).toEqual({ x: 100, y: 120 });
    expect(added[1]!.position.x).toBe(100);
    expect(added[1]!.position.y).toBeGreaterThan(120 + 100);
  });

  it("asks Get or Set once for the variables, then drops them all in one change", () => {
    renderPanel();
    click("var-health");
    click("var-mana", { ctrlKey: true });
    click("fn-jump", { ctrlKey: true });
    drag("var-mana").drop();
    expect(applyGraphChange).not.toHaveBeenCalled();
    const chooser = screen.getByTestId("member-access-chooser");
    expect(within(chooser).getByText("3 Members")).toBeTruthy();
    fireEvent.click(within(chooser).getByTestId("member-access-set"));

    expect(applyGraphChange).toHaveBeenCalledTimes(1);
    expect(addedTitles(applyGraphChange.mock.calls[0]![1])).toEqual(["Call Jump", "Set Health", "Set Mana"]);
  });

  it("drops only the dragged entry when it is not part of the selection", () => {
    renderPanel();
    click("fn-jump");
    click("evt-hit", { ctrlKey: true });
    drag("var-pawn").drop();
    fireEvent.click(screen.getByTestId("member-access-get"));
    expect(addedTitles(applyGraphChange.mock.calls[0]![1])).toEqual(["Get Pawn"]);
    expect(selected()).toEqual(["fn-jump", "evt-hit"]);
  });

  it("skips the entries that cannot drop and says so", () => {
    renderPanel();
    click("fn-jump");
    click("if-1", { ctrlKey: true });
    click("evt-begin", { ctrlKey: true });
    drag("fn-jump").drop();
    const added = applyGraphChange.mock.calls[0]![1].nodes.filter((node) => node.type === "functions.call");
    expect(added).toHaveLength(1);
    expect(screen.getByTestId("class-notice").textContent).toBe(
      "Event Begin Play and Damageable can't be added to a graph.",
    );
  });

  it("does nothing when released away from the graph", () => {
    renderPanel();
    click("fn-jump");
    click("evt-hit", { ctrlKey: true });
    drag("fn-jump", { clientX: 100, clientY: 50 }).drop();
    expect(applyGraphChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("class-notice")).toBeNull();
  });
});

describe("Events add menu", () => {
  it("adds a native event of a Class with a parent wired to Call Parent, like its inherited row", () => {
    harness.path = "assets/Child.class.babasset";
    harness.graphs = { "assets/Child.class.babasset": { nodes: [], edges: [] } };
    harness.assets = [
      { path: "assets/Child.class.babasset", header: { type: "Class", name: "Child", guid: "child", parentClass: "Actor" } },
    ];
    render(panel());
    fireEvent.click(screen.getByTestId("class-add-events"));
    fireEvent.click(
      within(screen.getByTestId("add-event-menu")).getByTestId("search-item-native:flow.event.beginPlay"),
    );
    const next = applyGraphChange.mock.calls[0]![1];
    expect(next.nodes.map((node) => node.type)).toEqual(["flow.event.beginPlay", "flow.event.callParent"]);
    expect(next.nodes[1]!.data).toMatchObject({ eventType: "flow.event.beginPlay", parentClassId: "Actor" });
    expect(next.edges).toHaveLength(1);
  });
});
