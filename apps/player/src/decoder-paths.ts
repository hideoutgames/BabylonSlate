/** Babylon keeps decoder paths process-wide: the backend Engine and the view must configure the same ones. */
export function playerDecoderPaths(): { ktx2BasePath: string; dracoBasePath: string; meshoptBasePath: string } {
  return {
    ktx2BasePath: new URL("./ktx2/", document.baseURI).href,
    dracoBasePath: new URL("./draco/", document.baseURI).href,
    meshoptBasePath: new URL("./meshopt/", document.baseURI).href,
  };
}

/**
 * Worker-based WASM decoders (KTX2/Draco/Meshopt) work on standard HTTP/HTTPS/Capacitor
 * origins, but fail under `about:srcdoc`, `blob:`, `data:`, or `file:` bundles where
 * blob workers cannot load decoder scripts/WASM under COEP.
 */
export function playerCanUseWorkerDecoders(): boolean {
  if (typeof location === "undefined") return false;
  if (location.origin === "null") return false;
  const protocol = location.protocol;
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "capacitor:") return false;
  const base = typeof document !== "undefined" ? document.baseURI : "";
  if (base.startsWith("data:") || base.startsWith("blob:") || base.startsWith("about:")) return false;
  return true;
}
