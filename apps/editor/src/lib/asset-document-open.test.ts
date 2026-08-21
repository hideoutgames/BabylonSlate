import { describe, expect, it, vi } from "vitest";
import { assetDocumentOpen } from "./asset-document-open";
import type { AssetRegistry } from "@babylonslate/assets";

function registryWith(asset?: {
  path: string;
  header: { type: string; name: string };
}) {
  return {
    getByGuid: () => asset,
  } as unknown as AssetRegistry;
}

describe("assetDocumentOpen", () => {
  it("reports openable only for assets with a path and document kind", () => {
    const openable = assetDocumentOpen(
      registryWith({ path: "assets/main.scene", header: { type: "Scene", name: "main" } }),
      vi.fn(),
    );
    expect(openable.canOpenAsset("guid")).toBe(true);

    const pathless = assetDocumentOpen(
      registryWith({ path: "", header: { type: "Scene", name: "main" } }),
      vi.fn(),
    );
    expect(pathless.canOpenAsset("guid")).toBe(false);

    const unmapped = assetDocumentOpen(
      registryWith({ path: "assets/x.babasset", header: { type: "Widget", name: "x" } }),
      vi.fn(),
    );
    expect(unmapped.canOpenAsset("guid")).toBe(false);

    const missing = assetDocumentOpen(registryWith(), vi.fn());
    expect(missing.canOpenAsset("guid")).toBe(false);
    expect(missing.canOpenAsset(null)).toBe(false);
  });

  it("opens a document ref for an openable asset", async () => {
    const openDocument = vi.fn().mockResolvedValue(undefined);
    const { openAsset } = assetDocumentOpen(
      registryWith({ path: "assets/rock.model", header: { type: "Model", name: "Rock" } }),
      openDocument,
    );

    await openAsset("guid-rock");

    expect(openDocument).toHaveBeenCalledTimes(1);
    expect(openDocument.mock.calls[0]![0]).toMatchObject({
      kind: "model",
      path: "assets/rock.model",
      label: "Rock Model",
    });
  });

  it("does not open when the guid cannot open a document", async () => {
    const openDocument = vi.fn();
    const { openAsset } = assetDocumentOpen(registryWith(), openDocument);

    await openAsset("guid-missing");

    expect(openDocument).not.toHaveBeenCalled();
  });
});
