import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import {
  AssetCreateProvider,
  type AssetCreateApi,
} from "@babylonslate/editor-kit";
import type { MaterialDomain } from "@babylonslate/shader-graph";
import { useDocuments } from "./document-context";
import {
  classIdFromClassAsset,
  creatableAssetTypeLabel,
} from "../lib/content-browser-helpers";
import {
  createPickerAsset,
  isNewClassParentAllowed,
  isPickerCreatableAssetType,
} from "../lib/create-project-asset";

/**
 * Supplies AssetPicker / ClassPicker "Create New" rows. New assets go next to
 * the request's owner document (default: the active document) and are not
 * opened; the picker assigns them.
 */
export function AssetCreateDocumentsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { assetRegistry, noteAssetsCreated, openDocuments, activeDocumentId } =
    useDocuments();
  // Read at create time so document edits do not re-render every picker.
  const latest = useRef({ noteAssetsCreated, openDocuments, activeDocumentId });
  useLayoutEffect(() => {
    latest.current = { noteAssetsCreated, openDocuments, activeDocumentId };
  });

  const value = useMemo<AssetCreateApi>(() => {
    const create = async (request: {
      type: string;
      name?: string;
      parentClass?: string;
      materialDomain?: MaterialDomain;
      structureGuid?: string | null;
      ownerPath?: string | null;
    }) => {
      if (!assetRegistry) throw new Error("Open a project to create assets.");
      if (!isPickerCreatableAssetType(request.type)) {
        throw new Error(`${request.type} assets cannot be created here.`);
      }
      const { openDocuments: docs, activeDocumentId: activeId } = latest.current;
      const created = await createPickerAsset({
        registry: assetRegistry,
        ownerPath:
          request.ownerPath !== undefined
            ? request.ownerPath
            : docs.find((doc) => doc.id === activeId)?.ref.path,
        openDocuments: docs,
        type: request.type,
        name: request.name,
        parentClass: request.parentClass,
        materialDomain: request.materialDomain,
        structureGuid: request.structureGuid,
      });
      // The mounted registry indexed the new asset on write; a full remount
      // would rescan every root while the picker waits.
      latest.current.noteAssetsCreated();
      return created;
    };
    return {
      canCreate: (type) => Boolean(assetRegistry) && isPickerCreatableAssetType(type),
      typeLabel: (type) =>
        isPickerCreatableAssetType(type) ? creatableAssetTypeLabel(type) : type,
      createAsset: async (request) => (await create(request)).header.guid,
      createClass: async ({ parentClass, name, ownerPath }) =>
        classIdFromClassAsset(
          await create({ type: "Class", name, parentClass, ownerPath }),
        ),
      canCreateClass: (parentClass) =>
        assetRegistry
          ? isNewClassParentAllowed(parentClass, assetRegistry.list())
          : false,
    };
  }, [assetRegistry]);

  return <AssetCreateProvider value={value}>{children}</AssetCreateProvider>;
}
