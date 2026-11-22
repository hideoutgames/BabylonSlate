import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Button } from "@haptic/ui/components/button";
import { AssetPicker } from "./asset-picker";
import { AssetPickerControl } from "./asset-picker-control";
import { AssetThumbnailProvider, useAssetThumbnailUrl, type AssetThumbnailApi } from "./asset-thumbnail";
import { createThumbnailVersionStore } from "./thumbnail-versions";
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
    render(closedPicker({ load, versions: createThumbnailVersionStore() }, "tex-grass", { name: "Grass", type: "Texture" }));
    const image = await waitFor(() => screen.getByTestId("picker-thumbnail").querySelector("img")!);
    expect(image.getAttribute("src")).toBe("blob:thumb-1");
    expect(load).toHaveBeenCalledWith("tex-grass");
    expect(created[0]!.type).toBe("image/png");
    expect(screen.getByTestId("picker").textContent).toContain("Grass");
  });

  it("reload a rewritten thumbnail and release the old image", async () => {
    const load = vi.fn(async () => PNG);
    const versions = createThumbnailVersionStore();
    render(closedPicker({ load, versions }, "tex-grass", { name: "Grass", type: "Texture" }));
    await waitFor(() => expect(screen.getByTestId("picker-thumbnail").querySelector("img")!.getAttribute("src")).toBe("blob:thumb-1"));
    act(() => versions.bump(["tex-grass"]));
    await waitFor(() => expect(screen.getByTestId("picker-thumbnail").querySelector("img")!.getAttribute("src")).toBe("blob:thumb-2"));
    expect(revoked).toEqual(["blob:thumb-1"]);
  });

  it("render only the reader of the asset whose thumbnail was rewritten", async () => {
    const load = vi.fn<(guid: string) => Promise<Uint8Array>>(async () => PNG);
    const versions = createThumbnailVersionStore();
    const renders = { grass: 0, rock: 0 };
    function Reader({ guid, name }: { guid: string; name: keyof typeof renders }) {
      renders[name] += 1;
      const url = useAssetThumbnailUrl(guid);
      return <span data-testid={`reader-${name}`}>{url}</span>;
    }
    render(
      <AssetThumbnailProvider value={{ load, versions }}>
        <Reader guid="tex-grass" name="grass" />
        <Reader guid="tex-rock" name="rock" />
      </AssetThumbnailProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("reader-rock").textContent).not.toBe(""));
    const rockRenders = renders.rock;
    for (let write = 0; write < 10; write++) act(() => versions.bump(["tex-grass"]));
    // Each rewrite reads the grass thumbnail again; the rock reader neither reads nor renders.
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2 + 10));
    expect(load.mock.calls.filter(([guid]) => guid === "tex-rock")).toHaveLength(1);
    expect(renders.rock).toBe(rockRenders);
  });

  it("show a Model's thumbnail on the muted background, and a Texture's over the checkerboard", async () => {
    const load = vi.fn(async () => PNG);
    const { unmount } = render(closedPicker({ load, versions: createThumbnailVersionStore() }, "model-hero", { name: "Hero", type: "Model" }));
    const model = await waitFor(() => screen.getByTestId("picker-thumbnail"));
    expect(load).toHaveBeenCalledWith("model-hero");
    expect(model.className).toContain("bg-muted");
    expect(model.style.backgroundImage).toBe("");
    unmount();
    render(closedPicker({ load, versions: createThumbnailVersionStore() }, "tex-grass", { name: "Grass", type: "Texture" }));
    const texture = await waitFor(() => screen.getByTestId("picker-thumbnail"));
    expect(texture.className).not.toContain("bg-muted");
    expect(texture.style.backgroundImage).toContain("conic-gradient");
  });

  it("keep the type icon for types without thumbnails, an asset without a stored one, and rows outside a closed picker", async () => {
    const load = vi.fn(async (guid: string) => (guid === "tex-none" ? null : PNG));
    const { unmount } = render(closedPicker({ load, versions: createThumbnailVersionStore() }, "song", { name: "Song", type: "Audio" }));
    expect(load).not.toHaveBeenCalled();
    unmount();
    render(closedPicker({ load, versions: createThumbnailVersionStore() }, "tex-none", { name: "Blank", type: "Texture" }));
    await waitFor(() => expect(load).toHaveBeenCalledWith("tex-none"));
    expect(screen.queryByTestId("picker-thumbnail")).toBeNull();
    cleanup();
    render(
      <AssetThumbnailProvider value={{ load, versions: createThumbnailVersionStore() }}>
        <PickerIdentity label="Grass" description="Texture" visual={{ assetType: "Texture" }} />
      </AssetThumbnailProvider>,
    );
    expect(screen.queryByTestId("picker-thumbnail")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("show thumbnails in the Pick Asset list and the type icon for other rows", async () => {
    const load = vi.fn(async (guid: string) => (guid === "tex-grass" || guid === "model-hero" ? PNG : null));
    render(
      <AssetThumbnailProvider value={{ load, versions: createThumbnailVersionStore() }}>
        <AssetPicker
          open
          onOpenChange={() => {}}
          onPick={() => {}}
          assets={[
            { guid: "tex-grass", name: "Grass", type: "Texture" },
            { guid: "model-hero", name: "Hero", type: "Model" },
            { guid: "mat-rock", name: "Rock", type: "Material" },
            { guid: "song", name: "Song", type: "Audio" },
          ]}
        />
      </AssetThumbnailProvider>,
    );
    const image = await waitFor(() => screen.getByTestId("asset-row-thumbnail-tex-grass").querySelector("img")!);
    expect(image.getAttribute("src")).toBe("blob:thumb-1");
    expect(screen.getByTestId("search-item-tex-grass").contains(image)).toBe(true);
    await waitFor(() => expect(screen.getByTestId("asset-row-thumbnail-model-hero")).toBeTruthy());
    // A Material without a stored thumbnail keeps its icon; Audio has none to ask for.
    expect(load).toHaveBeenCalledWith("mat-rock");
    expect(screen.queryByTestId("asset-row-thumbnail-mat-rock")).toBeNull();
    expect(load).not.toHaveBeenCalledWith("song");
  });
});
