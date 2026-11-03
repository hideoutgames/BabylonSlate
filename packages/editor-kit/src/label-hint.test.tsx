import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@haptic/ui/components/tooltip";
import { PropertyGrid, type PropertyRow } from "./property-grid";

afterEach(() => cleanup());

const HINT = "Seconds a particle lives.";

function grid(onChange = vi.fn()) {
  const rows: PropertyRow[] = [
    { id: "lifetime", kind: "number", label: "Lifetime", value: 1, description: HINT, onChange },
    { id: "loop", kind: "boolean", label: "Loop", value: false, description: "Starts again when it ends.", onChange },
  ];
  render(
    <TooltipProvider>
      <PropertyGrid rows={rows} />
    </TooltipProvider>,
  );
  return onChange;
}

/** Text the sighted user can see: everything outside visually hidden descriptions. */
function visibleText(): string {
  const root = screen.getByTestId("property-row-lifetime").cloneNode(true) as HTMLElement;
  for (const hidden of root.querySelectorAll(".sr-only")) hidden.remove();
  return root.textContent ?? "";
}

describe("PropertyGrid row descriptions", () => {
  it("are not visible text under the row; screen readers keep them", () => {
    grid();
    expect(visibleText()).not.toContain(HINT);
    expect(screen.getByText(HINT).className).toContain("sr-only");
    expect(screen.getByText("Lifetime").closest("[data-label-hint]")).toBeTruthy();
  });

  it("open as the label's tooltip on a touch tap, which neither focuses nor toggles the control", () => {
    const onChange = grid();
    const label = screen.getByText("Loop").closest("[data-label-hint]")!;
    const open = () => document.querySelector('[data-slot="tooltip-content"][data-open]');
    fireEvent.pointerDown(label, { pointerType: "touch" });
    fireEvent.click(label);
    expect(open()?.textContent).toBe("Starts again when it ends.");
    expect(onChange).not.toHaveBeenCalled();
    // A second tap closes it.
    fireEvent.pointerDown(label, { pointerType: "touch" });
    fireEvent.click(label);
    expect(open()).toBeNull();
  });
});
