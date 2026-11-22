import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { IndexedAsset } from "@haptic/assets";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { createAssetThumbnailRevisionIndex } from "../lib/asset-thumbnail-revision";
import type { ProjectService } from "../services/project-service";
import { useAssetThumbnails } from "./use-asset-thumbnails";

vi.mock("../lib/asset-thumbnail-revision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/asset-thumbnail-revision")>();
  return { ...actual, createAssetThumbnailRevisionIndex: vi.fn(actual.createAssetThumbnailRevisionIndex) };
});

afterEach(cleanup);

function material(guid: string): IndexedAsset {
  return {
    rootId: "project",
    path: `assets/${guid}.material.hasset`,
    header: {
      guid, type: "Material", name: guid, engineVersion: "0.0.0", version: 1, mode: "thin",
      dependencies: [], parentClass: null, payload: {}, chunks: [],
    },
  } as unknown as IndexedAsset;
}

it("builds the revision index a thumbnail write keys on once per registry change, not once per write", async () => {
  const assets = Array.from({ length: 40 }, (_, index) => material(`material-${index}`));
  const registry = {
    generation: 1,
    list: () => assets,
    getByGuid: (guid: string) => assets.find((asset) => asset.header.guid === guid),
  };
  const projectService = { guid: "project", registry } as unknown as ProjectService;
  const derived = new MemoryStorageAdapter("documents");
  await derived.openDocumentsProject("Derived");
  const { result } = renderHook(() => useAssetThumbnails({
    projectService,
    projectDocumentRef: { current: null },
    projectDocument: null,
    registryEpoch: 1,
    ensureDerived: async () => derived,
  }));
  const built = vi.mocked(createAssetThumbnailRevisionIndex);
  built.mockClear();

  // A new project's captures land one after another, with the registry unchanged.
  for (const asset of assets) {
    await act(() => result.current.actions.writeAssetThumbnail(asset.header.guid, new Uint8Array([1, 2, 3])));
  }
  expect(built).toHaveBeenCalledTimes(1);
  expect(result.current.thumbnailVersions.version("material-7")).toBe(1);

  // A save reindexed an asset: the next write keys on the current headers.
  registry.generation += 1;
  await act(() => result.current.actions.writeAssetThumbnail("material-0", new Uint8Array([4])));
  expect(built).toHaveBeenCalledTimes(2);
  expect(result.current.thumbnailVersions.version("material-0")).toBe(2);
});
