import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { normalizeFocusNavigationSettings, type FocusNavigationSettings } from "@babylonslate/core";
import { FocusNavigationFields } from "./focus-navigation-fields";

// Base UI dispatches PointerEvent when activating its native switch input.
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
}

afterEach(cleanup);
describe("focus navigation settings", () => {
  it("selects only 2D navigation axes, preserves the selection while disabled, and restores built-in controls", () => {
    let saved: FocusNavigationSettings | undefined;
    function Editor() {
      const [value, setValue] = useState(normalizeFocusNavigationSettings());
      return <FocusNavigationFields value={value} onChange={(next) => { saved = next; setValue(next); }} assets={[
        { guid: "nav", name: "Menu Movement", type: "InputAxis", path: "assets/Menu.babasset", valueType: "2d" },
        { guid: "zoom", name: "Zoom", type: "InputAxis", path: "assets/Zoom.babasset", valueType: "1d" },
        { guid: "accept", name: "Accept", type: "InputAction", path: "assets/Accept.babasset" },
      ]} />;
    }
    render(<Editor />);
    fireEvent.click(screen.getByTestId("property-settings-focus-navigationInputGuid"));
    expect(screen.queryByText("Zoom")).toBeNull();
    expect(screen.queryByText("Accept")).toBeNull();
    fireEvent.click(screen.getByText("Menu Movement"));
    expect(saved?.navigationInputGuid).toBe("nav");
    fireEvent.click(screen.getByRole("checkbox", { name: "Focus Navigation" }));
    expect(saved).toMatchObject({ enabled: false, navigationInputGuid: "nav" });
    expect(screen.getByTestId("property-settings-focus-navigationInputGuid")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Focus Navigation" }));
    fireEvent.click(screen.getByTestId("property-settings-focus-navigationInputGuid"));
    fireEvent.click(screen.getByText("None"));
    expect(saved).toMatchObject({ enabled: true, navigationInputGuid: null });
  });
});
