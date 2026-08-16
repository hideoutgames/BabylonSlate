import { afterEach, describe, expect, it } from "vitest";
import {
  projectUiAssetCacheKey,
  rememberProjectUiAssets,
  resetProjectUiAssets,
} from "./project-ui-asset-cache";

describe("projectUiAssetCache", () => {
  afterEach(() => {
    resetProjectUiAssets();
  });
  it("builds a stable key from the project and UI/Font assets", () => {
    expect(
      projectUiAssetCacheKey("Demo", [
        { guid: "b", type: "UserInterface", path: "assets/B.ui.babasset" },
        { guid: "tex", type: "Texture", path: "assets/T.texture.babasset" },
        { guid: "a", type: "Font", path: "assets/A.font.babasset" },
      ]),
    ).toBe("Demo|Font:a:assets/A.font.babasset,UserInterface:b:assets/B.ui.babasset");
  });

  it("reuses in-flight loads for the same key and reloads when the key changes", async () => {
    resetProjectUiAssets();
    let libraryLoads = 0;
    let fontLoads = 0;
    const loaders = {
      loadLibrary: async () => {
        libraryLoads += 1;
        return { n: libraryLoads };
      },
      loadFonts: async () => {
        fontLoads += 1;
        return [fontLoads];
      },
    };
    const first = rememberProjectUiAssets("proj|ui:1", loaders);
    const second = rememberProjectUiAssets("proj|ui:1", loaders);
    expect(first.library).toBe(second.library);
    expect(first.fonts).toBe(second.fonts);
    expect(await first.library).toEqual({ n: 1 });
    expect(libraryLoads).toBe(1);
    expect(fontLoads).toBe(1);
    const third = rememberProjectUiAssets("proj|ui:2", loaders);
    expect(third.library).not.toBe(first.library);
    expect(await third.library).toEqual({ n: 2 });
    expect(libraryLoads).toBe(2);
  });

  it("forgets cached loads after reset so a new project cannot reuse them", async () => {
    resetProjectUiAssets();
    let loads = 0;
    const loaders = {
      loadLibrary: async () => {
        loads += 1;
        return loads;
      },
      loadFonts: async () => [],
    };
    await rememberProjectUiAssets("same", loaders).library;
    resetProjectUiAssets();
    await rememberProjectUiAssets("same", loaders).library;
    expect(loads).toBe(2);
  });
});
