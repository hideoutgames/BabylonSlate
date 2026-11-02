import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AnimationEditor } from "./animation-editor";

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(),
);

afterEach(() => {
  cleanup();
});

const durationInput = () => screen.getByTestId("property-durationMs") as HTMLInputElement;

describe("AnimationEditor", () => {
  it("edits Duration and keeps the clip's length as the reset default", () => {
    const onChange = vi.fn();
    render(
      <AnimationEditor
        payload={{ clipName: "Walk", modelGuid: "hero", durationMs: 1000, clipDurationMs: 1000 }}
        onChange={onChange}
      />,
    );
    fireEvent.change(durationInput(), { target: { value: "1500" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ clipName: "Walk", modelGuid: "hero", durationMs: 1500, clipDurationMs: 1000 }),
      expect.any(String),
    );
  });

  it("resets an authored Duration to the clip's length", () => {
    const onChange = vi.fn();
    render(
      <AnimationEditor
        payload={{ clipName: "Walk", modelGuid: "hero", durationMs: 2500, clipDurationMs: 1000 }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset Duration" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ durationMs: 1000, clipDurationMs: 1000 }),
      expect.any(String),
    );
  });

  it("shows Duration read-only without an owner to write it", () => {
    render(<AnimationEditor payload={{ clipName: "Walk", modelGuid: "hero", durationMs: 1000 }} />);
    expect(durationInput().disabled).toBe(true);
  });
});
