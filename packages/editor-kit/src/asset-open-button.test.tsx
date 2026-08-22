import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AssetOpenButton, canOpenAssetInTab } from "./asset-open-button";

afterEach(() => {
  cleanup();
});

describe("canOpenAssetInTab", () => {
  it("is false without a path even for a known type", () => {
    expect(canOpenAssetInTab({ type: "Material" })).toBe(false);
  });

  it("is false for unknown or custom types", () => {
    expect(canOpenAssetInTab({ type: "CameraComponent", path: "a/x.babasset" })).toBe(false);
    expect(canOpenAssetInTab({ path: "a/x.babasset" })).toBe(false);
  });

  it("is true for a known type with a path, regardless of open tabs", () => {
    expect(canOpenAssetInTab({ type: "Material", path: "a/red.material.babasset" })).toBe(true);
    expect(canOpenAssetInTab({ type: "Texture", path: "a/tex.babasset" })).toBe(true);
    expect(canOpenAssetInTab({ type: "Shader", path: "a/legacy.shader.babasset" })).toBe(true);
  });

  it("is false for null or undefined entries", () => {
    expect(canOpenAssetInTab(null)).toBe(false);
    expect(canOpenAssetInTab(undefined)).toBe(false);
  });

  it("rejects raw registry entries whose type is nested under header", () => {
    // IndexedAsset carries `header.type`, not `type` — callers must map it.
    expect(
      canOpenAssetInTab({
        header: { type: "Material" },
        path: "a/red.material.babasset",
      } as unknown as { type?: string; path?: string }),
    ).toBe(false);
  });
});

describe("AssetOpenButton", () => {
  it("renders a square button and fires onOpen for an openable entry", () => {
    const onOpen = vi.fn();
    render(
      <div className="flex items-stretch">
        <AssetOpenButton
          entry={{ type: "Material", path: "a/red.material.babasset" }}
          onOpen={onOpen}
        />
      </div>,
    );
    const button = screen.getByTestId("asset-open-button");
    expect(button.getAttribute("aria-label")).toBe("Open in tab");
    expect(button.className).toContain("aspect-square");
    expect(button.className).toContain("self-stretch");
    button.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("renders nothing when the entry is missing or not openable", () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <AssetOpenButton entry={null} onOpen={onOpen} />,
    );
    expect(screen.queryByTestId("asset-open-button")).toBeNull();
    rerender(
      <AssetOpenButton
        entry={{ type: "CameraComponent", path: "a/x.babasset" }}
        onOpen={onOpen}
      />,
    );
    expect(screen.queryByTestId("asset-open-button")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("supports a custom label and test id", () => {
    render(
      <AssetOpenButton
        entry={{ type: "Sprite", path: "a/hero.sprite.babasset" }}
        onOpen={() => {}}
        label="Open sprite"
        data-testid="sprite-open"
      />,
    );
    expect(screen.getByTestId("sprite-open").getAttribute("aria-label")).toBe(
      "Open sprite",
    );
  });
});
