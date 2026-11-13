import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { BlendSpacePayload } from "@haptic/assets";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { BlendSpaceEditingProvider } from "../context/blend-space-editing-context";
import { BlendSpaceAnimationsPanel, BlendSpaceDetailsPanel, BlendSpaceGridPanel } from "./blend-space-editor";

const harness = vi.hoisted(() => ({
  content: {} as Record<string, unknown>,
  applyAssetDocumentChange: vi.fn<(id: string, next: Record<string, unknown>, mergeKey?: string) => Promise<boolean>>(async () => true),
}));

const assets = [
  { path: "assets/Walk.hasset", header: { guid: "walk", name: "Hero_Walk", type: "Animation", payload: { clipName: "Walk", skeletonGuid: "rig" } } },
  { path: "assets/Run.hasset", header: { guid: "run", name: "Hero_Run", type: "Animation", payload: { clipName: "Run", skeletonGuid: "rig" } } },
  { path: "assets/Other.hasset", header: { guid: "other", name: "Large_Walk", type: "Animation", payload: { clipName: "Walk", skeletonGuid: "large" } } },
  { path: "assets/Rig.hasset", header: { guid: "rig", name: "Hero_Skeleton", type: "Skeleton", payload: {} } },
];

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    assetRegistry: {
      list: () => assets,
      getByGuid: (guid: string) => assets.find((asset) => asset.header.guid === guid),
    },
    openDocuments: [{ id: "bs", ref: { kind: "blend-space", path: "assets/Loco.blendspace.hasset" }, content: harness.content }],
    applyAssetDocumentChange: harness.applyAssetDocumentChange,
  })),
);

function payload(extra: Partial<BlendSpacePayload> = {}): BlendSpacePayload {
  return {
    skeletonGuid: "rig",
    previewModelGuid: null,
    axes: [{ name: "Speed", min: 0, max: 6, gridDivisions: 6, smoothingSeconds: 0, wrap: false }],
    samples: [
      { animationGuid: "walk", x: 2, y: 0, rateScale: 1 },
      { animationGuid: "run", x: 6, y: 0, rateScale: 1 },
    ],
    ...extra,
  };
}

const panelProps = {} as IDockviewPanelProps;

function renderPanels() {
  return render(
    <DocumentWorkspaceProvider documentId="bs">
      <BlendSpaceEditingProvider>
        <BlendSpaceGridPanel {...panelProps} />
        <BlendSpaceAnimationsPanel {...panelProps} />
        <BlendSpaceDetailsPanel {...panelProps} />
      </BlendSpaceEditingProvider>
    </DocumentWorkspaceProvider>,
  );
}

/** jsdom has no PointerEvent, so a pointer event is a MouseEvent carrying a pointer id and type. */
function pointer(target: Element, type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY: number, pointerId: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  act(() => {
    target.dispatchEvent(event);
  });
}

const lastWrite = () => harness.applyAssetDocumentChange.mock.calls.at(-1)?.[1] as unknown as BlendSpacePayload;

beforeEach(() => {
  // jsdom lays nothing out: give the Grid a 400 × 300 box.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 300));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  harness.applyAssetDocumentChange.mockClear();
});

describe("Blend Space editor", () => {
  it("draws each sample on the Grid with its Animation's name, and the weights at the preview point", () => {
    harness.content = payload() as unknown as Record<string, unknown>;
    renderPanels();
    expect(screen.getByTestId("blend-space-grid").getAttribute("data-axes")).toBe("1");
    expect(screen.getByTestId("blend-space-sample-0").getAttribute("data-x")).toBe("2");
    expect(screen.getByTestId("blend-space-sample-1").textContent).toContain("Hero_Run");
    // The preview point starts at the axis minimum, where Walk (the nearest sample) plays alone.
    expect(screen.getByTestId("blend-space-weights").textContent).toBe("X 0Hero_Walk1.00");
  });

  it("moves the preview point where the Grid is clicked and weighs the samples there", () => {
    harness.content = payload() as unknown as Record<string, unknown>;
    renderPanels();
    // The plot spans x 48 … 380 for 0 … 6: 4 sits at 48 + 332 × 4/6.
    pointer(screen.getByTestId("blend-space-grid"), "pointerdown", 48 + (332 * 4) / 6, 150, 1);
    expect(screen.getByTestId("blend-space-grid").getAttribute("data-point-x")).toBe("4");
    expect(screen.getByTestId("blend-space-weights").textContent).toBe("X 4Hero_Walk0.50Hero_Run0.50");
  });

  it("lists only Animations on the Blend Space's Skeleton, and adds one at the preview point", () => {
    harness.content = payload({ samples: [] }) as unknown as Record<string, unknown>;
    renderPanels();
    expect(screen.queryByTestId("blend-space-animation-other")).toBeNull();
    fireEvent.click(screen.getByTestId("blend-space-add-run"));
    expect(lastWrite().samples).toEqual([{ animationGuid: "run", x: 0, y: 0, rateScale: 1 }]);
  });

  it("drags a sample along the grid, snapped, as one undo step", () => {
    harness.content = payload() as unknown as Record<string, unknown>;
    renderPanels();
    const grid = screen.getByTestId("blend-space-grid");
    pointer(screen.getByTestId("blend-space-sample-0"), "pointerdown", 159, 150, 2);
    pointer(grid, "pointermove", 48 + (332 * 3.2) / 6, 150, 2);
    pointer(grid, "pointerup", 48 + (332 * 3.2) / 6, 150, 2);
    expect(lastWrite().samples[0]).toMatchObject({ animationGuid: "walk", x: 3 });
    expect(harness.applyAssetDocumentChange.mock.calls.at(-1)?.[2]).toMatch(/^blend-space:sample:0:/);
  });

  it("edits the selected sample in the Inspector and removes it with Delete on the Grid", () => {
    harness.content = payload() as unknown as Record<string, unknown>;
    renderPanels();
    expect(screen.getByTestId("blend-space-no-sample")).toBeTruthy();
    pointer(screen.getByTestId("blend-space-sample-1"), "pointerdown", 380, 150, 3);
    const sample = screen.getByTestId("blend-space-sample");
    fireEvent.change(within(sample).getByTestId("property-sample-rate"), { target: { value: "1.5" } });
    expect(lastWrite().samples[1]).toMatchObject({ animationGuid: "run", rateScale: 1.5 });
    fireEvent.keyDown(screen.getByTestId("blend-space-grid"), { key: "Delete" });
    expect(lastWrite().samples.map((entry) => entry.animationGuid)).toEqual(["walk"]);
  });

  it("adds a second axis from the Inspector", () => {
    harness.content = payload() as unknown as Record<string, unknown>;
    renderPanels();
    fireEvent.click(screen.getByTestId("blend-space-axes-two"));
    expect(lastWrite().axes.map((axis) => axis.name)).toEqual(["Speed", "Direction"]);
    expect(lastWrite().samples.map((entry) => entry.y)).toEqual([-180, -180]);
  });
});
