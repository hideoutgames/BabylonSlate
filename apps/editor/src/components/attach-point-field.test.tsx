import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AttachPointField } from "./attach-point-field";
import { skeletonAttachPoints } from "../lib/skeleton-attach-points";

afterEach(cleanup);

const assets = [
  { header: { guid: "rig", name: "Hero_Skeleton", type: "Skeleton", payload: { bones: [{ name: "hand_r" }], sockets: [{ name: "Grip", bone: "hand_r" }] } } },
  { header: { guid: "empty", name: "Empty_Skeleton", type: "Skeleton", payload: { bones: [] } } },
  { header: { guid: "large", name: "Large_Skeleton", type: "Skeleton", payload: { bones: [{ name: "hips" }] } } },
  { header: { guid: "hero", name: "Hero", type: "Model", payload: {} } },
];

describe("skeletonAttachPoints", () => {
  it("lists each Skeleton with bones or sockets by name", () => {
    expect(skeletonAttachPoints(assets)).toEqual([
      { skeletonGuid: "rig", skeletonName: "Hero_Skeleton", bones: ["hand_r"], sockets: ["Grip"] },
      { skeletonGuid: "large", skeletonName: "Large_Skeleton", bones: ["hips"], sockets: [] },
    ]);
  });
});

describe("AttachPointField", () => {
  it("picks a socket or bone from the list, grouped by Skeleton, or takes a typed name", () => {
    const onChange = vi.fn();
    render(
      <AttachPointField id="bone" label="Bone" value="" groups={skeletonAttachPoints(assets)} onChange={onChange} data-testid="field" />,
    );
    fireEvent.click(screen.getByTestId("field-pick"));
    const picker = screen.getByTestId("field-picker");
    expect(picker.textContent).toContain("Hero_Skeleton");
    expect(picker.textContent).toContain("Large_Skeleton");
    fireEvent.click(screen.getByText("Grip"));
    expect(onChange).toHaveBeenLastCalledWith("Grip");

    const input = screen.getByRole("textbox", { name: "Bone" });
    fireEvent.change(input, { target: { value: " spine " } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith("spine");
  });
});
