import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { DocumentEditStack, SetAssetDocumentCommand } from "@haptic/edit";
import { createDefaultWaterDefinition, normalizeWaterDefinition } from "@haptic/core";
import { AssetCreateProvider, AssetOpenProvider, type AssetCreateApi } from "@haptic/editor-kit";
import { WaterDetailsPanel } from "./water-panels";

if (typeof window !== "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    writable: true,
    value: PointerEventPolyfill,
  });
}

/** Water Details over a real undo stack, as `applyAssetDocumentChange` drives it. */
const harness = vi.hoisted(() => ({
  content: {} as Record<string, unknown>,
  apply: (next: Record<string, unknown>, mergeKey?: string): void => {
    void next;
    void mergeKey;
  },
}));

vi.mock("../context/play-context", () => ({ useOptionalPlay: () => null }));
vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: "water:assets/Lake.water.hasset" }),
}));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "water:assets/Lake.water.hasset", ref: { kind: "water", path: "assets/Lake.water.hasset", label: "Lake" }, content: harness.content }],
  assetRegistry: { list: () => [] },
  applyAssetDocumentChange: async (
    _id: string,
    next: Record<string, unknown>,
    mergeKey?: string,
  ) => {
    harness.apply(next, mergeKey);
    return true;
  },
})));

afterEach(() => {
  cleanup();
});

function renderWithHistory(definition: unknown = createDefaultWaterDefinition(), create?: AssetCreateApi, open?: (guid: string) => void) {
  const stack = new DocumentEditStack<Record<string, unknown>>({ maxEntries: 50, maxBytes: 10_000_000 });
  const initial = normalizeWaterDefinition(definition) as unknown as Record<string, unknown>;
  harness.content = initial;
  let rerender = () => {};
  harness.apply = (next, mergeKey) => {
    harness.content = stack.apply(
      harness.content,
      new SetAssetDocumentCommand(harness.content, next, mergeKey),
    ).doc;
    rerender();
  };
  function Host() {
    const [, setVersion] = useState(0);
    rerender = () => setVersion((version) => version + 1);
    return <WaterDetailsPanel {...({} as IDockviewPanelProps)} />;
  }
  render(create
    ? <AssetCreateProvider value={create}><AssetOpenProvider value={{ canOpen: () => true, openAsset: open ?? (() => {}) }}><Host /></AssetOpenProvider></AssetCreateProvider>
    : <Host />);
  return {
    initial,
    stack,
    read: () => normalizeWaterDefinition(harness.content),
    undo: () => {
      harness.content = stack.undo(harness.content)!.doc;
    },
  };
}

describe("WaterDetailsPanel", () => {
  it("records a Wave Height scrub as one undo step and keeps the earlier history", () => {
    const history = renderWithHistory();
    const before = normalizeWaterDefinition(history.initial);
    fireEvent.change(screen.getByTestId("property-water-opacity"), { target: { value: "0.5" } });
    history.stack.endGesture();

    const handle = screen.getByTestId("property-water-waveHeight-scrub");
    fireEvent.pointerDown(handle, { clientX: 0 });
    for (let x = 1; x <= 60; x += 1) fireEvent.pointerMove(handle, { clientX: x });
    fireEvent.pointerUp(handle, { clientX: 60 });

    expect(history.read().waveHeight).toBeCloseTo(before.waveHeight + 0.6);
    expect(history.stack.undoDepth).toBe(2);
    history.undo();
    expect(history.read().waveHeight).toBe(before.waveHeight);
    expect(history.read().opacity).toBe(0.5);
    history.undo();
    expect(history.read().opacity).toBe(before.opacity);
  });

  it("edits the wind sea and swell lengths apart from their heights, over a puddle's ripples to an ocean's swell", () => {
    const history = renderWithHistory();
    for (const key of ["style", "waveModel", "choppiness", "rippleScale", "stylizedLook", "colorBands", "sparkles"]) expect(screen.queryByTestId(`property-water-${key}`), key).toBeNull();
    fireEvent.change(screen.getByTestId("property-water-swellLength"), { target: { value: "1500" } });
    fireEvent.change(screen.getByTestId("property-water-waveLength"), { target: { value: "0.3" } });
    expect(history.read()).toMatchObject({ swellLength: 1500, waveLength: 0.3, waveHeight: createDefaultWaterDefinition().waveHeight });
    fireEvent.click(screen.getByTestId("property-water-objectReflections"));
    expect(history.read().objectReflections).toBe(!createDefaultWaterDefinition().objectReflections);
  });

  it("makes built-in water an editable Custom Material and opens it", async () => {
    const createAsset = vi.fn(async () => "sea-material"), openAsset = vi.fn();
    const history = renderWithHistory(createDefaultWaterDefinition(), { canCreate: (type) => type === "Material", typeLabel: (type) => type, createAsset }, openAsset);
    fireEvent.click(screen.getByTestId("water-edit-as-material"));
    await waitFor(() => expect(history.read().materialGuid).toBe("sea-material"));
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ type: "Material", name: "Lake Material", waterMaterial: true }));
    expect(openAsset).toHaveBeenCalledWith("sea-material");
    // A Water with a Custom Material edits that Material instead.
    expect(screen.queryByTestId("water-edit-as-material")).toBeNull();
  });

  it("records a color picker drag as one undo step", () => {
    const history = renderWithHistory();
    const swatch = screen.getByTestId("property-water-shallowColor");
    for (const color of ["#102030", "#204060", "#306090"]) {
      fireEvent.change(swatch, { target: { value: color } });
    }
    expect(history.stack.undoDepth).toBe(1);
    history.undo();
    expect(history.read().shallowColor).toEqual(
      normalizeWaterDefinition(history.initial).shallowColor,
    );
  });
});
