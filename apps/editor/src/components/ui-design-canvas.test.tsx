import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Engine } from "@babylonjs/core";
import {
  createDefaultPlayHud,
  describeUiControls,
  layoutUserInterface,
} from "@babylonslate/ui-runtime";
import { UiDesignCanvas } from "./ui-design-canvas";

vi.mock("@babylonslate/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/render")>();
  return {
    ...actual,
    createUiSurface: () => {
      throw new Error("standalone ADT failed");
    },
  };
});

afterEach(() => {
  cleanup();
});

describe("UiDesignCanvas preview fallback", () => {
  it("shows an error instead of a silent black canvas when the surface fails", () => {
    const ui = createDefaultPlayHud("HUD");
    const viewport = {
      id: "ipad-landscape",
      width: 1194,
      height: 834,
      safeArea: { left: 0, right: 0, top: 24, bottom: 20 },
    };
    const layout = layoutUserInterface(ui, viewport, {
      designSpace: true,
      safeArea: viewport.safeArea,
    });
    render(
      <UiDesignCanvas
        ui={ui}
        viewport={viewport}
        layout={layout}
        controls={describeUiControls(ui, layout)}
        selectedId={ui.rootId}
        view={{ zoom: 1, panX: 0, panY: 0 }}
        previewScale={1}
        bitmapScale={1}
        sharedEngine={{} as Engine}
        onSelect={() => {}}
        onViewChange={() => {}}
        onLayoutChange={() => {}}
      />,
    );
    expect(screen.getByTestId("ui-gui-preview-error")).toBeTruthy();
    expect(screen.getByTestId("ui-gui-preview-error").textContent).toMatch(
      /unavailable/i,
    );
  });
});
