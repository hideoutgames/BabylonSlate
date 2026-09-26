import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModuleCard, ModuleStack, ModuleStage } from "./module-stack";

// Base UI dispatches PointerEvent when activating its native switch input.
if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(() => {
  cleanup();
});

describe("ModuleCard", () => {
  it("renders always-on modules without a switch and toggles their body from the header", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ModuleStack>
        <ModuleStage id="spawn" title="Spawn" accentRole="event">
          <ModuleCard id="emitter" title="Emitter" open={false} onOpenChange={onOpenChange} summary="No Material">
            <p>Material Rows</p>
          </ModuleCard>
        </ModuleStage>
      </ModuleStack>,
    );

    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Material Rows")).toBeNull();
    expect(screen.getByTestId("module-card-emitter-summary").textContent).toBe("No Material");
    fireEvent.click(screen.getByRole("button", { name: "Emitter" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);

    rerender(
      <ModuleCard id="emitter" title="Emitter" open onOpenChange={onOpenChange} summary="No Material">
        <p>Material Rows</p>
      </ModuleCard>,
    );
    expect(screen.getByText("Material Rows")).toBeTruthy();
    expect(screen.queryByTestId("module-card-emitter-summary")).toBeNull();
  });

  it("collapses a disabled module, keeps its header inert, and reports switch changes", () => {
    const onEnabledChange = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ModuleCard
        id="bursts"
        title="Bursts"
        open
        onOpenChange={onOpenChange}
        enabled
        onEnabledChange={onEnabledChange}
        summary="2 Bursts"
      >
        <p>Burst Rows</p>
      </ModuleCard>,
    );

    expect(screen.getByText("Burst Rows")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Bursts Enabled" }));
    expect(onEnabledChange).toHaveBeenCalledWith(false);

    // Hosts keep the card's open state; disabling still collapses it.
    rerender(
      <ModuleCard
        id="bursts"
        title="Bursts"
        open
        onOpenChange={onOpenChange}
        enabled={false}
        onEnabledChange={onEnabledChange}
        summary="2 Bursts"
      >
        <p>Burst Rows</p>
      </ModuleCard>,
    );

    const header = screen.getByTestId("module-card-bursts-toggle");
    expect(screen.queryByText("Burst Rows")).toBeNull();
    expect(screen.queryByTestId("module-card-bursts-body")).toBeNull();
    expect(screen.queryByTestId("module-card-bursts-summary")).toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect((header as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(header);
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("switch", { name: "Bursts Enabled" }));
    expect(onEnabledChange).toHaveBeenLastCalledWith(true);
  });
});
