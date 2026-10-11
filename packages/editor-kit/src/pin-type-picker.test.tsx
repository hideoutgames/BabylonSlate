import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PinTypePicker } from "./pin-type-picker";

afterEach(cleanup);

describe("PinTypePicker", () => {
  it("names the stored type even when the picker does not offer it", () => {
    render(
      <PinTypePicker value="string" types={["bool", "int", "float"]} onChange={() => {}} />,
    );
    const trigger = screen.getByTestId("pin-type-picker");
    expect(trigger.textContent).toBe("String");
  });
});
