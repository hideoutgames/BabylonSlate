import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AnimationEventsEditor, type EditableAnimationEvent } from "./animation-events-editor";

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    assetRegistry: { list: () => [], getByGuid: () => undefined },
  })),
);

afterEach(cleanup);

const dust: EditableAnimationEvent = {
  id: "e1",
  name: "Dust",
  triggerWeight: 0.5,
  timeMs: 0,
  durationMs: 0,
  action: { kind: "spawnParticles", assetGuid: "", bone: "foot_old" },
};

describe("AnimationEventsEditor", () => {
  it("offers the Skeleton's sockets and bones for Spawn Particle System, keeping an unknown name marked", () => {
    const onChange = vi.fn();
    render(
      <AnimationEventsEditor
        events={[dust]}
        timed
        bones
        attachPoints={{ bones: ["hips", "foot_l"], sockets: ["Heel"] }}
        mergeKeyPrefix="animation:event"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Bone" }));
    const labels = screen.getAllByRole("option").map((option) => option.textContent);
    expect(labels).toEqual(["None", "foot_old (Not On Skeleton)", "Heel", "hips", "foot_l"]);
    const heel = screen.getByRole("option", { name: "Heel" });
    fireEvent.pointerDown(heel);
    fireEvent.click(heel);
    expect(onChange.mock.calls.at(-1)![0][0].action).toEqual({ kind: "spawnParticles", assetGuid: "", bone: "Heel" });
  });

  it("types the bone name when the Animation has no Skeleton", () => {
    render(<AnimationEventsEditor events={[dust]} timed bones mergeKeyPrefix="animation:event" onChange={vi.fn()} />);
    expect(screen.queryByRole("combobox", { name: "Bone" })).toBeNull();
    expect(screen.getByDisplayValue("foot_old")).toBeTruthy();
  });
});
