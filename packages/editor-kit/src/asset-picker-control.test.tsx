import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Button } from "@babylonslate/ui/components/button";
import {
  AssetOpenProvider,
  AssetPickerControl,
} from "./asset-picker-control";

describe("AssetPickerControl", () => {
  afterEach(() => {
    cleanup();
  });

  it("hides Open Asset when there is no provider", () => {
    render(
      <AssetPickerControl value="tex-1">
        <Button data-testid="property-texture">Grass</Button>
      </AssetPickerControl>,
    );
    expect(screen.getByTestId("property-texture")).toBeTruthy();
    expect(screen.queryByTestId("property-texture-open")).toBeNull();
  });

  it("hides Open Asset when the selected guid cannot open", () => {
    render(
      <AssetOpenProvider
        value={{
          canOpen: () => false,
          openAsset: () => {},
        }}
      >
        <AssetPickerControl value="mesh-1">
          <Button data-testid="property-mesh">Rock</Button>
        </AssetPickerControl>
      </AssetOpenProvider>,
    );
    expect(screen.queryByTestId("property-mesh-open")).toBeNull();
  });

  it("hides Open Asset when the picker is empty", () => {
    render(
      <AssetOpenProvider
        value={{
          canOpen: () => true,
          openAsset: () => {},
        }}
      >
        <AssetPickerControl value={null}>
          <Button data-testid="property-texture">None</Button>
        </AssetPickerControl>
      </AssetOpenProvider>,
    );
    expect(screen.queryByTestId("property-texture-open")).toBeNull();
  });

  it("shows a square Open Asset button and opens the selected guid", () => {
    const openAsset = vi.fn();
    render(
      <AssetOpenProvider
        value={{
          canOpen: (guid) => guid === "tex-1",
          openAsset,
        }}
      >
        <AssetPickerControl value="tex-1">
          <Button data-testid="property-texture">Grass</Button>
        </AssetPickerControl>
      </AssetOpenProvider>,
    );
    const open = screen.getByTestId("property-texture-open");
    expect(open.getAttribute("aria-label")).toBe("Open Asset");
    open.click();
    expect(openAsset).toHaveBeenCalledWith("tex-1");
  });
});
