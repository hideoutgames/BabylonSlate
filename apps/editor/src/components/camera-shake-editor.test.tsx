import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createDefaultCameraShakePayload } from "@haptic/core";
import { CameraShakeDetailsPanel } from "./camera-shake-editor";

const DOC = "camera-shake:assets/Hit.shake.hasset";
const harness = vi.hoisted(() => ({ applyAssetDocumentChange: vi.fn(async () => true) }));
const curves = [
  { header: { guid: "fade", name: "Fade", type: "FloatCurve", payload: {} }, path: "assets/Fade.floatcurve.hasset" },
  { header: { guid: "path", name: "Path", type: "VectorCurve", payload: {} }, path: "assets/Path.vectorcurve.hasset" },
];

vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "camera-shake:assets/Hit.shake.hasset" }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "camera-shake:assets/Hit.shake.hasset", ref: { kind: "camera-shake", path: "assets/Hit.shake.hasset" }, content: createDefaultCameraShakePayload() }],
  applyAssetDocumentChange: harness.applyAssetDocumentChange,
  assetRegistry: { list: () => curves } as never,
})));

const panel = {} as IDockviewPanelProps;
beforeEach(() => harness.applyAssetDocumentChange.mockClear());
afterEach(() => cleanup());

describe("Camera Shake Inspector", () => {
  it("switches the Pattern as one undo entry", () => {
    render(<CameraShakeDetailsPanel {...panel} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Pattern" }));
    const option = screen.getByRole("option", { name: "Sine Wave" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    expect(harness.applyAssetDocumentChange).toHaveBeenCalledExactlyOnceWith(DOC, expect.objectContaining({ pattern: "sine" }), undefined);
  });

  it("picks an Intensity Curve from the project's Float Curves only", () => {
    render(<CameraShakeDetailsPanel {...panel} />);
    fireEvent.click(screen.getByTestId("property-row-intensityCurveGuid").querySelector("button")!);
    expect(screen.queryByText("Path")).toBeNull();
    fireEvent.click(screen.getByText("Fade"));
    expect(harness.applyAssetDocumentChange).toHaveBeenLastCalledWith(DOC, expect.objectContaining({ intensityCurveGuid: "fade" }), undefined);
  });
});
