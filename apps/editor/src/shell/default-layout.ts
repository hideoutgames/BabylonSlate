import type { DockviewApi } from "dockview-react";

export type DockviewDocumentKind = "scene" | "graph";

export function createSceneDefaultLayout(api: DockviewApi): void {
  const viewport = api.addPanel({
    id: "viewport",
    component: "viewport",
    title: "Viewport",
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

  viewport.api.setActive();
}

export function createGraphDefaultLayout(api: DockviewApi): void {
  const graph = api.addPanel({
    id: "graph",
    component: "graph",
    title: "Graph",
  });

  api.addPanel({
    id: "inspector",
    component: "inspector",
    title: "Inspector",
    position: {
      referencePanel: graph,
      direction: "right",
    },
    initialWidth: 280,
  });

  graph.api.setActive();
}

export function createDefaultLayoutForKind(
  api: DockviewApi,
  kind: DockviewDocumentKind,
): void {
  if (kind === "scene") {
    createSceneDefaultLayout(api);
  } else {
    createGraphDefaultLayout(api);
  }
}
