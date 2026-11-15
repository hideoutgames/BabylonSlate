import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { LayeredBlendBranchFilters } from "./layered-blend-branch-filters";
import { layeredBlendBranchLists } from "../lib/layered-blend-branches";

afterEach(cleanup);

describe("Layered Blend Per Bone branch filters", () => {
  it("adds a branch from the Skeleton's bones, offers only bones not yet listed, and removes one", () => {
    let saved: Record<string, unknown> = { count: 2, layers: [{ branches: [{ bone: "spine_01", blendDepth: 2 }] }] };
    function Editor() {
      const [data, setData] = useState(saved);
      return (
        <LayeredBlendBranchFilters
          data={data}
          bones={["root", "spine_01", "head"]}
          onPatch={(patch) => {
            saved = { ...data, ...patch };
            setData(saved);
          }}
        />
      );
    }
    render(<Editor />);
    expect(screen.getByText("Blend Pose 0 Branches")).toBeTruthy();
    expect(screen.getByText("Blend Pose 1 Branches")).toBeTruthy();
    // Bone names show as they are, not reworded.
    expect(screen.getByText("spine_01")).toBeTruthy();
    fireEvent.click(screen.getByTestId("layered-blend-branch-add-0"));
    const picker = screen.getByTestId("layered-blend-branch-picker");
    expect(picker.textContent).toContain("head");
    expect(picker.textContent).not.toContain("spine_01");
    fireEvent.click(screen.getByText("head"));
    expect(layeredBlendBranchLists(saved)).toEqual([
      [{ bone: "spine_01", blendDepth: 2 }, { bone: "head", blendDepth: 0 }],
      [],
    ]);
    fireEvent.click(screen.getByTestId("layered-blend-branch-remove-0-0"));
    expect(layeredBlendBranchLists(saved)).toEqual([[{ bone: "head", blendDepth: 0 }], []]);
  });

  it("asks for the graph's Skeleton when it has no bones to pick", () => {
    render(<LayeredBlendBranchFilters data={{}} bones={[]} onPatch={() => undefined} />);
    expect((screen.getByTestId("layered-blend-branch-add-0") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Set the graph's Skeleton to pick bones.")).toBeTruthy();
  });
});
