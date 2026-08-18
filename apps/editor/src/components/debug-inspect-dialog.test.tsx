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
      variables: {
        health: 10,
        alive: true,
        target: { guid: "a1", classId: "Actor" },
      },
      variableTypes: { health: "float", alive: "bool" },
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

  it("shows identity, transform, and disabled typed variable rows", () => {
    render(
      <DebugInspectDialog open onOpenChange={() => {}} snapshot={snapshot} />,
    );
    tapRow("hero");
    expect(screen.queryByTestId("debug-inspect-empty")).toBeNull();
    expect(screen.getByTestId("debug-inspect-details")).toBeTruthy();
    expect((screen.getByTestId("property-name") as HTMLInputElement).value).toBe(
      "Hero",
    );
    expect((screen.getByTestId("property-class") as HTMLInputElement).value).toBe(
      "Actor",
    );
    expect((screen.getByTestId("property-guid") as HTMLInputElement).value).toBe(
      "hero",
    );
    expect((screen.getByTestId("property-name") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("GUID")).toBeTruthy();
    expect(screen.queryByText("Guid")).toBeNull();

    const health = screen.getByTestId("property-health") as HTMLInputElement;
    expect(screen.getByTestId("debug-inspect-var-health")).toBeTruthy();
    expect(health.disabled).toBe(true);
    expect(health.value).toBe("10");

    const aliveRow = screen.getByTestId("debug-inspect-var-alive");
    expect(aliveRow.getAttribute("data-disabled")).toBe("true");
    const alive = screen.getByTestId("property-alive");
    expect(alive.getAttribute("aria-disabled")).toBe("true");
    expect(alive.getAttribute("data-checked")).not.toBeNull();
    const checked = alive.getAttribute("data-checked");
    fireEvent.click(alive);
    expect(alive.getAttribute("data-checked")).toBe(checked);

    const target = screen.getByTestId("debug-inspect-var-target");
    expect(target.textContent).toContain("Actor");
    expect(target.textContent).toContain("a1");
    expect(target.textContent).not.toContain("Actor(a1)");
    expect((screen.getByTestId("property-target") as HTMLButtonElement).disabled).toBe(
      true,
    );

    expect(
      (screen.getByTestId("property-position-x") as HTMLInputElement).value,
    ).toBe("1");
    expect(
      (screen.getByTestId("property-position-y") as HTMLInputElement).value,
    ).toBe("2");
    expect(
      (screen.getByTestId("property-position-z") as HTMLInputElement).value,
    ).toBe("3");
    expect(
      (screen.getByTestId("property-rotation-w") as HTMLInputElement).value,
    ).toBe("1");
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
    const health = screen.getByTestId("property-health") as HTMLInputElement;
    expect(health.disabled).toBe(true);
    expect(health.value).toBe("11");

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
