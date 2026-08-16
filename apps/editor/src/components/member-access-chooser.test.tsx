import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemberAccessChooser } from "./member-access-chooser";

afterEach(() => {
  cleanup();
});

describe("MemberAccessChooser", () => {
  it("offers Get and Set for the dropped variable", () => {
    const onChoose = vi.fn();
    render(
      <MemberAccessChooser
        open
        memberName="Health"
        onOpenChange={() => {}}
        onChoose={onChoose}
      />,
    );
    const dialog = screen.getByTestId("member-access-chooser");
    expect(dialog.textContent).toContain("Health");
    screen.getByTestId("member-access-get").click();
    expect(onChoose).toHaveBeenCalledWith("get");
    screen.getByTestId("member-access-set").click();
    expect(onChoose).toHaveBeenCalledWith("set");
  });
});
