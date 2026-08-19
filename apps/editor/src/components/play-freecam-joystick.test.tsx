import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PlayFreeCamJoystick } from "./play-freecam-joystick";

afterEach(() => {
  cleanup();
});

describe("PlayFreeCamJoystick", () => {
  it("hides the fly stick while free cam is off", () => {
    const { queryByTestId } = render(
      <PlayFreeCamJoystick enabled={false} onFly={vi.fn()} />,
    );
    expect(queryByTestId("play-freecam-joystick")).toBeNull();
  });

  it("shows the fly stick while free cam is on", () => {
    const { getByTestId } = render(
      <PlayFreeCamJoystick enabled={true} onFly={vi.fn()} />,
    );
    expect(getByTestId("play-freecam-joystick")).not.toBeNull();
    expect(getByTestId("viewport-joystick")).not.toBeNull();
  });
});
