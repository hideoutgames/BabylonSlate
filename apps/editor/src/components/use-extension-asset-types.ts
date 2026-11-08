import { useSyncExternalStore } from "react";
import { useRegistryState } from "../context/document-context";
import type { ExtensionAssetTypeDescriptor } from "../lib/extension-asset-types";

/** Asset types the project's enabled extensions declare; the list keeps its identity until they change. */
export function useExtensionAssetTypes(): readonly ExtensionAssetTypeDescriptor[] {
  const { extensionService } = useRegistryState();
  return useSyncExternalStore(extensionService.subscribe, () => extensionService.getSnapshot().assetTypes);
}
