import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { KeybindProvider } from "../context/keybind-context";
import { dispatchPointerEvent, stubPointerCapture } from "../../../../packages/editor-kit/src/test-support/pointer-events";
import { CurveAssetDetailsPanel, CurveAssetEditorPanel } from "./curve-asset-editor";

const harness = vi.hoisted(() => ({
  applyAssetDocumentChange: vi.fn(async () => true),
}));

const key = (Time: number, Value: number) => ({ Time, Value, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 });
const content = {
  curve: { Keys: [key(0, 1), key(0.5, 0.25), key(2, -0.5)], Before: "constant", After: "constant" },
  description: "Damage over distance",
};

vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "float-curve:assets/Falloff.floatcurve.hasset" }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "float-curve:assets/Falloff.floatcurve.hasset", ref: { kind: "float-curve", path: "assets/Falloff.floatcurve.hasset" }, content }],
  applyAssetDocumentChange: harness.applyAssetDocumentChange,
})));

const DOC = "float-curve:assets/Falloff.floatcurve.hasset";
const panel = {} as IDockviewPanelProps;
let restoreCapture: () => void;
beforeEach(() => {
  harness.applyAssetDocumentChange.mockClear();
  restoreCapture = stubPointerCapture();
});
afterEach(() => {
  cleanup();
  restoreCapture();
  vi.restoreAllMocks();
});

describe("Curve asset Details", () => {
  it("shows what scripts read as text, not fields", () => {
    render(<CurveAssetDetailsPanel {...panel} />);
    expect(screen.getByTestId("property-curve-asset-type").textContent).toBe("Float Curve");
    expect(screen.getByTestId("property-curve-asset-keys").textContent).toBe("3");
    expect(screen.getByTestId("property-curve-asset-time-range").textContent).toBe("0.00 – 2.00 s");
    expect(screen.getByTestId("property-curve-asset-value-range").textContent).toBe("-0.50 – 1.00");
    // The only thing to type into is the Description.
    expect(screen.getAllByRole("textbox").map((box) => box.tagName)).toEqual(["TEXTAREA"]);
  });

  it("changes After as its own undo entry", () => {
    render(<CurveAssetDetailsPanel {...panel} />);
    fireEvent.click(screen.getByRole("combobox", { name: "After" }));
    const cycle = screen.getByRole("option", { name: "Cycle" });
    fireEvent.pointerDown(cycle);
    fireEvent.click(cycle);
    expect(harness.applyAssetDocumentChange).toHaveBeenCalledExactlyOnceWith(
      DOC,
      expect.objectContaining({ curve: expect.objectContaining({ Before: "constant", After: "cycle", Keys: expect.any(Array) }) }),
      undefined,
    );
  });

  it("keeps a multi-line Description and commits it when the field is left", () => {
    render(<CurveAssetDetailsPanel {...panel} />);
    const description = screen.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
    expect(description.value).toBe("Damage over distance");
    act(() => description.focus());
    fireEvent.change(description, { target: { value: "Damage over distance\nZero past 2 m" } });
    // Enter starts a new line instead of leaving the field.
    fireEvent.keyDown(description, { key: "Enter" });
    expect(document.activeElement).toBe(description);
    expect(harness.applyAssetDocumentChange).not.toHaveBeenCalled();
    act(() => description.blur());
    expect(harness.applyAssetDocumentChange).toHaveBeenCalledExactlyOnceWith(
      DOC, expect.objectContaining({ description: "Damage over distance\nZero past 2 m" }), "curve-asset:description",
    );
  });
});

describe("Curve Editor window", () => {
  it("fits the keys again on Frame Selection, and shows its chord on Fit", () => {
    // Every plot measures 100 × 100 px at the origin, so client coordinates are percentages.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    render(<KeybindProvider><CurveAssetEditorPanel {...panel} /></KeybindProvider>);
    const across = () => parseFloat(screen.getByTestId("curve-asset-editor-key-1").style.left);
    const framed = across();
    const track = screen.getByTestId("curve-asset-editor-track");
    act(() => {
      dispatchPointerEvent(track, "pointerdown", { pointerType: "mouse", clientX: 50, clientY: 50 });
      dispatchPointerEvent(track, "pointermove", { pointerType: "mouse", clientX: 30, clientY: 50 });
      dispatchPointerEvent(track, "pointerup", { pointerType: "mouse", clientX: 30, clientY: 50 });
    });
    expect(across()).toBeCloseTo(framed - 20, 1);
    fireEvent.keyDown(document.body, { key: "f", code: "KeyF" });
    expect(across()).toBeCloseTo(framed, 5);
    expect(within(screen.getByTestId("curve-asset-editor-fit")).getByText("F")).toBeTruthy();
  });
});
