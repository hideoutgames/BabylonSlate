import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Button } from "@haptic/ui/components/button";
import { AssetPicker } from "./asset-picker";
import { AssetPickerControl } from "./asset-picker-control";
import { AssetThumbnailProvider, type AssetThumbnailApi } from "./asset-thumbnail";
import { PickerIdentity, assetRowIdentity, selectedPickerIdentity } from "./picker-identity";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);

function closedPicker(api: AssetThumbnailApi, guid: string | null, asset: { name: string; type: string }) {
  return (
    <AssetThumbnailProvider value={api}>
      <AssetPickerControl value={guid}>
        <Button data-testid="picker">{selectedPickerIdentity(assetRowIdentity(asset))}</Button>
      </AssetPickerControl>
    </AssetThumbnailProvider>
  );
}

describe("closed picker thumbnails", () => {
  let created: Blob[];
  let revoked: string[];
  beforeEach(() => {
    created = [];
    revoked = [];
    vi.stubGlobal("URL", Object.assign(Object.create(URL), {
      createObjectURL: (blob: Blob) => { created.push(blob); return `blob:thumb-${created.length}`; },
      revokeObjectURL: (url: string) => { revoked.push(url); },
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("show the picked Texture's stored thumbnail in place of the type icon", async () => {
    const load = vi.fn(async () => PNG);
    render(closedPicker({ load, versions: {} }, "tex-grass", { name: "Grass", type: "Texture" }));
    const image = await waitFor(() => screen.getByTestId("picker-thumbnail").querySelector("img")!);
    expect(image.getAttribute("src")).toBe("blob:thumb-1");
    expect(load).toHaveBeenCalledWith("tex-grass");
    expect(created[0]!.type).toBe("image/png");
    expect(screen.getByTestId("picker").textContent).toContain("Grass");
  });

  it("reload a rewritten thumbnail and release the old image", async () => {
    const load = vi.fn(async () => PNG);
    const { rerender } = render(closedPicker({ load, versions: { "tex-grass": 1 } }, "tex-grass", { name: "Grass", type: "Texture" }));
    await waitFor(() => expect(screen.getByTestId("picker-thumbnail").querySelector("img")!.getAttribute("src")).toBe("blob:thumb-1"));
    rerender(closedPicker({ load, versions: { "tex-grass": 2 } }, "tex-grass", { name: "Grass", type: "Texture" }));
    await waitFor(() => expect(screen.getByTestId("picker-thumbnail").querySelector("img")!.getAttribute("src")).toBe("blob:thumb-2"));
    expect(revoked).toEqual(["blob:thumb-1"]);
  });

  it("keep the type icon for other asset types, a Texture without a thumbnail, and rows outside a closed picker", async () => {
    const load = vi.fn(async (guid: string) => (guid === "tex-none" ? null : PNG));
    const { unmount } = render(closedPicker({ load, versions: {} }, "mat-rock", { name: "Rock", type: "Material" }));
    expect(load).not.toHaveBeenCalled();
    unmount();
    render(closedPicker({ load, versions: {} }, "tex-none", { name: "Blank", type: "Texture" }));
    await waitFor(() => expect(load).toHaveBeenCalledWith("tex-none"));
    expect(screen.queryByTestId("picker-thumbnail")).toBeNull();
    cleanup();
    render(
      <AssetThumbnailProvider value={{ load, versions: {} }}>
        <PickerIdentity label="Grass" description="Texture" visual={{ assetType: "Texture" }} />
      </AssetThumbnailProvider>,
    );
    expect(screen.queryByTestId("picker-thumbnail")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("show Texture thumbnails in the Pick Asset list and the type icon for other rows", async () => {
    const load = vi.fn(async (guid: string) => (guid === "tex-grass" ? PNG : null));
    render(
      <AssetThumbnailProvider value={{ load, versions: {} }}>
        <AssetPicker
          open
          onOpenChange={() => {}}
          onPick={() => {}}
          assets={[
            { guid: "tex-grass", name: "Grass", type: "Texture" },
            { guid: "mat-rock", name: "Rock", type: "Material" },
          ]}
        />
      </AssetThumbnailProvider>,
    );
    const image = await waitFor(() => screen.getByTestId("asset-row-thumbnail-tex-grass").querySelector("img")!);
    expect(image.getAttribute("src")).toBe("blob:thumb-1");
    expect(screen.getByTestId("search-item-tex-grass").contains(image)).toBe(true);
    expect(screen.queryByTestId("asset-row-thumbnail-mat-rock")).toBeNull();
    expect(load).not.toHaveBeenCalledWith("mat-rock");
  });
});
