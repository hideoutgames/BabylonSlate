import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi, IDockviewPanelProps } from "dockview-react";
import { DockviewShell } from "./dockview-shell";
import {
  EVENT_GRAPH_PANEL_ID,
  functionGraphPanelId,
  openFunctionGraphPanel,
} from "./function-graph-panels";

vi.mock("./use-platform-layout", () => ({
  usePlatformLayoutOptions: () => ({
    singleWindow: false,
    disableFloatingGroups: false,
    disablePopout: false,
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
