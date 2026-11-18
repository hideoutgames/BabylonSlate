import { afterEach, describe, expect, it } from "vitest";
import { createDockview, type DockviewApi } from "dockview-react";

// Closing a docked window gives its space to the window that shared its sash; every other window keeps its size.
// The patched dockview-core (`patches/dockview-core@8.5.1.patch`) does this for every close path, since all of them
// remove the empty group through dockview.

type Node =
  | { type: "leaf"; id: string; size: number }
  | { type: "branch"; size: number; children: Node[] };

const leaf = (id: string, size: number): Node => ({ type: "leaf", id, size });

/**
 * One row, 1200×600: L | M1 over M2 | C | N1 over N2 over N3 | R.
 * Widths 150, 300, 250, 250, 250; M heights 250, 350; N heights 100, 150, 350.
 */
const layout: Node = {
  type: "branch",
  size: 600,
  children: [
    leaf("L", 150),
    { type: "branch", size: 300, children: [leaf("M1", 250), leaf("M2", 350)] },
    leaf("C", 250),
    { type: "branch", size: 250, children: [leaf("N1", 100), leaf("N2", 150), leaf("N3", 350)] },
    leaf("R", 250),
  ],
};

function serialize(node: Node): unknown {
  if (node.type === "leaf") {
    return { type: "leaf", size: node.size, data: { id: `group-${node.id}`, views: [node.id], activeView: node.id } };
  }
  return { type: "branch", size: node.size, data: node.children.map(serialize) };
}

function leafIds(node: Node): string[] {
  return node.type === "leaf" ? [node.id] : node.children.flatMap(leafIds);
}

let disposeDock: (() => void) | undefined;
afterEach(() => disposeDock?.());

function mountDock(): DockviewApi {
  const host = document.createElement("div");
  document.body.append(host);
  const api = createDockview(host, {
    createComponent: () => ({ element: document.createElement("div"), init() {} }),
  });
  disposeDock = () => {
    api.dispose();
    host.remove();
  };
  api.layout(1200, 600);
  api.fromJSON({
    grid: { root: serialize(layout), width: 1200, height: 600, orientation: "HORIZONTAL" },
    panels: Object.fromEntries(leafIds(layout).map((id) => [id, { id, contentComponent: "window", title: id }])),
  } as never);
  return api;
}

/** Each open window's group size as `width×height`. */
function sizes(api: DockviewApi): Record<string, string> {
  const result: Record<string, string> = {};
  for (const panel of api.panels) result[panel.id] = `${panel.group.api.width}×${panel.group.api.height}`;
  return result;
}

const initial = {
  L: "150×600",
  M1: "300×250",
  M2: "300×350",
  C: "250×600",
  N1: "250×100",
  N2: "250×150",
  N3: "250×350",
  R: "250×600",
};

describe("closing a docked window", () => {
  it("loads the layout with the sizes the tests start from", () => {
    expect(sizes(mountDock())).toEqual(initial);
  });

  it("gives the last column's width to the column before it", () => {
    const api = mountDock();
    api.getPanel("R")!.api.close();
    expect(sizes(api)).toEqual({ ...initial, N1: "500×100", N2: "500×150", N3: "500×350", R: undefined });
  });

  it("gives the first column's width to the column after it", () => {
    const api = mountDock();
    api.getPanel("L")!.api.close();
    expect(sizes(api)).toEqual({ ...initial, L: undefined, M1: "450×250", M2: "450×350" });
  });

  it("gives a middle column's width to the column before it", () => {
    const api = mountDock();
    api.getPanel("C")!.api.close();
    expect(sizes(api)).toEqual({ ...initial, C: undefined, M1: "550×250", M2: "550×350" });
  });

  it("passes width the neighbour cannot take to the next nearest column", () => {
    const api = mountDock();
    for (const id of ["M1", "M2"]) api.getPanel(id)!.group.api.setConstraints({ maximumWidth: 350 });
    api.getPanel("C")!.api.close();
    expect(sizes(api)).toEqual({
      ...initial, C: undefined, M1: "350×250", M2: "350×350", N1: "450×100", N2: "450×150", N3: "450×350",
    });
  });

  it("gives a stacked window's height to the window above it", () => {
    const api = mountDock();
    api.getPanel("N2")!.api.close();
    expect(sizes(api)).toEqual({ ...initial, N1: "250×250", N2: undefined });
  });

  it("gives the top stacked window's height to the window below it", () => {
    const api = mountDock();
    api.getPanel("N1")!.api.close();
    expect(sizes(api)).toEqual({ ...initial, N1: undefined, N2: "250×250" });
  });

  it("keeps the other column's sizes when a two-window column folds into one", () => {
    const api = mountDock();
    api.getPanel("M2")!.api.close();
    expect(sizes(api)).toEqual({ ...initial, M1: "300×600", M2: undefined });
  });

  it("keeps the untouched windows' sizes when a window moves under another", () => {
    const api = mountDock();
    const target = api.getPanel("C")!.group;
    api.getPanel("R")!.api.moveTo({ group: target, position: "bottom" });
    const after = sizes(api);
    expect(after).toMatchObject({ L: "150×600", M1: "300×250", M2: "300×350", N1: "500×100", N2: "500×150", N3: "500×350" });
    expect(after.C).toBe("250×300");
    expect(after.R).toBe("250×300");
  });
});
