import {
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  contentEntryNameError,
  type AssetRegistry,
  type FolderNode,
  type IndexedAsset,
} from "@haptic/assets";
import type { useDocumentActions } from "../context/document-context";
import type { OpenDocument } from "../services/document-service";
import {
  ASSETS_ROOT,
  classIdConflict,
  isNewAssetNameTaken,
  joinAssetFolderPath,
  newAssetFileName,
  openSceneViewportMode,
  type CreatableAssetType,
} from "../lib/content-browser-helpers";
import { contentBrowserFolderOps, type ContentBrowserRoot } from "../lib/plugin-ui";
import { collectClassGraphsForPalette, collectGraphTypeAssets, typeSchemasFromGraphAssets } from "../lib/logic-graph-document";
import { classIdForGraphPath } from "../services/script-compiler";
import { createProjectAsset } from "../lib/create-project-asset";
import type {
  ContentBrowserNewAssetDialogProps,
  ContentBrowserNewAssetMenu,
} from "./content-browser-new-asset-dialog";

/** What New Asset reads from the Content Browser and acts through. */
export interface ContentBrowserNewAssetFlowDeps extends Pick<
  ReturnType<typeof useDocumentActions>,
  "getOpenDocuments" | "noteAssetsCreated"
> {
  /**
   * Owned by the workspace with the type, which it also reads to tell which
   * operation dialog is open and whether the open documents are read.
   */
  newAssetOpen: boolean;
  setNewAssetOpen: Dispatch<SetStateAction<boolean>>;
  newAssetType: CreatableAssetType;
  setNewAssetType: Dispatch<SetStateAction<CreatableAssetType>>;
  assetRegistry: AssetRegistry | null;
  allAssets: IndexedAsset[];
  referenceAssets: IndexedAsset[];
  openDocuments: OpenDocument[];
  existingAssetPaths: string[];
  browserRoots: ContentBrowserRoot[];
  folderTrees: FolderNode[];
  isReadOnlyFolder: (path: string) => boolean;
  classParentOf: (id: string) => string | null;
  selectedFolderPath: string;
  setSelectedFolderPath: Dispatch<SetStateAction<string>>;
  setSelectedGuids: Dispatch<SetStateAction<Set<string>>>;
  setSelectedFolderPaths: Dispatch<SetStateAction<Set<string>>>;
  selectedRootWritable: boolean;
  activeDocumentId: string | null;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  operationError: string | null;
  setOperationError: (error: string | null) => void;
  openOrFocusDocument: (asset: IndexedAsset) => Promise<void>;
}

/** New Asset: the type menu, the New Asset dialog and the asset it creates. */
export function useContentBrowserNewAssetFlow(deps: ContentBrowserNewAssetFlowDeps) {
  const {
    newAssetOpen,
    setNewAssetOpen,
    newAssetType,
    setNewAssetType,
    assetRegistry,
    allAssets,
    referenceAssets,
    openDocuments,
    existingAssetPaths,
    browserRoots,
    folderTrees,
    isReadOnlyFolder,
    classParentOf,
    selectedFolderPath,
    setSelectedFolderPath,
    setSelectedGuids,
    setSelectedFolderPaths,
    selectedRootWritable,
    activeDocumentId,
    getOpenDocuments,
    busy,
    setBusy,
    operationError,
    setOperationError,
    noteAssetsCreated,
    openOrFocusDocument,
  } = deps;
  const [newAssetMenuOpen, setNewAssetMenuOpen] = useState(false);
  const [newAssetMenuAnchor, setNewAssetMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [newAssetName, setNewAssetName] = useState("");
  // Starts as the open folder; the dialog's Location can move it elsewhere.
  const [newAssetFolder, setNewAssetFolder] = useState(ASSETS_ROOT);
  const [newAssetParent, setNewAssetParent] = useState("Object");
  const [newDataDefinition, setNewDataDefinition] = useState<string | null>(null);
  // A new 2D or 3D Timeline Clip's Timeline Asset; null makes one named after the clip.
  const [newTimelineAsset, setNewTimelineAsset] = useState<string | null>(null);
  const [newWaterStarter, setNewWaterStarter] = useState(false);

  const newDataTypes = useMemo(() => newAssetOpen && (newAssetType === "DataDefinition" || newAssetType === "DataTree")
    ? collectGraphTypeAssets({ assets: allAssets, openDocuments })
    : { structures: [], enums: [], dataDefinitions: [] }, [newAssetOpen, newAssetType, allAssets, openDocuments]);
  const newAssetTakenError = useMemo(() => {
    if (!newAssetOpen) return null;
    if (isNewAssetNameTaken(existingAssetPaths, newAssetFolder, newAssetType, newAssetName)) {
      return "An asset with this name already exists in the folder.";
    }
    const fileName = newAssetType === "Class" ? newAssetFileName("Class", newAssetName) : "";
    return fileName
      ? classIdConflict(referenceAssets, joinAssetFolderPath(newAssetFolder, fileName))
      : null;
  }, [existingAssetPaths, newAssetFolder, newAssetName, newAssetOpen, newAssetType, referenceAssets]);

  const openNewAssetMenu = useCallback((anchor: { x: number; y: number } | null = null) => {
    if (busy || !selectedRootWritable) return;
    setNewAssetMenuAnchor(anchor);
    setNewAssetMenuOpen(true);
  }, [busy, selectedRootWritable]);
  const openNewAssetDialog = useCallback((type: CreatableAssetType) => {
    if (busy || !selectedRootWritable) return;
    setNewAssetType(type);
    setNewAssetName("");
    setNewTimelineAsset(allAssets.find((asset) => asset.header.type === "Timeline")?.header.guid ?? null);
    setNewAssetFolder(selectedFolderPath);
    setNewAssetOpen(true);
  }, [busy, selectedFolderPath, selectedRootWritable, setNewAssetOpen, setNewAssetType]);

  const handleCreateAsset = useCallback(async () => {
    const destination = contentBrowserFolderOps(newAssetFolder, browserRoots);
    if (!assetRegistry || newAssetTakenError || destination.readOnly) return;
    const name = newAssetName.trim();
    if (!name || contentEntryNameError(name)) return;
    setBusy(true);
    setOperationError(null);
    try {
      const type = newAssetType;
      // A clip needs its Timeline Asset first: the chosen one, or a new one beside it.
      let timelineAsset: string | undefined;
      if (type === "TimelineClip2D" || type === "TimelineClip3D") {
        timelineAsset = newTimelineAsset ?? (await createProjectAsset({
          registry: assetRegistry,
          rootId: destination.rootId,
          folderRelative: destination.relative,
          type: "Timeline",
          name: `${name} Timeline`,
        })).header.guid;
      }
      const created = await createProjectAsset({
        registry: assetRegistry,
        rootId: destination.rootId,
        folderRelative: destination.relative,
        type,
        name,
        parentClass: type === "Class" ? newAssetParent : null,
        waterMaterial: type === "Material" && newWaterStarter ? true : undefined,
        defaultDefinitionGuid: newDataDefinition,
        typeSchemas: type === "DataDefinition" || type === "DataTree" ? typeSchemasFromGraphAssets(newDataTypes) : undefined,
        classParentOf,
        parentGraphs:
          type === "Class"
            ? collectClassGraphsForPalette({
                assets: allAssets,
                openDocuments: getOpenDocuments(),
                classIdForPath: classIdForGraphPath,
              })
            : undefined,
        viewportMode: type === "Prefab" ? openSceneViewportMode(getOpenDocuments(), activeDocumentId) : undefined,
        timelineAsset,
      });
      setNewAssetOpen(false);
      // A Location changed in the dialog shows the folder the asset went to.
      if (newAssetFolder !== selectedFolderPath) {
        setSelectedFolderPath(newAssetFolder);
        setSelectedGuids(new Set());
        setSelectedFolderPaths(new Set());
      }
      // The mounted registry indexed the asset on write; a remount would
      // rescan every root while the new tile waits.
      noteAssetsCreated();
      if (type === "Scene" || type === "DataDefinition" || type === "DataTree" || type === "TimelineClip2D" || type === "TimelineClip3D") {
        await openOrFocusDocument(created);
      }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [
    activeDocumentId,
    allAssets,
    assetRegistry,
    browserRoots,
    classParentOf,
    newAssetFolder,
    newAssetName,
    newAssetTakenError,
    newAssetParent,
    newDataDefinition,
    newDataTypes,
    newTimelineAsset,
    newWaterStarter,
    newAssetType,
    getOpenDocuments,
    noteAssetsCreated,
    openOrFocusDocument,
    selectedFolderPath,
    setBusy,
    setNewAssetOpen,
    setOperationError,
    setSelectedFolderPath,
    setSelectedFolderPaths,
    setSelectedGuids,
  ]);

  const menuProps: Omit<ComponentProps<typeof ContentBrowserNewAssetMenu>, "children"> = {
    open: newAssetMenuOpen,
    onOpenChange: (open) => {
      if (open) setNewAssetMenuAnchor(null);
      setNewAssetMenuOpen(open);
    },
    anchor: newAssetMenuAnchor,
    onSelect: openNewAssetDialog,
  };
  const dialogProps: ContentBrowserNewAssetDialogProps = {
    open: newAssetOpen,
    onOpenChange: (open) => {
      setNewAssetOpen(open);
      if (open) setNewAssetName("");
    },
    type: newAssetType,
    name: newAssetName,
    onNameChange: setNewAssetName,
    parentClass: newAssetParent,
    waterStarter: newWaterStarter,
    onWaterStarterChange: setNewWaterStarter,
    definitionGuid: newDataDefinition,
    onDefinitionGuidChange: setNewDataDefinition,
    definitionAssets: newDataTypes.dataDefinitions.map(definition => ({ guid: definition.guid, name: definition.name, type: "DataDefinition" })),
    timelineAssetGuid: newTimelineAsset,
    onTimelineAssetGuidChange: setNewTimelineAsset,
    timelineAssets: allAssets.filter((asset) => asset.header.type === "Timeline").map((asset) => ({ guid: asset.header.guid, name: asset.header.name, type: "Timeline" })),
    onParentClassChange: setNewAssetParent,
    classAssets: allAssets.filter((asset) => asset.header.type === "Class"),
    takenNameError: newAssetTakenError,
    destinationFolder: newAssetFolder,
    onDestinationFolderChange: setNewAssetFolder,
    folderTrees,
    isFolderDisabled: isReadOnlyFolder,
    error: operationError,
    busy,
    onCreate: () => {
      void handleCreateAsset();
    },
  };

  return { openNewAssetMenu, menuProps, dialogProps };
}
