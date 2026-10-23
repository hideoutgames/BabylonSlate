import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ConditionPin } from "../lib/breakpoint-settings";
import { BreakpointSettingsDialog } from "./breakpoint-settings-dialog";

const PINS: ConditionPin[] = [
  { id: "lastIndex", direction: "in", name: "Last Index", kind: "number" },
  { id: "target", direction: "in", name: "Target", kind: "object" },
  { id: "hit", direction: "out", name: "Hit", kind: "boolean" },
];

async function choose(label: string, option: string) {
  fireEvent.click(screen.getByLabelText(label));
  const item = await screen.findByRole("option", { name: option });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
}

function renderDialog(props: Partial<Parameters<typeof BreakpointSettingsDialog>[0]> = {}) {
  const onSave = vi.fn();
  const onOpenChange = vi.fn();
  render(<BreakpointSettingsDialog onOpenChange={onOpenChange} nodeTitle="For Loop" pins={PINS} settings={{}} onSave={onSave} {...props} />);
  return { onSave, onOpenChange };
}

// Base UI's Checkbox clicks its input with a PointerEvent, which jsdom lacks.
if (typeof window.PointerEvent === "undefined")
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;

afterEach(cleanup);

describe("BreakpointSettingsDialog", () => {
  it("saves a comparison on a pin and a hit count", async () => {
    const { onSave, onOpenChange } = renderDialog();
    await choose("Condition", "Last Index");
    await choose("Comparison", "≤");
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Stop Only On Hit" }));
    fireEvent.change(screen.getByLabelText("Hit Count"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      { condition: { pinId: "lastIndex", direction: "in", op: "<=", value: 0 }, hitCount: 3 },
      "Last Index",
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the dialog open until a number comparison has a number", async () => {
    const { onSave } = renderDialog();
    await choose("Condition", "Last Index");
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "lots" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a number.")).toBeTruthy();
  });

  it("offers an object pin validity and a boolean pin its two values", async () => {
    const { onSave } = renderDialog();
    await choose("Condition", "Target");
    expect(screen.queryByLabelText("Value")).toBeNull();
    await choose("Comparison", "Is Not Valid");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenLastCalledWith({ condition: { pinId: "target", direction: "in", op: "isNotValid" } }, "Target");

    cleanup();
    const second = renderDialog();
    await choose("Condition", "Hit");
    await choose("Value", "False");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(second.onSave).toHaveBeenCalledWith({ condition: { pinId: "hit", direction: "out", op: "==", value: false } }, "Hit");
  });

  it("keeps a saved condition on a pin the node no longer offers, and clears it with None", async () => {
    const saved = { condition: { pinId: "health", direction: "in" as const, op: ">" as const, value: 5 }, hitCount: 2 };
    const { onSave } = renderDialog({ settings: saved, pinName: "Health" });
    expect(screen.getByLabelText("Condition").textContent).toContain("Health");
    expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe("5");
    await choose("Condition", "None");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ hitCount: 2 }, undefined);
  });

  it("offers only a hit count where nodes have no pins", () => {
    const { onSave } = renderDialog({ pins: null, nodeTitle: "Wait" });
    expect(screen.queryByLabelText("Condition")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Stop Only On Hit" }));
    fireEvent.change(screen.getByLabelText("Hit Count"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ hitCount: 4 }, undefined);
  });
});
