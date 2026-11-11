import { useMemo, type ReactNode } from "react";
import { AssetThumbnailProvider } from "@haptic/editor-kit";
import { useDocumentActions, useThumbnailVersions } from "./document-context";

/** Supplies closed pickers' asset thumbnails from the project's stored thumbnails. */
export function AssetThumbnailDocumentsProvider({ children }: { children: ReactNode }) {
  const { loadAssetThumbnail } = useDocumentActions();
  const versions = useThumbnailVersions();
  const value = useMemo(() => ({ load: loadAssetThumbnail, versions }), [loadAssetThumbnail, versions]);
  return <AssetThumbnailProvider value={value}>{children}</AssetThumbnailProvider>;
}
