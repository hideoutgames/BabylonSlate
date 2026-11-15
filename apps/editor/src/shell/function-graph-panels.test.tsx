import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi, IDockviewPanelProps } from "dockview-react";
import { DockviewShell } from "./dockview-shell";
import {
  ANIM_STATE_MACHINE_PANEL_ID,
  EVENT_GRAPH_PANEL_ID,
  animStateGraphPanelId,
  functionGraphPanelId,
  openAnimStateGraphPanel,
  openFunctionGraphPanel,
} from "./function-graph-panels";

vi.mock("./use-platform-layout", () => ({
  usePlatformLayoutOptions: () => ({
    singleWindow: false,
    disableFloatingGroups: false,
    dndStrategy: "pointer",
  }),
}));

// Keep real Dockview; panel contents are outside this contract.
vi.mock("./panel-registry", () => {
  const panel = ({ api }: IDockviewPanelProps) => <div>{api.title}</div>;
  return {
    panelComponents: Object.fromEntries(
      [
        "graph",
        "function-graph",
        "prefab-viewport",
        "actor-prefab",
        "my-class",
        "inspector",
        "compiler-results",
        "anim-graph-graph",
        "anim-object-graph",
        "anim-graph-variables",
        "anim-graph-details",
        "anim-graph-compiler-results",
        "anim-graph-preview",
        "anim-graph-preview-values",
        "anim-state-graph",
      ].map((id) => [id, panel]),
    ),
  };
});

afterEach(cleanup);

function renderClassDock(initialLayout?: Record<string, unknown>) {
  let dock: DockviewApi | undefined;
  render(
    <DockviewShell
      documentKind="graph"
      actorPrefab={false}
      initialLayout={initialLayout ?? null}
      onReady={(api) => {
        dock = api;
      }}
    />,
  );
  return dock!;
}

describe("function graph tabs", () => {
  it("open as one focused tab beside the Event Graph", () => {
    const dock = renderClassDock();
    const eventGraph = dock.getPanel(EVENT_GRAPH_PANEL_ID)!;

    openFunctionGraphPanel(dock, "fn-jump", "Jump");
    openFunctionGraphPanel(dock, "fn-jump", "Jump High");

    const tabs = dock.panels.filter(
      (panel) => panel.id === functionGraphPanelId("fn-jump"),
    );
    expect(tabs).toHaveLength(1);
    const jump = tabs[0]!;
    expect(jump.group.id).toBe(eventGraph.group.id);
    expect(jump.title).toBe("Jump High");
    expect(jump.params).toEqual({ functionId: "fn-jump" });
    expect(dock.activePanel?.id).toBe(jump.id);
  });

  it("restore with their dock position from the saved layout", () => {
    const first = renderClassDock();
    openFunctionGraphPanel(first, "fn-jump", "Jump");
    first.getPanel(functionGraphPanelId("fn-jump"))!.api.moveTo({
      group: first.getPanel("inspector")!.group,
    });
    const saved = first.toJSON() as unknown as Record<string, unknown>;
    cleanup();

    const restored = renderClassDock(saved);
    const jump = restored.getPanel(functionGraphPanelId("fn-jump"))!;
    expect(jump.params).toEqual({ functionId: "fn-jump" });
    expect(jump.title).toBe("Jump");
    expect(jump.group.id).toBe(restored.getPanel("inspector")!.group.id);
  });

  it("show the Function icon on function tabs only, including restored ones", () => {
    const tabIcons = () =>
      Object.fromEntries(
        [...document.querySelectorAll(".dv-tab")].map((tab) => [
          tab.querySelector(".dv-default-tab-content")?.textContent,
          tab.querySelector("[data-tab-icon]")?.getAttribute("data-tab-icon") ?? null,
        ]),
      );
    const dock = renderClassDock();
    act(() => openFunctionGraphPanel(dock, "fn-jump", "Jump"));
    expect(tabIcons()).toMatchObject({ "Event Graph": null, Jump: "function", Inspector: null });
    // Close actions keep Dockview's own names, which say which tab they close.
    expect(document.querySelector('[role="button"][aria-label="Close Jump"]')).not.toBeNull();
    expect(document.querySelector('[role="button"][aria-label="Close Event Graph"]')).not.toBeNull();

    const saved = dock.toJSON() as unknown as Record<string, unknown>;
    cleanup();
    renderClassDock(saved);
    expect(tabIcons()).toMatchObject({ "Event Graph": null, Jump: "function" });
  });

  it("open beside another function when the Event Graph is closed", () => {
    const dock = renderClassDock();
    openFunctionGraphPanel(dock, "fn-jump", "Jump");
    dock.getPanel(EVENT_GRAPH_PANEL_ID)!.api.close();

    openFunctionGraphPanel(dock, "fn-land", "Land");

    expect(dock.getPanel(functionGraphPanelId("fn-land"))!.group.id).toBe(
      dock.getPanel(functionGraphPanelId("fn-jump"))!.group.id,
    );
  });
});

function renderAnimGraphDock(initialLayout?: Record<string, unknown>) {
  let dock: DockviewApi | undefined;
  render(
    <DockviewShell
      documentKind="anim-graph-3d"
      actorPrefab={false}
      initialLayout={initialLayout ?? null}
      onReady={(api) => {
        dock = api;
      }}
    />,
  );
  return dock!;
}

describe("Animation Graph state tabs", () => {
  it("open as one focused tab per state beside the State Machine, with the state icon, and restore from the layout", () => {
    const dock = renderAnimGraphDock();
    const machine = dock.getPanel(ANIM_STATE_MACHINE_PANEL_ID)!;
    act(() => {
      openAnimStateGraphPanel(dock, "run", "Run");
      openAnimStateGraphPanel(dock, "run", "Sprint");
    });
    const tabs = dock.panels.filter((panel) => panel.id === animStateGraphPanelId("run"));
    expect(tabs).toHaveLength(1);
    const run = tabs[0]!;
    expect(run.group.id).toBe(machine.group.id);
    expect(run.title).toBe("Sprint");
    expect(run.params).toEqual({ stateId: "run" });
    expect(dock.activePanel?.id).toBe(run.id);
    const icon = () =>
      [...document.querySelectorAll(".dv-tab")]
        .find((tab) => tab.querySelector(".dv-default-tab-content")?.textContent === "Sprint")
        ?.querySelector("[data-tab-icon]")
        ?.getAttribute("data-tab-icon");
    expect(icon()).toBe("state");

    const saved = dock.toJSON() as unknown as Record<string, unknown>;
    cleanup();
    const restored = renderAnimGraphDock(saved);
    expect(restored.getPanel(animStateGraphPanelId("run"))?.params).toEqual({ stateId: "run" });
    expect(icon()).toBe("state");
  });
});
