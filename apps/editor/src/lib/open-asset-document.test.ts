import { describe, expect, it, vi } from "vitest";
import {
  canOpenAssetDocument,
  openOrFocusAssetDocument,
} from "./open-asset-document";

function asset(
  guid: string,
  type: string,
  path = `assets/${guid}.babasset`,
) {
  return { path, header: { type } };
}

describe("canOpenAssetDocument", () => {
  const byGuid = new Map([
    ["tex-1", asset("tex-1", "Texture")],
    ["mesh-1", asset("mesh-1", "Mesh")],
    ["enum-1", asset("enum-1", "Enum")],
  ]);
  const getByGuid = (guid: string) => byGuid.get(guid);

  it("allows Texture and Enum project assets", () => {
    expect(canOpenAssetDocument(getByGuid, "tex-1")).toBe(true);
    expect(canOpenAssetDocument(getByGuid, "enum-1")).toBe(true);
  });

  it("rejects Mesh, missing, empty, and engine registry ids", () => {
    expect(canOpenAssetDocument(getByGuid, "mesh-1")).toBe(false);
    expect(canOpenAssetDocument(getByGuid, "missing")).toBe(false);
    expect(canOpenAssetDocument(getByGuid, "")).toBe(false);
    expect(canOpenAssetDocument(getByGuid, "engine:CollisionChannel")).toBe(
      false,
    );
  });
});

describe("openOrFocusAssetDocument", () => {
  it("focuses an already-open tab", async () => {
    const setActiveDocument = vi.fn();
    const openDocument = vi.fn();
    await openOrFocusAssetDocument({
      guid: "tex-1",
      getByGuid: () => asset("tex-1", "Texture", "assets/grass.babasset"),
      openDocumentIds: new Set(["asset-settings:assets/grass.babasset"]),
      setActiveDocument,
      openDocument,
    });
    expect(setActiveDocument).toHaveBeenCalledWith(
      "asset-settings:assets/grass.babasset",
    );
    expect(openDocument).not.toHaveBeenCalled();
  });

  it("opens a Texture tab when it is not already open", async () => {
    const setActiveDocument = vi.fn();
    const openDocument = vi.fn(async () => {});
    await openOrFocusAssetDocument({
      guid: "tex-1",
      getByGuid: () => asset("tex-1", "Texture", "assets/grass.babasset"),
      openDocumentIds: new Set(),
      setActiveDocument,
      openDocument,
    });
    expect(openDocument).toHaveBeenCalledWith({
      kind: "asset-settings",
      path: "assets/grass.babasset",
      label: "Grass",
    });
    expect(setActiveDocument).not.toHaveBeenCalled();
  });

  it("no-ops when the asset cannot open as a tab", async () => {
    const setActiveDocument = vi.fn();
    const openDocument = vi.fn();
    await openOrFocusAssetDocument({
      guid: "mesh-1",
      getByGuid: () => asset("mesh-1", "Mesh"),
      openDocumentIds: new Set(),
      setActiveDocument,
      openDocument,
    });
    expect(openDocument).not.toHaveBeenCalled();
    expect(setActiveDocument).not.toHaveBeenCalled();
  });
});
