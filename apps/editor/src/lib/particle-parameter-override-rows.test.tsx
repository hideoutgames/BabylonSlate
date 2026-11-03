import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ParticleSystemParameter } from "@haptic/assets";
import type { SerializedComponent } from "@haptic/core";
import { PropertyGrid } from "@haptic/editor-kit";
import { particleParameterOverrideRows } from "./particle-parameter-override-rows";

if (typeof window !== "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, writable: true, value: PointerEventPolyfill });
}

afterEach(() => cleanup());

const parameters: ParticleSystemParameter[] = [
  { name: "Heat", type: "float", defaultValue: [2], overridden: false, slots: [0] },
  { name: "Tint", type: "color", defaultValue: [1, 1, 1, 1], overridden: true, slots: [0, 1] },
];

function renderRows(overrides: Record<string, number[]>) {
  const component: SerializedComponent = { id: "sparks", classId: "ParticleComponent",
    properties: { particleSystemGuid: "system", parameterOverrides: overrides } };
  const update = vi.fn();
  render(<PropertyGrid rows={particleParameterOverrideRows("actor", component, parameters, update)} />);
  return update;
}

describe("Particle component Parameters rows", () => {
  it("shows each System parameter at its default and overrides it when checked or edited", () => {
    const update = renderRows({});
    const heat = screen.getByTestId("property-actor-sparks-parameter-Heat") as HTMLInputElement;
    expect(heat.value).toBe("2");
    expect((screen.getByRole("checkbox", { name: "Override Heat" }) as HTMLElement).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("checkbox", { name: "Override Heat" }));
    expect(update).toHaveBeenLastCalledWith("parameterOverrides", { Heat: [2] });
    fireEvent.change(heat, { target: { value: "3" } });
    fireEvent.blur(heat);
    expect(update).toHaveBeenLastCalledWith("parameterOverrides", { Heat: [3] });
  });

  it("edits an override and drops it when Override is cleared, keeping the others", () => {
    const update = renderRows({ Heat: [5], Gone: [1] });
    const heat = screen.getByTestId("property-actor-sparks-parameter-Heat") as HTMLInputElement;
    expect(heat.value).toBe("5");
    fireEvent.change(heat, { target: { value: "7" } });
    fireEvent.blur(heat);
    expect(update).toHaveBeenLastCalledWith("parameterOverrides", { Heat: [7], Gone: [1] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Override Heat" }));
    // An override for a name the System no longer declares stays.
    expect(update).toHaveBeenLastCalledWith("parameterOverrides", { Gone: [1] });
  });
});
