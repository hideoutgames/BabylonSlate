import type { DockviewApi } from "dockview-react";

export type DockviewDocumentKind = "scene" | "graph";

export function createSceneDefaultLayout(api: DockviewApi): void {
  const viewport = api.addPanel({
    id: "viewport",
    component: "viewport",
    title: "Viewport",
  });

  api.addPanel({
    id: "scene-outliner",
    component: "scene-outliner",
    title: "Outliner",
    position: {
      referencePanel: viewport,
      direction: "left",
    },
    initialWidth: 260,
  });

  api.addPanel({
    id: "scene-details",
    component: "scene-details",
    title: "Details",
    position: {
      referencePanel: viewport,
      direction: "right",
    },
    initialWidth: 300,
  });

  api.addPanel({
    id: "output-log",
    component: "output-log",
    title: "Output Log",
    position: {
      referencePanel: viewport,
      direction: "below",
    },
    initialHeight: 160,
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
    id: "prefab-viewport",
    component: "prefab-viewport",
    title: "Prefab",
    position: {
      referencePanel: graph,
      direction: "within",
    },
  });

  const myClass = api.addPanel({
    id: "my-class",
    component: "my-class",
    title: "My Class",
    position: {
      referencePanel: graph,
      direction: "left",
    },
    initialWidth: 260,
  });

  api.addPanel({
    id: "actor-prefab",
    component: "actor-prefab",
    title: "Components",
    position: {
      referencePanel: myClass,
      direction: "within",
    },
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

  api.addPanel({
    id: "compiler-results",
    component: "compiler-results",
    title: "Compiler Results",
    position: {
      referencePanel: graph,
      direction: "below",
    },
    initialHeight: 160,
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
