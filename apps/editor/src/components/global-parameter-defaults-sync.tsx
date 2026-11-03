import { useEffect } from "react";
import { setGlobalParameterCatalog } from "@haptic/render/global-parameter-values";
import { useGlobalParameterCatalog } from "../lib/global-parameter-catalog";

/**
 * Keeps the renderer's Global Parameter defaults on the project's collections, unsaved edits
 * included, so Material and Particle Graph previews, the Scene viewport and a running Play follow
 * every edit.
 */
export function GlobalParameterDefaultsSync() {
  const catalog = useGlobalParameterCatalog();
  useEffect(() => {
    setGlobalParameterCatalog(catalog);
  }, [catalog]);
  return null;
}
