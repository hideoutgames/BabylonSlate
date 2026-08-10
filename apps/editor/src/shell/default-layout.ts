import type { DockviewApi } from "dockview";
import type { DocumentKind } from "@babylonslate/shared";

export function createSceneDefaultLayout(api: DockviewApi): void {
  const viewport = api.addPanel({
    id: "viewport",
    component: "viewport",
    title: "Viewport",
  });

  api.addPanel({
    id: "content",
    component: "content",
    title: "Content",
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

  viewport.api.setActive();
}

export function createGraphDefaultLayout(api: DockviewApi): void {
  const graph = api.addPanel({
    id: "graph",
    component: "graph",
    title: "Graph",
  });

  api.addPanel({
    id: "content",
    component: "content",
    title: "Content",
    position: {
      referencePanel: graph,
      direction: "left",
    },
    initialWidth: 260,
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
  kind: DocumentKind,
): void {
  if (kind === "scene") {
    createSceneDefaultLayout(api);
  } else {
    createGraphDefaultLayout(api);
  }
}
