import { useCallback, useMemo, type ReactNode } from "react";
import { AssetOpenProvider } from "@babylonslate/editor-kit";
import { useDocuments } from "./document-context";
import {
  canOpenAssetDocument,
  openOrFocusAssetDocument,
} from "../lib/open-asset-document";

/** Supplies AssetPicker Open Asset using the project registry and document tabs. */
export function AssetOpenDocumentsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { assetRegistry, tabOrder, setActiveDocument, openDocument } =
    useDocuments();

  const getByGuid = useCallback(
    (guid: string) => assetRegistry?.getByGuid(guid),
    [assetRegistry],
  );

  const value = useMemo(
    () => ({
      canOpen: (guid: string) => canOpenAssetDocument(getByGuid, guid),
      openAsset: (guid: string) => {
        void openOrFocusAssetDocument({
          guid,
          getByGuid,
          openDocumentIds: tabOrder,
          setActiveDocument,
          openDocument,
        });
      },
    }),
    [getByGuid, openDocument, setActiveDocument, tabOrder],
  );

  return <AssetOpenProvider value={value}>{children}</AssetOpenProvider>;
}
