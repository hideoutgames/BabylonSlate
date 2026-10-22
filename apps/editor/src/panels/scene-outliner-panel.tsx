import { SimulationOutliner } from "./simulation-outliner";
import { useSimulationInspectionStore } from "../context/simulation-inspection-context";
import { usePlaySimulationDocumentId } from "../context/play-context";
import type { IDockviewPanelProps } from "dockview-react";
import type { IndexedAsset } from "@haptic/assets";
import {
  memo,
  type ComponentProps,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  NamePromptDialog,
  NestedMenu,
  PanelFrame,
  SearchInput,
  TreeView,
  TypeVisualIcon,
  engineParentOf,
  resolveActorTypeVisual,
  walkAncestry,
  type NestedMenuItem,
  type TreeDropPlacement,
  type TreeSelectOptions,
  type TreeViewNode,
} from "@haptic/editor-kit";
import {
  actorSubtree,
  isSceneLayerAnchorActor,
  folderSubtree,
  nextFolderId,
  type SerializedActor,
  type SerializedGraph,
  type SerializedOutlinerFolder,
  type SerializedScene,
} from "@haptic/core";
import { isSceneWorkspaceKind } from "@haptic/core";
import { Button } from "@haptic/ui/components/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { Toggle } from "@haptic/ui/components/toggle";
import {
  CopyIcon,
  ClipboardPasteIcon,
  CopyPlusIcon,
  EyeIcon,
  EyeOffIcon,
  FocusIcon,
  FolderIcon,
  FolderPlusIcon,
  LockIcon,
  MousePointerClickIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  UnlockIcon,
  PlusIcon,
} from "lucide-react";
import { GraphDropHint, type GraphDropHintState } from "@haptic/graph-ui";
import {
  useDocumentActions,
  useRegistryState,
  useEditorShellState,
  useOpenDocument,
} from "../context/document-context";
import { useEditorSessionState } from "../context/editor-session-state-context";
import { copySceneActors, pasteSceneActors } from "../lib/scene-actor-clipboard";
import { useKeybindCommand, useKeybindings } from "../context/keybind-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  FALLBACK_PLACE_POSITION,
  useSceneEditing,
  selectionAfterLockChange,
} from "../context/scene-editing-context";
import { IconActionButton } from "../components/icon-action-button";
import { usePhoneTouchSizing } from "../shell/use-platform-layout";
import { QUIET_ROW_ACTION } from "../lib/row-action-classes";
import { PlaceActorsDialog } from "../components/place-actors-dialog";
import {
  duplicateSceneActor,
  duplicateSceneActors,
  nextActorId,
  prefabComponentsForGuid,
  prefabComponentsResolver,
  projectPlaceActors,
  spawnPlacedActor,
  type PlaceActorItem,
} from "../lib/place-actors";
import {
  classIdFromClassAsset,
  classParentLookup,
} from "../lib/content-browser-helpers";
import { authoredPrefabComponents } from "../lib/prefab-preview";
import { sceneActorDisplayNames } from "../lib/scene-actor-names";
import {
  actorRowId,
  applyOutlinerDropMoves,
  applyOutlinerRowSelect,
  folderRowId,
  outlinerRowTarget,
  outlinerTreeDropMoves,
} from "../lib/outliner-drop";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { useRetainedValue } from "../lib/use-retained-value";
import { prefabAssetTemplateKey, prefabAssetTemplates } from "../lib/prefab-instance-sync";

const CLASS_KINDS = ["graph"] as const;
const PREFAB_KINDS = ["prefab"] as const;

const NO_MENU_ITEMS: NestedMenuItem[] = [];
const NO_PLACE_ACTOR_ITEMS: PlaceActorItem[] = [];

const defaultParentOf = (id: string): string | null => engineParentOf(id) ?? null;

/**
 * Type glyph of an actor row. The row carries the actor's data and the glyph
 * resolves when the row renders, so only the mounted window of a long
 * Outliner pays for ancestry walks, and an unchanged actor skips rendering.
 */
const OutlinerActorIcon = memo(function OutlinerActorIcon({
  actorId,
  classId,
  components,
  parentOf,
}: {
  actorId: string;
  classId: string;
  components: SerializedActor["components"];
  parentOf: (id: string) => string | null;
}) {
  return (
    <TypeVisualIcon
      visual={resolveActorTypeVisual({
        classId,
        components,
        ancestry: walkAncestry(classId, parentOf),
      })}
      data-testid={`outliner-type-icon-${actorId}`}
    />
  );
});

/** The panel callbacks a row's controls run; each closes over the render that made it. */
interface OutlinerRowHandlers {
  toggleFlag: (actorId: string, flag: "visible" | "locked") => void;
  actorMenuItems: (actorId: string) => NestedMenuItem[];
  folderMenuItems: (folderId: string) => NestedMenuItem[];
}

/**
 * What a row's controls call. The panel keeps one stable instance whose
 * members run the latest handlers, so rows keep their elements while the
 * selection, clipboard and scene callbacks change underneath them. A menu's
 * items close over the scene and selection they were built from, so a row
 * whose menu is open subscribes to `revision` and rebuilds them when that
 * state changes: a click always acts on the current Scene.
 */
interface OutlinerRowActions extends OutlinerRowHandlers {
  subscribe: (listener: () => void) => () => void;
  getRevision: () => number;
}

type RowActionSize = "touch-icon" | "icon-sm";

const subscribeToNothing = () => () => {};

/**
 * The items of a row menu: rebuilt from the latest handlers each time the
 * menu opens or what they were built from changes, and kept while it fades
 * out so the closing popup is not an empty box.
 */
function useRowMenuItems(
  menuOpen: boolean,
  actions: OutlinerRowActions,
  build: () => NestedMenuItem[],
): NestedMenuItem[] {
  useSyncExternalStore(
    menuOpen ? actions.subscribe : subscribeToNothing,
    actions.getRevision,
  );
  return useRetainedValue(menuOpen ? build() : null, NO_MENU_ITEMS);
}

/**
 * Visibility, lock and menu controls of an actor row. The menu's items are
 * built when it opens rather than for every row on every selection change.
 */
const ActorRowActions = memo(function ActorRowActions({
  actorId,
  label,
  muted,
  locked,
  touchSizing,
  actionSize,
  actions,
}: {
  actorId: string;
  label: string;
  muted: boolean;
  locked: boolean;
  touchSizing: boolean;
  actionSize: RowActionSize;
  actions: OutlinerRowActions;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuItems = useRowMenuItems(menuOpen, actions, () => actions.actorMenuItems(actorId));
  return (
    <>
      <IconActionButton
        label={`Toggle visibility of ${label}`}
        size={actionSize}
        variant="ghost"
        onClick={() => actions.toggleFlag(actorId, "visible")}
        data-testid={`outliner-visibility-${actorId}`}
        aria-pressed={!muted}
        className="outliner-flag"
        data-active={muted}
      >
        {muted ? <EyeOffIcon /> : <EyeIcon />}
      </IconActionButton>
      <Toggle
        aria-label={`${locked ? "Unlock" : "Lock"} ${label}`}
        title={`${locked ? "Unlock" : "Lock"} ${label}`}
        size={touchSizing ? "touch" : "sm"}
        onPressedChange={() => actions.toggleFlag(actorId, "locked")}
        data-testid={`outliner-lock-${actorId}`}
        pressed={locked}
        className="outliner-flag px-0"
        data-active={locked}
      >
        {locked ? <LockIcon /> : <UnlockIcon />}
      </Toggle>
      <NestedMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        items={menuItems}
        trigger={
          <Button
            type="button"
            variant="ghost"
            size={actionSize}
            aria-label={`Actor menu for ${label}`}
            className={QUIET_ROW_ACTION}
            data-testid={`outliner-menu-${actorId}`}
          >
            <MoreHorizontalIcon />
          </Button>
        }
      />
    </>
  );
});

/** The menu control of a folder row; its items are built when it opens. */
const FolderRowActions = memo(function FolderRowActions({
  rowId,
  folderId,
  label,
  actionSize,
  actions,
}: {
  rowId: string;
  folderId: string;
  label: string;
  actionSize: RowActionSize;
  actions: OutlinerRowActions;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuItems = useRowMenuItems(menuOpen, actions, () => actions.folderMenuItems(folderId));
  return (
    <NestedMenu
      open={menuOpen}
      onOpenChange={setMenuOpen}
      items={menuItems}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size={actionSize}
          aria-label={`Folder menu for ${label}`}
          data-testid={`outliner-menu-${rowId}`}
        >
          <MoreHorizontalIcon />
        </Button>
      }
    />
  );
});

const MemoPlaceActorsDialog = memo(PlaceActorsDialog);

/**
 * Place Actors with its own thumbnail subscription: each captured thumbnail
 * re-renders this host, not the Outliner, and the dialog sees the versions
 * only while it is open (it loads thumbnails only then).
 */
function PlaceActorsDialogHost(
  props: Omit<ComponentProps<typeof PlaceActorsDialog>, "thumbnailVersions">,
) {
  const { thumbnailVersions } = useEditorShellState();
  return (
    <MemoPlaceActorsDialog
      {...props}
      thumbnailVersions={props.open ? thumbnailVersions : undefined}
    />
  );
}

/**
 * The parent a row is listed under. A parent that is not in the scene, or a
 * chain that loops back to the row, lists it at the root so it stays visible.
 */
function listedParent(
  id: string,
  parentById: ReadonlyMap<string, string | null>,
): string | null {
  const parent = parentById.get(id) ?? null;
  if (parent === null || !parentById.has(parent)) return null;
  const seen = new Set<string>();
  let cursor: string | null = parent;
  while (cursor !== null && parentById.has(cursor) && !seen.has(cursor)) {
    if (cursor === id) return null;
    seen.add(cursor);
    cursor = parentById.get(cursor) ?? null;
  }
  return parent;
}

/**
 * Depth-first walk so children follow their parent in the flattened list.
 * Folders come first at each level, then the actors they hold. Transform
 * children stay under their parent actor regardless of folder, because
 * `parentId` is attachment and `folderId` is only organization.
 */
export function flattenOutliner(
  scene: SerializedScene,
  options: {
    collapsed: ReadonlySet<string>;
    search: string;
    parentOf?: (id: string) => string | null;
  },
): TreeViewNode[] {
  const parentOf = options.parentOf ?? defaultParentOf;
  const actorIcon = (actor: SerializedActor) => (
    <OutlinerActorIcon
      actorId={actor.id}
      classId={actor.classId}
      components={actor.components}
      parentOf={parentOf}
    />
  );
  const folderIcon = (folder: SerializedOutlinerFolder) => (
    <FolderIcon data-testid={`outliner-folder-icon-${folder.id}`} />
  );

  const names = sceneActorDisplayNames(scene);
  const needle = options.search.trim().toLowerCase();
  const actorParentById = new Map(
    scene.actors.map((actor) => [actor.id, actor.parentId]),
  );
  const folderParentById = new Map(
    scene.folders.map((folder) => [folder.id, folder.parentFolderId]),
  );
  const childrenOf = new Map<string | null, SerializedActor[]>();
  for (const actor of scene.actors) {
    const parentId = listedParent(actor.id, actorParentById);
    const bucket = childrenOf.get(parentId) ?? [];
    bucket.push(actor);
    childrenOf.set(parentId, bucket);
  }
  const foldersByParent = new Map<string | null, SerializedOutlinerFolder[]>();
  for (const folder of scene.folders) {
    const parentFolderId = listedParent(folder.id, folderParentById);
    const bucket = foldersByParent.get(parentFolderId) ?? [];
    bucket.push(folder);
    foldersByParent.set(parentFolderId, bucket);
  }
  const folderById = new Map(
    scene.folders.map((folder) => [folder.id, folder]),
  );

  const folderPath = (folderId: string | null): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cursor = folderId;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const folder = folderById.get(cursor);
      if (!folder) break;
      parts.unshift(folder.name);
      cursor = folder.parentFolderId;
    }
    return parts.join(" / ");
  };

  if (needle) {
    // Search flattens the hierarchy: matches are what the user is looking for.
    const rows: TreeViewNode[] = [];
    for (const folder of scene.folders) {
      if (!folder.name.toLowerCase().includes(needle)) continue;
      rows.push({
        id: folderRowId(folder.id),
        label: folderPath(folder.id),
        renamable: true,
        renameValue: folder.name,
        depth: 0,
        hasChildren: false,
        expanded: false,
        icon: folderIcon(folder),
      });
    }
    for (const actor of scene.actors) {
      if (!actor.name.toLowerCase().includes(needle)) continue;
      const path = folderPath(actor.folderId);
      rows.push({
        id: actorRowId(actor.id),
        label: path ? `${path} / ${names.get(actor.id)!}` : names.get(actor.id)!,
        renamable: true,
        renameValue: actor.name,
        depth: 0,
        hasChildren: false,
        expanded: false,
        muted: !actor.visible,
        icon: actorIcon(actor),
      });
    }
    return rows;
  }

  const rows: TreeViewNode[] = [];

  const walkActors = (parentId: string | null, depth: number) => {
    for (const actor of childrenOf.get(parentId) ?? []) {
      const children = childrenOf.get(actor.id) ?? [];
      const rowId = actorRowId(actor.id);
      const expanded = !options.collapsed.has(rowId);
      rows.push({
        id: rowId,
        label: names.get(actor.id)!,
        renamable: true,
        renameValue: actor.name,
        depth,
        hasChildren: children.length > 0,
        expanded,
        muted: !actor.visible,
        icon: actorIcon(actor),
      });
      if (expanded) walkActors(actor.id, depth + 1);
    }
  };

  const rootActorsByFolder = new Map<
    string | null | undefined,
    SerializedActor[]
  >();
  for (const actor of childrenOf.get(null) ?? []) {
    const folderId =
      actor.folderId !== null && folderById.has(actor.folderId)
        ? actor.folderId
        : null;
    const bucket = rootActorsByFolder.get(folderId) ?? [];
    bucket.push(actor);
    rootActorsByFolder.set(folderId, bucket);
  }
  const actorsAtFolderRoot = (folderId: string | null) =>
    rootActorsByFolder.get(folderId) ?? [];

  const walkFolders = (parentFolderId: string | null, depth: number) => {
    for (const folder of foldersByParent.get(parentFolderId) ?? []) {
      const rowId = folderRowId(folder.id);
      const expanded = !options.collapsed.has(rowId);
      const hasChildren =
        (foldersByParent.get(folder.id)?.length ?? 0) > 0 ||
        actorsAtFolderRoot(folder.id).length > 0;
      rows.push({
        id: rowId,
        label: folder.name,
        renamable: true,
        depth,
        hasChildren,
        expanded,
        icon: folderIcon(folder),
      });
      if (!expanded) continue;
      walkFolders(folder.id, depth + 1);
      for (const actor of actorsAtFolderRoot(folder.id)) {
        const children = childrenOf.get(actor.id) ?? [];
        const actorRow = actorRowId(actor.id);
        const actorExpanded = !options.collapsed.has(actorRow);
        rows.push({
          id: actorRow,
          label: names.get(actor.id)!,
        renamable: true,
        renameValue: actor.name,
          depth: depth + 1,
          hasChildren: children.length > 0,
          expanded: actorExpanded,
          muted: !actor.visible,
          icon: actorIcon(actor),
        });
        if (actorExpanded) walkActors(actor.id, depth + 2);
      }
    }
  };

  walkFolders(null, 0);
  for (const actor of actorsAtFolderRoot(null)) {
    const children = childrenOf.get(actor.id) ?? [];
    const rowId = actorRowId(actor.id);
    const expanded = !options.collapsed.has(rowId);
    rows.push({
      id: rowId,
      label: names.get(actor.id)!,
      renamable: true,
      renameValue: actor.name,
      depth: 0,
      hasChildren: children.length > 0,
      expanded,
      muted: !actor.visible,
      icon: actorIcon(actor),
    });
    if (expanded) walkActors(actor.id, 1);
  }
  return rows;
}

export function SceneOutlinerPanel(props: IDockviewPanelProps) {
  const { documentId } = useDocumentWorkspace();
  const simulationDocumentId = usePlaySimulationDocumentId();
  const store = useSimulationInspectionStore();
  return store && simulationDocumentId === documentId
    ? <SimulationOutliner store={store} panel={props} />
    : <AuthoringSceneOutlinerPanel {...props} />;
}

function AuthoringSceneOutlinerPanel(_props: IDockviewPanelProps) {
  void _props;
  const touchSizing = usePhoneTouchSizing();
  const actionSize = touchSizing ? "touch-icon" : "icon-sm";
  const { documentId } = useDocumentWorkspace();
  const {
    getOpenDocuments,
    applySceneChange,
    loadGraphDocument,
    openDocument,
    loadAssetThumbnail,
  } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const classDocuments = useOpenDocumentsOfKinds(CLASS_KINDS);
  const prefabDocuments = useOpenDocumentsOfKinds(PREFAB_KINDS);
  const {
    selectedActorIds,
    selectActor,
    setSelectedActorIds,
    frameActor,
    viewportDropApi,
  } = useSceneEditing();
  const keybinds = useKeybindings();
  const sessionState = useEditorSessionState();
  const [, setClipboardRevision] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [placeOpen, setPlaceOpen] = useState(false);
  const outlinerRef = useRef<HTMLDivElement>(null);
  const [renameFolderId, setRenameFolderId] = useState<string | null>(null);
  const [renamingRowId, setRenamingRowId] = useState<string | null>(null);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const [deleteActorChoice, setDeleteActorChoice] = useState<{
    actorId: string;
    selectedIds: string[];
  } | null>(null);
  const [selectedFolderIds, setSelectedFolderIds] = useState<string[]>([]);
  const [dropHint, setDropHint] = useState<GraphDropHintState | null>(null);
  const [diskGraphs, setDiskGraphs] = useState<Map<string, SerializedGraph>>(
    () => new Map(),
  );

  const doc = useOpenDocument(documentId);
  const scene = isSceneWorkspaceKind(doc?.ref.kind)
    ? (doc.content as SerializedScene)
    : null;
  const overlay = doc?.ref.kind === "scene-layer";

  const actorById = useMemo(() => {
    const actors = new Map<string, SerializedActor>();
    for (const actor of scene?.actors ?? []) {
      if (!actors.has(actor.id)) actors.set(actor.id, actor);
    }
    return actors;
  }, [scene]);
  const selectedActorIdSet = useMemo(
    () => new Set(selectedActorIds),
    [selectedActorIds],
  );
  // Registry entries can change without replacing the registry instance.
  const classAssetById = useMemo(() => {
    void registryEpoch;
    const assets = new Map<string, IndexedAsset>();
    for (const asset of assetRegistry?.list() ?? []) {
      if (asset.header.type !== "Class") continue;
      const classId = classIdFromClassAsset(asset);
      if (!assets.has(classId)) assets.set(classId, asset);
    }
    return assets;
  }, [assetRegistry, registryEpoch]);

  const parentOf = useMemo(() => {
    void registryEpoch;
    return classParentLookup(assetRegistry?.list() ?? []);
  }, [assetRegistry, registryEpoch]);

  const nodes = useMemo(
    () =>
      scene ? flattenOutliner(scene, { collapsed, search, parentOf }) : [],
    [collapsed, parentOf, scene, search],
  );
  const lockedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const actor of scene?.actors ?? []) {
      if (actor.locked) ids.add(actor.id);
    }
    return ids;
  }, [scene]);

  const mutate = useCallback(
    (next: SerializedScene) => {
      void applySceneChange(documentId, next);
    },
    [applySceneChange, documentId],
  );

  const copyActors = useCallback((ids: readonly string[]) => {
    if (!scene || ids.length === 0) return;
    sessionState.copyActors(copySceneActors(scene, ids), overlay);
    setClipboardRevision((revision) => revision + 1);
  }, [scene, sessionState, overlay]);
  const pasteActors = useCallback(async () => {
    if (!scene) return;
    const copies = pasteSceneActors(scene, sessionState.readCopiedActors(overlay));
    if (copies.length === 0) return;
    const applied = await applySceneChange(documentId, { ...scene, actors: [...scene.actors, ...copies] });
    if (applied) setSelectedActorIds(copies.map((copy) => copy.id));
  }, [scene, sessionState, overlay, applySceneChange, documentId, setSelectedActorIds]);
  const canPaste = sessionState.hasCopiedActors(overlay);

  const selectedRowIds = useMemo(
    () => [
      ...selectedFolderIds.map((id) => folderRowId(id)),
      ...selectedActorIds.map((id) => actorRowId(id)),
    ],
    [selectedActorIds, selectedFolderIds],
  );
  const selectedRowId = selectedRowIds[0] ?? null;

  const setSelectedRowId = useCallback(
    (rowId: string | null, options?: TreeSelectOptions) => {
      if (!rowId) {
        setSelectedFolderIds([]);
        selectActor(null);
        return;
      }
      const next = applyOutlinerRowSelect(
        rowId,
        options,
        nodes.map((node) => node.id),
        selectedRowIds,
      );
      setSelectedFolderIds(next.folderIds);
      if (next.actorIds.length === 0) {
        selectActor(null);
        return;
      }
      if (options?.range || options?.additive || next.actorIds.length > 1) {
        setSelectedActorIds(next.actorIds);
        return;
      }
      selectActor(next.actorIds[0] ?? null);
    },
    [nodes, selectActor, selectedRowIds, setSelectedActorIds],
  );

  // The Place Actors list covers every placeable asset and Class graph, so it
  // is built only while the dialog is open; closed, it keeps the last list so
  // the dialog fades out intact, and the next open rebuilds it.
  const openProjectItems = useMemo(() => {
    if (!placeOpen) return null;
    void registryEpoch; // Registry headers mutate without replacing the registry.
    const assets = assetRegistry?.list() ?? [];
    // Prefab assets carry their components in the header; open tabs win.
    const prefabAssets = prefabAssetTemplates({ assets, openDocuments: prefabDocuments });
    const openClassDocuments = new Map<string, (typeof classDocuments)[number]>();
    for (const entry of classDocuments) {
      if (!openClassDocuments.has(entry.ref.path)) openClassDocuments.set(entry.ref.path, entry);
    }
    const classPrefab = prefabComponentsResolver({
      assets,
      graphForPath: (path) => {
        const open = openClassDocuments.get(path);
        if (open?.content) return open.content as SerializedGraph;
        return diskGraphs.get(path);
      },
    });
    return projectPlaceActors(
      assets,
      (guid) => prefabAssets[prefabAssetTemplateKey(guid)] ?? classPrefab(guid),
      { overlay },
    );
  }, [assetRegistry, classDocuments, diskGraphs, overlay, placeOpen, prefabDocuments, registryEpoch]);
  const projectItems = useRetainedValue(openProjectItems, NO_PLACE_ACTOR_ITEMS);

  useEffect(() => {
    if (!placeOpen) return;
    let cancelled = false;
    const assets = assetRegistry?.list() ?? [];
    void (async () => {
      // Load the Classes together, so the slowest one sets the wait, not the sum.
      const loaded = await Promise.all(
        assets
          .filter((asset) => asset.header.type === "Class" && asset.path)
          .map(async (asset) => [asset.path, await loadGraphDocument(asset.path)] as const),
      );
      if (cancelled) return;
      const next = new Map<string, SerializedGraph>();
      for (const [path, graph] of loaded) if (graph) next.set(path, graph);
      setDiskGraphs(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [assetRegistry, loadGraphDocument, placeOpen]);

  const addActor = useCallback(
    (item: PlaceActorItem) => {
      if (!scene) return;
      const finish = (resolved: PlaceActorItem) => {
        const id = nextActorId(scene);
        mutate({
          ...scene,
          actors: [
            ...scene.actors,
            spawnPlacedActor(
              scene,
              resolved,
              id,
              viewportDropApi?.worldPositionAtViewCenter() ??
                FALLBACK_PLACE_POSITION,
              { overlay },
            ),
          ],
        });
        selectActor(id);
        setPlaceOpen(false);
        // The dialog keeps focus until its exit animation ends, outside the
        // outliner's focus gate, so an immediate Delete would be ignored.
        outlinerRef.current?.querySelector<HTMLElement>('[role="tree"]')?.focus({ preventScroll: true });
      };
      if (
        item.kind.type === "asset" &&
        item.kind.assetType === "Class" &&
        !item.kind.components
      ) {
        const kind = item.kind;
        const asset = (assetRegistry?.list() ?? []).find(
          (entry) => entry.header.guid === kind.guid,
        );
        if (asset?.path) {
          void loadGraphDocument(asset.path).then((graph) => {
            finish({
              ...item,
              kind: {
                ...kind,
                components:
                  prefabComponentsForGuid(kind.guid, {
                    assets: assetRegistry?.list() ?? [],
                    graphForPath: (path) => {
                      if (path === asset.path && graph) return graph;
                      // Read when the load finishes, not at the click.
                      const open = getOpenDocuments().find(
                        (entry) =>
                          entry.ref.kind === "graph" && entry.ref.path === path,
                      );
                      if (open?.content) return open.content as SerializedGraph;
                      return diskGraphs.get(path);
                    },
                  }) ??
                  (graph ? authoredPrefabComponents(graph) : kind.components),
              },
            });
          });
          return;
        }
      }
      finish(item);
    },
    [
      assetRegistry,
      diskGraphs,
      getOpenDocuments,
      loadGraphDocument,
      mutate,
      scene,
      selectActor,
      viewportDropApi,
    ],
  );

  const removeActors = useCallback(
    (actorIds: readonly string[]) => {
      if (!scene) return;
      const doomed = new Set(
        actorIds.flatMap((actorId) =>
          actorSubtree(scene, actorId).map((actor) => actor.id),
        ),
      );
      mutate({
        ...scene,
        actors: scene.actors.filter((actor) => !doomed.has(actor.id)),
      });
      setSelectedActorIds(selectedActorIds.filter((id) => !doomed.has(id)));
      setDeleteActorChoice(null);
    },
    [mutate, scene, selectedActorIds, setSelectedActorIds],
  );

  const toggleFlag = useCallback(
    (actorId: string, flag: "visible" | "locked") => {
      if (!scene) return;
      const current = scene.actors.find((actor) => actor.id === actorId);
      if (!current) return;
      const nextValue = !current[flag];
      mutate({
        ...scene,
        actors: scene.actors.map((actor) =>
          actor.id === actorId ? { ...actor, [flag]: nextValue } : actor,
        ),
      });
      if (flag === "locked") {
        setSelectedActorIds(
          selectionAfterLockChange(selectedActorIds, actorId, nextValue),
        );
      }
    },
    [mutate, scene, selectedActorIds, setSelectedActorIds],
  );

  const addFolder = useCallback(() => {
    if (!scene) return;
    const id = nextFolderId(scene);
    const selected = outlinerRowTarget(selectedRowId);
    // Creating from a selected folder nests inside it, like Content Browser.
    const parentFolderId = selected?.kind === "folder" ? selected.id : null;
    const taken = new Set(scene.folders.map((folder) => folder.name));
    let name = "New Folder";
    let suffix = 2;
    while (taken.has(name)) {
      name = `New Folder ${suffix}`;
      suffix += 1;
    }
    mutate({
      ...scene,
      folders: [...scene.folders, { id, name, parentFolderId }],
    });
    setSelectedRowId(folderRowId(id));
  }, [mutate, scene, selectedRowId]);

  const renameFolder = useCallback(
    (folderId: string, name: string) => {
      if (!scene) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      mutate({
        ...scene,
        folders: scene.folders.map((folder) =>
          folder.id === folderId ? { ...folder, name: trimmed } : folder,
        ),
      });
    },
    [mutate, scene],
  );

  const finishRowRename = useCallback(
    (rowId: string, name: string | null) => {
      setRenamingRowId(null);
      const target = outlinerRowTarget(rowId);
      if (!scene || name === null || !target) return;
      if (target.kind === "folder") {
        renameFolder(target.id, name);
        return;
      }
      mutate({
        ...scene,
        actors: scene.actors.map((actor) =>
          actor.id === target.id ? { ...actor, name } : actor,
        ),
      });
    },
    [mutate, renameFolder, scene],
  );

  /** Keep each choice in one scene mutation so undo restores the whole operation. */
  const removeFolder = useCallback(
    (folderId: string, deleteContents: boolean) => {
      if (!scene) return;
      const folder = scene.folders.find((entry) => entry.id === folderId);
      if (!folder) return;
      const promoteTo = folder.parentFolderId;
      const doomedFolders = new Set(
        (deleteContents ? folderSubtree(scene, folderId) : [folder]).map(
          (entry) => entry.id,
        ),
      );
      const doomedActors = new Set<string>();
      if (deleteContents) {
        // Attachment children appear beneath their parent actor, even when
        // their own folderId is unset or names a different folder.
        for (const actor of scene.actors) {
          if (actor.folderId === null || !doomedFolders.has(actor.folderId))
            continue;
          for (const child of actorSubtree(scene, actor.id)) {
            doomedActors.add(child.id);
          }
        }
      }
      mutate({
        ...scene,
        folders: scene.folders
          .filter((entry) => !doomedFolders.has(entry.id))
          .map((entry) =>
            entry.parentFolderId === folderId
              ? { ...entry, parentFolderId: promoteTo }
              : entry,
          ),
        actors: scene.actors
          .filter((actor) => !doomedActors.has(actor.id))
          .map((actor) =>
            actor.folderId === folderId
              ? { ...actor, folderId: promoteTo }
              : actor,
          ),
      });
      setDeleteFolderId(null);
      setSelectedRowId(null);
    },
    [mutate, scene],
  );

  /**
   * Drop on a folder groups; drop on an actor attaches; drop on empty space
   * clears both. Before/after a row inserts as a sibling of that row instead.
   * A selected drag moves collapsed roots only so parent+child picks cannot
   * double-move or duplicate rows.
   */
  const reparentRow = useCallback(
    (
      dragRowId: string,
      targetRowId: string | null,
      placement?: TreeDropPlacement,
    ) => {
      if (!scene) return;
      const moves = outlinerTreeDropMoves({
        dragRowId,
        targetRowId,
        selectedRowIds,
        scene,
        placement,
      });
      if (moves.length === 0) return;
      mutate(applyOutlinerDropMoves(scene, moves));
    },
    [mutate, scene, selectedRowIds],
  );

  const dropActorRow = useCallback(
    (rowId: string, clientX: number, clientY: number) => {
      if (!scene) return;
      const target = outlinerRowTarget(rowId);
      if (target?.kind !== "actor") return;
      if (!viewportDropApi?.containsClientPoint(clientX, clientY)) return;
      const source = scene.actors.find((actor) => actor.id === target.id);
      if (!source || isSceneLayerAnchorActor(source)) return;
      const position = viewportDropApi.worldPositionAtClient(clientX, clientY);
      if (!position) return;
      const copy = duplicateSceneActor(scene, source, {
        position,
        parentId: null,
      });
      mutate({
        ...scene,
        actors: [...scene.actors, copy],
      });
      selectActor(copy.id);
    },
    [mutate, scene, selectActor, viewportDropApi],
  );

  const moveActorDropHint = useCallback(
    (rowId: string, clientX: number, clientY: number) => {
      const target = outlinerRowTarget(rowId);
      if (target?.kind !== "actor") {
        setDropHint({ clientX, clientY, allowed: false });
        return;
      }
      const actor = scene?.actors.find((actor) => actor.id === target.id);
      const name = actor?.name ?? "Actor";
      setDropHint({
        clientX,
        clientY,
        allowed: Boolean(
          actor && !isSceneLayerAnchorActor(actor) && viewportDropApi?.containsClientPoint(clientX, clientY),
        ),
        label: name,
      });
    },
    [scene, viewportDropApi],
  );

  const actorMenuItems = useCallback((actorId: string): NestedMenuItem[] => {
    const actor = actorById.get(actorId);
    const classAsset = actor ? classAssetById.get(actor.classId) : undefined;
    const items: NestedMenuItem[] = [];
    if (classAsset) {
      items.push({
        id: "open-actor",
        label: "Open Actor",
        icon: <SquareArrowOutUpRightIcon />,
        testId: `outliner-open-actor-${actorId}`,
        onSelect: () => {
          void openDocument({
            kind: "graph",
            path: classAsset.path,
            label: classAsset.header.name,
          });
        },
      });
    }
    items.push(
      {
        id: "select-actor",
        label: selectedActorIdSet.has(actorId) ? "Deselect" : "Select",
        icon: <MousePointerClickIcon />,
        testId: `outliner-select-${actorId}`,
        onSelect: () => selectActor(actorId, true),
      },
      {
        id: "frame-actor",
        label: "Frame Selection",
        icon: <FocusIcon />,
        shortcut: keybinds.get("viewport.frameSelection")?.[0],
        testId: `outliner-frame-${actorId}`,
        onSelect: () => frameActor(actorId),
      },
      {
        id: "copy-actors",
        label: "Copy",
        icon: <CopyIcon />,
        shortcut: keybinds.get("edit.copy")?.[0],
        onSelect: () => copyActors(selectedActorIdSet.has(actorId) ? selectedActorIds : [actorId]),
      },
      {
        id: "paste-actors",
        label: "Paste",
        icon: <ClipboardPasteIcon />,
        shortcut: keybinds.get("edit.paste")?.[0],
        disabled: !canPaste,
        onSelect: () => { void pasteActors(); },
      },
      {
        id: "duplicate-actor",
        label: "Duplicate",
        icon: <CopyPlusIcon />,
        shortcut: keybinds.get("edit.duplicate")?.[0],
        testId: `outliner-duplicate-${actorId}`,
        onSelect: () => {
          if (!scene) return;
          const source = scene.actors.find((entry) => entry.id === actorId);
          if (!source) return;
          const copy = duplicateSceneActor(scene, source);
          mutate({
            ...scene,
            actors: [...scene.actors, copy],
          });
          selectActor(copy.id);
        },
      },
      { type: "separator", id: "delete-separator" },
      {
        id: "delete-actor",
        label: "Delete",
        icon: <Trash2Icon />,
        variant: "destructive",
        shortcut: keybinds.get("edit.delete")?.[0],
        testId: `outliner-delete-${actorId}`,
        onSelect: () => {
          if (selectedActorIds.length > 1) {
            setDeleteActorChoice({ actorId, selectedIds: [...selectedActorIds] });
          } else {
            removeActors([actorId]);
          }
        },
      },
    );
    return items;
  }, [
    actorById,
    canPaste,
    copyActors,
    pasteActors,
    classAssetById,
    frameActor,
    keybinds,
    mutate,
    openDocument,
    removeActors,
    scene,
    selectActor,
    selectedActorIdSet,
    selectedActorIds,
  ]);

  const folderMenuItems = useCallback(
    (folderId: string): NestedMenuItem[] => [
      {
        id: "rename-folder",
        label: "Rename",
        icon: <PencilIcon />,
        shortcut: keybinds.get("edit.rename")?.[0],
        testId: `outliner-rename-folder-${folderId}`,
        onSelect: () => setRenameFolderId(folderId),
      },
      { type: "separator", id: "delete-separator" },
      {
        id: "delete-folder",
        label: "Delete",
        icon: <Trash2Icon />,
        variant: "destructive",
        shortcut: keybinds.get("edit.delete")?.[0],
        testId: `outliner-delete-folder-${folderId}`,
        onSelect: () => setDeleteFolderId(folderId),
      },
    ],
    [keybinds],
  );

  const searchRef = useRef<HTMLInputElement>(null);
  const outlinerKeys = { enabled: Boolean(scene), focusWithinRef: outlinerRef };
  useKeybindCommand("edit.find", () => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, outlinerKeys);
  useKeybindCommand("edit.newFolder", addFolder, outlinerKeys);
  useKeybindCommand("edit.copy", () => copyActors(selectedActorIds), outlinerKeys);
  useKeybindCommand("edit.paste", () => { void pasteActors(); }, outlinerKeys);
  useKeybindCommand("scene.placeActor", () => setPlaceOpen(true), outlinerKeys);
  useKeybindCommand(
    "edit.delete",
    () => {
      if (selectedActorIds.length > 1) {
        setDeleteActorChoice({
          actorId: selectedActorIds[0]!,
          selectedIds: [...selectedActorIds],
        });
      } else if (selectedActorIds.length === 1) {
        removeActors([selectedActorIds[0]!]);
      } else if (selectedFolderIds.length === 1) {
        setDeleteFolderId(selectedFolderIds[0]!);
      }
    },
    outlinerKeys,
  );
  useKeybindCommand(
    "edit.duplicate",
    () => {
      if (!scene || selectedActorIds.length === 0) return;
      const copies = duplicateSceneActors(scene, selectedActorIds);
      if (copies.length === 0) return;
      mutate({ ...scene, actors: [...scene.actors, ...copies] });
      setSelectedActorIds(copies.map((copy) => copy.id));
    },
    outlinerKeys,
  );
  useKeybindCommand(
    "edit.rename",
    () => {
      if (selectedActorIds.length === 0 && selectedFolderIds.length === 1)
        setRenameFolderId(selectedFolderIds[0]!);
    },
    outlinerKeys,
  );

  const deletingFolder = deleteFolderId
    ? scene?.folders.find((folder) => folder.id === deleteFolderId)
    : undefined;

  const deletingActor = deleteActorChoice
    ? scene?.actors.find((actor) => actor.id === deleteActorChoice.actorId)
    : undefined;

  const renamingFolder: SerializedOutlinerFolder | undefined = renameFolderId
    ? scene?.folders.find((folder) => folder.id === renameFolderId)
    : undefined;

  // Row controls are rebuilt with the rows, not with the selection: they call
  // the latest handlers through `rowActions`, so a click re-renders the tree
  // without recreating every row's controls or its menu.
  const latestRowHandlers = useRef<OutlinerRowHandlers>({
    toggleFlag,
    actorMenuItems,
    folderMenuItems,
  });
  const menuRevision = useRef(0);
  const menuListeners = useRef(new Set<() => void>());
  useLayoutEffect(() => {
    latestRowHandlers.current = { toggleFlag, actorMenuItems, folderMenuItems };
  });
  // The menu builders close over the scene, selection, clipboard and registry
  // views; when any changes they are new callbacks. An open menu's items were
  // built from the old ones, so tell its row to rebuild them before anything
  // can be clicked: Duplicate or Delete then edits the current Scene.
  useLayoutEffect(() => {
    menuRevision.current += 1;
    for (const listener of [...menuListeners.current]) listener();
  }, [actorMenuItems, folderMenuItems]);
  const rowActions = useMemo<OutlinerRowActions>(
    () => ({
      toggleFlag: (actorId, flag) => latestRowHandlers.current.toggleFlag(actorId, flag),
      actorMenuItems: (actorId) => latestRowHandlers.current.actorMenuItems(actorId),
      folderMenuItems: (folderId) => latestRowHandlers.current.folderMenuItems(folderId),
      subscribe: (listener) => {
        menuListeners.current.add(listener);
        return () => {
          menuListeners.current.delete(listener);
        };
      },
      getRevision: () => menuRevision.current,
    }),
    [],
  );
  const treeNodes = useMemo(
    () =>
      nodes.map((node): TreeViewNode => {
        const target = outlinerRowTarget(node.id);
        if (target?.kind === "folder") {
          return {
            ...node,
            trailing: (
              <FolderRowActions
                rowId={node.id}
                folderId={target.id}
                label={node.label}
                actionSize={actionSize}
                actions={rowActions}
              />
            ),
          };
        }
        const actorId = target?.id ?? node.id;
        return {
          ...node,
          trailing: (
            <ActorRowActions
              actorId={actorId}
              label={node.label}
              muted={node.muted === true}
              locked={lockedIds.has(actorId)}
              touchSizing={touchSizing}
              actionSize={actionSize}
              actions={rowActions}
            />
          ),
        };
      }),
    [actionSize, lockedIds, nodes, touchSizing, rowActions],
  );

  // Other documents' edits re-render this panel through the document
  // context; an unchanged scene, selection and registry reuse every row.
  const tree = useMemo(
    () => (
      <TreeView
        rowHeight={touchSizing ? 44 : undefined}
        nodes={treeNodes}
        selectedId={selectedRowId}
        selectedIds={selectedRowIds}
        onSelect={setSelectedRowId}
        onActivate={(id) => {
          const target = outlinerRowTarget(id);
          if (target?.kind === "actor") frameActor(target.id);
        }}
        renamingId={renamingRowId}
        onRenameRequest={setRenamingRowId}
        onRenameDone={finishRowRename}
        onToggleExpanded={(id) =>
          setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        onReparent={reparentRow}
        onExternalDrop={dropActorRow}
        onExternalDragMove={moveActorDropHint}
        onExternalDragEnd={() => setDropHint(null)}
        emptyLabel={
          scene
            ? search.trim()
              ? "No Matching Actors"
              : "No Actors Yet"
            : "Open A Scene"
        }
        data-testid="outliner-tree"
      />
    ),
    [
      dropActorRow,
      finishRowRename,
      frameActor,
      moveActorDropHint,
      touchSizing,
      renamingRowId,
      reparentRow,
      scene,
      search,
      selectedRowId,
      selectedRowIds,
      setSelectedRowId,
      treeNodes,
    ],
  );

  return (
    <PanelFrame data-testid="scene-outliner-panel">
      <div ref={outlinerRef} className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-panel-header px-1 py-1">
          <SearchInput
            ref={searchRef}
            className={touchSizing ? "h-11" : "h-7"}
            placeholder="Search actors"
            aria-label="Search actors"
            value={search}
            onChange={setSearch}
            data-testid="outliner-search"
          />
          <IconActionButton
            label="New Folder"
            shortcut={keybinds.get("edit.newFolder")?.[0]}
            size={actionSize}
            onClick={addFolder}
            disabled={!scene}
            data-testid="outliner-add-folder"
          >
            <FolderPlusIcon />
          </IconActionButton>
          <IconActionButton
            label="Add actor"
            shortcut={keybinds.get("scene.placeActor")?.[0]}
            size={actionSize}
            onClick={() => setPlaceOpen(true)}
            disabled={!scene}
            data-testid="outliner-add-actor"
          >
            <PlusIcon />
          </IconActionButton>
        </div>
        <div className="min-h-0 flex-1">
          {tree}
        </div>
      </div>
      <PlaceActorsDialogHost
        open={placeOpen}
        onOpenChange={setPlaceOpen}
        onSelect={addActor}
        projectItems={projectItems}
        overlay={overlay}
        loadThumbnail={loadAssetThumbnail}
      />
      <GraphDropHint hint={dropHint} testId="outliner-drop-hint" />
      {deleteActorChoice && deletingActor ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteActorChoice(null);
          }}
        >
          <AlertDialogContent data-testid="outliner-delete-actor-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Scene Objects</AlertDialogTitle>
              <AlertDialogDescription>
                Delete all {deleteActorChoice.selectedIds.length} selected objects,
                or only {deletingActor.name}? Attached children are also deleted.
                Either choice can be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
              <AlertDialogAction
                size="sm"
                variant="outline"
                onClick={() => removeActors([deletingActor.id])}
              >
                Delete This Object
              </AlertDialogAction>
              <AlertDialogAction
                size="sm"
                onClick={() => removeActors(deleteActorChoice.selectedIds)}
              >
                Delete Selected ({deleteActorChoice.selectedIds.length})
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {deletingFolder ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteFolderId(null);
          }}
        >
          <AlertDialogContent data-testid="outliner-delete-folder-dialog">
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-destructive/10 text-destructive">
                <Trash2Icon />
              </AlertDialogMedia>
              <AlertDialogTitle>Delete Folder</AlertDialogTitle>
              <AlertDialogDescription>
                Delete {deletingFolder.name} only and move its contents up one
                level, or delete the folder and everything inside it? Either
                choice can be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
              <AlertDialogAction
                size="sm"
                variant="outline"
                onClick={() => removeFolder(deletingFolder.id, false)}
              >
                Folder Only
              </AlertDialogAction>
              <AlertDialogAction
                size="sm"
                variant="destructive"
                onClick={() => removeFolder(deletingFolder.id, true)}
              >
                Folder And Contents
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {renamingFolder ? (
        <NamePromptDialog
          open
          onOpenChange={(open) => {
            if (!open) setRenameFolderId(null);
          }}
          title="Rename Folder"
          label="Name"
          confirmLabel="Rename"
          data-testid="outliner-rename-folder-dialog"
          onSubmit={(name) => {
            renameFolder(renamingFolder.id, name);
            setRenameFolderId(null);
          }}
        />
      ) : null}
    </PanelFrame>
  );
}
