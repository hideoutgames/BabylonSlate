/** Babylon keeps decoder paths process-wide: the backend Engine and the view must configure the same ones. */
export function playerDecoderPaths(): { ktx2BasePath: string; dracoBasePath: string; meshoptBasePath: string } {
  return {
    ktx2BasePath: new URL("./ktx2/", document.baseURI).href,
    dracoBasePath: new URL("./draco/", document.baseURI).href,
    meshoptBasePath: new URL("./meshopt/", document.baseURI).href,
  };
}
