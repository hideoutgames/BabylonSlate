export function projectUiAssetCacheKey(
  projectName: string | null | undefined,
  assets: readonly { guid: string; type: string; path: string }[],
): string {
  const parts = assets
    .filter((asset) => asset.type === "UserInterface" || asset.type === "Font")
    .map((asset) => `${asset.type}:${asset.guid}:${asset.path}`)
    .sort();
  return `${projectName ?? ""}|${parts.join(",")}`;
}

let currentKey = "";
let libraryPromise: Promise<unknown> | null = null;
let fontsPromise: Promise<unknown> | null = null;

/** Share one UI/font library load across every mounted designer document. */
export function rememberProjectUiAssets<TLibrary, TFonts>(
  key: string,
  loaders: {
    loadLibrary: () => Promise<TLibrary>;
    loadFonts: () => Promise<TFonts>;
  },
): { library: Promise<TLibrary>; fonts: Promise<TFonts> } {
  if (key !== currentKey || !libraryPromise || !fontsPromise) {
    currentKey = key;
    libraryPromise = loaders.loadLibrary();
    fontsPromise = loaders.loadFonts();
  }
  return {
    library: libraryPromise as Promise<TLibrary>,
    fonts: fontsPromise as Promise<TFonts>,
  };
}

export function resetProjectUiAssets(): void {
  currentKey = "";
  libraryPromise = null;
  fontsPromise = null;
}
