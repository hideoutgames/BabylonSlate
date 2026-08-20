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

  it("offers Validated Get for instance variables", () => {
    const onChoose = vi.fn();
    render(
      <MemberAccessChooser
        open
        memberName="Target"
        showValidatedGet
        onOpenChange={() => {}}
        onChoose={onChoose}
      />,
    );
    screen.getByTestId("member-access-validated-get").click();
    expect(onChoose).toHaveBeenCalledWith("validatedGet");
  });

  it("hides Validated Get for non-instance variables", () => {
    render(
      <MemberAccessChooser
        open
        memberName="Health"
        onOpenChange={() => {}}
        onChoose={() => {}}
      />,
    );
    expect(screen.queryByTestId("member-access-validated-get")).toBeNull();
  });
});
