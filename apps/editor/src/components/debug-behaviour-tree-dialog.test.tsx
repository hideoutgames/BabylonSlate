import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DebugBehaviourTreeDialog } from "./debug-behaviour-tree-dialog";

afterEach(cleanup);

const patrol = {
  actorGuid: "guard",
  actorName: "Guard",
  treeGuid: "patrol",
  treeName: "Patrol",
  slotId: 1,
  status: "running" as const,
  btNodeId: "move",
  lastResults: { move: "running" },
  blackboard: { Goal: "Gate" },
  stack: [{ nodeId: "root", childIndex: 0, opened: true }],
  nodes: [
    {
      id: "root",
      kind: "sequence",
      classId: "Sequence",
      children: ["move"],
      decorators: [],
      services: [],
    },
    {
      id: "move",
      kind: "task",
      classId: "Move To",
      children: [],
      decorators: [],
      services: [],
    },
  ],
};

describe("behaviour tree debugger", () => {
  it("shows actor/tree identity, active logic and current blackboard, and clears removed trees", () => {
    const view = render(
      <DebugBehaviourTreeDialog open onOpenChange={vi.fn()} trees={[patrol]} />,
    );
    expect(
      view.getByRole("combobox", { name: "Behaviour Tree" }).textContent,
    ).toContain("Guard (Patrol)");
    expect(view.getByText("Move To")).toBeTruthy();
    expect(view.getByText('"Gate"')).toBeTruthy();
    expect(
      view.getByTestId("bt-debug-node-move").getAttribute("data-active"),
    ).toBe("true");
    view.rerender(
      <DebugBehaviourTreeDialog open onOpenChange={vi.fn()} trees={[]} />,
    );
    expect(view.getByText("No Running Behaviour Trees")).toBeTruthy();
    expect(view.queryByText('"Gate"')).toBeNull();
  });

  it("switches between actors running the same tree without mixing blackboards", async () => {
    const view = render(
      <DebugBehaviourTreeDialog
        open
        onOpenChange={vi.fn()}
        trees={[
          patrol,
          {
            ...patrol,
            actorGuid: "scout",
            actorName: "Scout",
            slotId: 2,
            blackboard: { Goal: "Tower" },
          },
        ]}
      />,
    );
    fireEvent.click(view.getByRole("combobox", { name: "Behaviour Tree" }));
    const option = await view.findByRole("option", { name: "Scout (Patrol)" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    expect(view.getByText('"Tower"')).toBeTruthy();
    expect(view.queryByText('"Gate"')).toBeNull();
  });
});
