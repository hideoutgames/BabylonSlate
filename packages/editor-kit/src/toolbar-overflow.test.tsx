import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NestedMenuItem } from "./nested-menu";
import {
  ToolbarOverflow,
  ToolbarOverflowItem,
  ToolbarOverflowMenu,
  ToolbarOverflowTrack,
} from "./toolbar-overflow";

// jsdom has no layout: a track's content width is the sum of its visible controls' `data-w`,
// against the track's `data-limit`.
function installLayout() {
  const hidden = (element: Element) => Boolean(element.closest<HTMLElement>('[style*="display: none"]'));
  const contentWidth = (track: HTMLElement) =>
    Array.from(track.querySelectorAll<HTMLElement>("[data-w]"))
      .filter((control) => !hidden(control))
      .reduce((sum, control) => sum + Number(control.dataset.w), 0);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-overflow-track") ? contentWidth(this) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return Number(this.dataset.limit ?? 0);
  });
}

const entry = (id: string, label: string, extra: Partial<Extract<NestedMenuItem, { type?: "item" }>> = {}): NestedMenuItem[] => [
  { id, label, onSelect: vi.fn(), ...extra },
];

function Bar({ limit, undoDisabled = false }: { limit: number; undoDisabled?: boolean }) {
  return (
    <ToolbarOverflow>
      <ToolbarOverflowTrack data-testid="track" data-limit={limit}>
        <button type="button" data-w="40">Save</button>
        <ToolbarOverflowItem id="undo" priority={1} items={entry("undo", "Undo", { shortcut: "Mod+Z", disabled: undoDisabled })}>
          <button type="button" data-w="40">Undo</button>
        </ToolbarOverflowItem>
        <ToolbarOverflowItem id="redo" priority={1} items={entry("redo", "Redo")}>
          <button type="button" data-w="40">Redo</button>
        </ToolbarOverflowItem>
        <ToolbarOverflowItem id="compile" priority={2} items={entry("compile", "Compile")}>
          <button type="button" data-w="40">Compile</button>
        </ToolbarOverflowItem>
        <ToolbarOverflowItem id="status" priority={3} items={[]}>
          <button type="button" data-w="40">Status</button>
        </ToolbarOverflowItem>
        <ToolbarOverflowMenu data-w="20" />
      </ToolbarOverflowTrack>
    </ToolbarOverflow>
  );
}

// The bar refits on window resize; a changed limit stands in for a resized window.
const resize = () =>
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });

const visible = (name: string) => {
  const control = screen.getByText(name);
  return !control.closest('[style*="display: none"]');
};

beforeEach(installLayout);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ToolbarOverflow", () => {
  it("keeps every control in place while the bar fits", () => {
    render(<Bar limit={240} />);
    for (const name of ["Save", "Undo", "Redo", "Compile", "Status"]) expect(visible(name)).toBe(true);
    expect(screen.getByLabelText("More Actions").closest<HTMLElement>("[data-overflow-trigger]")!.style.display).toBe("none");
  });

  it("collapses the lowest tier together, then the next, and shows what moved in the menu", () => {
    const { rerender } = render(<Bar limit={190} />);
    // Undo and Redo share a tier and go together; the menu button takes the room they leave.
    expect(visible("Undo")).toBe(false);
    expect(visible("Redo")).toBe(false);
    expect(visible("Compile")).toBe(true);
    expect(visible("Save")).toBe(true);
    rerender(<Bar limit={130} />);
    resize();
    expect(visible("Compile")).toBe(false);
    // A control with no menu form is never collapsed, even when the bar still overflows.
    expect(visible("Status")).toBe(true);
    expect(visible("Save")).toBe(true);
    expect(screen.getByLabelText("More Actions").closest<HTMLElement>("[data-overflow-trigger]")!.style.display).toBe("");
  });

  it("lists collapsed controls in bar order with their shortcut and disabled state", () => {
    render(<Bar limit={130} undoDisabled />);
    fireEvent.click(screen.getByLabelText("More Actions"));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.slice(0, 4))).toEqual(["Undo", "Redo", "Comp"]);
    const undo = items[0]!;
    expect(undo.getAttribute("aria-keyshortcuts")).toContain("Z");
    expect(undo.hasAttribute("data-disabled")).toBe(true);
    expect(items[1]!.hasAttribute("data-disabled")).toBe(false);
  });

  it("runs a collapsed control's action from the menu", () => {
    const onSelect = vi.fn();
    render(
      <ToolbarOverflow>
        <ToolbarOverflowTrack data-limit={30}>
          <ToolbarOverflowItem id="compile" priority={1} items={entry("compile", "Compile", { onSelect })}>
            <button type="button" data-w="40">Compile</button>
          </ToolbarOverflowItem>
          <ToolbarOverflowMenu data-w="20" />
        </ToolbarOverflowTrack>
      </ToolbarOverflow>,
    );
    fireEvent.click(screen.getByLabelText("More Actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Compile" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("brings controls back when the bar widens", () => {
    const { rerender } = render(<Bar limit={130} />);
    expect(visible("Undo")).toBe(false);
    rerender(<Bar limit={240} />);
    resize();
    for (const name of ["Undo", "Redo", "Compile"]) expect(visible(name)).toBe(true);
    expect(screen.getByLabelText("More Actions").closest<HTMLElement>("[data-overflow-trigger]")!.style.display).toBe("none");
  });
});
