import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DebugInspectSnapshot } from "@babylonslate/object-model";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";
import { DebugInspectDialog } from "./debug-inspect-dialog";

const snapshot: DebugInspectSnapshot = {
  tickIndex: 4,
  nodes: [
    {
      id: "gi",
      kind: "gameInstance",
      label: "GameInstance",
      classId: "GameInstance",
      parentId: null,
      variables: { score: 1 },
    },
    {
      id: "hero",
      kind: "actor",
      label: "Hero",
      classId: "Actor",
      parentId: null,
      transform: {
        position: [1, 2, 3],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      variables: { health: 10, target: { guid: "a1", classId: "Actor" } },
    },
    {
      id: "mesh",
      kind: "component",
      label: "MeshComponent",
      classId: "MeshComponent",
      parentId: "hero",
      variables: { meshKind: "box" },
    },
  ],
};

function tapRow(id: string): void {
  const row = screen.getByTestId(`tree-row-${id}`);
  const tree = screen.getByTestId("debug-inspect-tree");
  act(() => {
    dispatchPointerEvent(row, "pointerdown", { clientX: 8, clientY: 8 });
    dispatchPointerEvent(tree, "pointerup", { clientX: 8, clientY: 8 });
  });
}

describe("DebugInspectDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens as a CatalogDialog-sized overlay with search and a read-only tree", () => {
    render(
      <DebugInspectDialog open onOpenChange={() => {}} snapshot={snapshot} />,
    );

    const root = screen.getByTestId("debug-inspect");
    expect(root.getAttribute("data-slot")).toBe("dialog-content");
    expect(root.className).toContain("h-[min(90vh,52rem)]");
    expect(root.className).toContain("w-[min(96vw,64rem)]");
    expect(root.className).toContain("max-w-none");
    expect(root.className).not.toContain("sm:max-w-lg");
    expect(screen.getByTestId("debug-inspect-tick").getAttribute("data-tick")).toBe(
      "4",
    );
    expect(screen.getByTestId("debug-inspect-search")).toBeTruthy();
    expect(screen.getByTestId("debug-inspect-search").hasAttribute("autofocus")).toBe(
      false,
    );
    expect(screen.getByTestId("debug-inspect-tree")).toBeTruthy();
    expect(screen.getByTestId("tree-row-gi").textContent).toContain(
      "GameInstance",
    );
    expect(screen.getByTestId("tree-row-hero").textContent).toContain("Hero");
    expect(screen.getByTestId("tree-row-mesh").textContent).toContain(
      "MeshComponent",
    );
    expect(screen.getByTestId("debug-inspect-empty")).toBeTruthy();
  });

  it("filters the tree by name, class, or guid and keeps ancestors", () => {
    render(
      <DebugInspectDialog open onOpenChange={() => {}} snapshot={snapshot} />,
    );
    fireEvent.change(screen.getByTestId("debug-inspect-search"), {
      target: { value: "mesh" },
    });
    expect(screen.getByTestId("tree-row-hero")).toBeTruthy();
    expect(screen.getByTestId("tree-row-mesh")).toBeTruthy();
    expect(screen.queryByTestId("tree-row-gi")).toBeNull();
  });

  it("shows identity, transform, and SelectableText variables for the selection", () => {
    render(
      <DebugInspectDialog open onOpenChange={() => {}} snapshot={snapshot} />,
    );
    tapRow("hero");
    expect(screen.queryByTestId("debug-inspect-empty")).toBeNull();
    const details = screen.getByTestId("debug-inspect-details");
    expect(details.textContent).toContain("Hero");
    expect(details.textContent).toContain("hero");
    expect(details.textContent).toContain("Actor");
    expect(screen.getByText("GUID")).toBeTruthy();
    expect(screen.queryByText("Guid")).toBeNull();
    expect(details.textContent).toContain("1, 2, 3");
    expect(screen.getByTestId("debug-inspect-var-health").textContent).toContain(
      "10",
    );
    expect(screen.getByTestId("debug-inspect-var-target").textContent).toContain(
      "Actor(a1)",
    );
    expect(details.querySelector("input")).toBeNull();
  });

  it("keeps the selection across snapshot updates and clears when the guid is gone", () => {
    const { rerender } = render(
      <DebugInspectDialog open onOpenChange={() => {}} snapshot={snapshot} />,
    );
    tapRow("hero");
    rerender(
      <DebugInspectDialog
        open
        onOpenChange={() => {}}
        snapshot={{
          tickIndex: 5,
          nodes: [
            {
              ...snapshot.nodes[1]!,
              variables: { health: 11 },
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("debug-inspect-tick").getAttribute("data-tick")).toBe(
      "5",
    );
    expect(screen.getByTestId("debug-inspect-var-health").textContent).toContain(
      "11",
    );

    rerender(
      <DebugInspectDialog
        open
        onOpenChange={() => {}}
        snapshot={{ tickIndex: 6, nodes: [] }}
      />,
    );
    expect(screen.getByTestId("debug-inspect-empty")).toBeTruthy();
    expect(screen.queryByTestId("debug-inspect-details")).toBeNull();
  });
});
