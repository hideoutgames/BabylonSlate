import type { DockviewApi } from "dockview";

export function createDefaultLayout(api: DockviewApi): void {
  const viewport = api.addPanel({
    id: "viewport",
    component: "viewport",
    title: "Viewport",
  });

  const graph = api.addPanel({
    id: "graph",
    component: "graph",
    title: "Graph",
    position: {
      referencePanel: viewport,
      direction: "below",
    },
    initialHeight: 280,
  });

  api.addPanel({
    id: "hierarchy",
    component: "hierarchy",
    title: "Hierarchy",
    position: {
      referencePanel: viewport,
      direction: "left",
    },
    initialWidth: 260,
  });

  api.addPanel({
    id: "inspector",
    component: "inspector",
    title: "Inspector",
    position: {
      referencePanel: viewport,
      direction: "right",
    },
    initialWidth: 280,
  });

  graph.api.setActive();
  viewport.api.setActive();
}
