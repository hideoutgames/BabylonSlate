import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  NamePromptDialog,
  NestedMenu,
  PanelFrame,
  SearchInput,
  TreeView,
  TypeVisualIcon,
  engineParentOf,
  rangeSelectTreeIds,
  resolveActorTypeVisual,
  walkAncestry,
  type NestedMenuItem,
  type TreeSelectOptions,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import {
  actorSubtree,
  nextFolderId,
  wouldCreateCycle,
  wouldCreateFolderCycle,
  type SerializedActor,
  type SerializedGraph,
  type SerializedOutlinerFolder,
  type SerializedScene,
} from "@babylonslate/core";
import { Button } from "@babylonslate/ui/components/button";
import {
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderPlusIcon,
  LockIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing, selectionAfterLockChange } from "../context/scene-editing-context";
import { IconActionButton } from "../components/icon-action-button";
import { PlaceActorsDialog } from "../components/place-actors-dialog";
import {
  nextActorId,
  prefabComponentsForGuid,
  projectPlaceActors,
  spawnPlacedActor,
  type PlaceActorItem,
} from "../lib/place-actors";
import { classParentLookup } from "../lib/content-browser-helpers";
import { prefabComponentsFromGraph } from "../lib/prefab-preview";

const FOLDER_ROW_PREFIX = "folder:";
const ACTOR_ROW_PREFIX = "actor:";

export function folderRowId(folderId: string): string {
  return `${FOLDER_ROW_PREFIX}${folderId}`;
}

export function actorRowId(actorId: string): string {
  return `${ACTOR_ROW_PREFIX}${actorId}`;
}

export type OutlinerRowTarget =
  | { kind: "folder"; id: string }
  | { kind: "actor"; id: string };

/** Rows are namespaced so a folder can never be mistaken for an actor. */
export function outlinerRowTarget(
  rowId: string | null,
): OutlinerRowTarget | null {
  if (!rowId) return null;
  if (rowId.startsWith(FOLDER_ROW_PREFIX)) {
    return { kind: "folder", id: rowId.slice(FOLDER_ROW_PREFIX.length) };
  }
  if (rowId.startsWith(ACTOR_ROW_PREFIX)) {
    return { kind: "actor", id: rowId.slice(ACTOR_ROW_PREFIX.length) };
  }
  return null;
}

export function applyOutlinerRowSelect(
  rowId: string,
  options: TreeSelectOptions | undefined,
  visibleRowIds: readonly string[],
  selectedActorIds: readonly string[],
): { folderId: string | null; actorIds: string[] } {
  const target = outlinerRowTarget(rowId);
  if (target?.kind === "folder") {
    return { folderId: target.id, actorIds: [] };
  }
  if (target?.kind !== "actor") {
    return { folderId: null, actorIds: [] };
  }
  if (options?.range) {
    const actorIds = visibleRowIds
      .map((id) => outlinerRowTarget(id))
      .filter((row): row is { kind: "actor"; id: string } => row?.kind === "actor")
      .map((row) => row.id);
    const from = selectedActorIds[selectedActorIds.length - 1];
    return {
      folderId: null,
      actorIds: rangeSelectTreeIds(actorIds, from, target.id),
    };
  }
  if (options?.additive) {
    return {
      folderId: null,
      actorIds: selectedActorIds.includes(target.id)
        ? selectedActorIds.filter((id) => id !== target.id)
        : [...selectedActorIds, target.id],
    };
  }
  return { folderId: null, actorIds: [target.id] };
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
  const parentOf =
    options.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  const actorIcon = (actor: SerializedActor) => (
    <TypeVisualIcon
      visual={resolveActorTypeVisual({
        classId: actor.classId,
        components: actor.components,
        ancestry: walkAncestry(actor.classId, parentOf),
      })}
      data-testid={`outliner-type-icon-${actor.id}`}
    />
  );
  const folderIcon = (folder: SerializedOutlinerFolder) => (
    <FolderIcon data-testid={`outliner-folder-icon-${folder.id}`} />
  );

  const needle = options.search.trim().toLowerCase();
  const childrenOf = new Map<string | null, SerializedActor[]>();
  for (const actor of scene.actors) {
    const bucket = childrenOf.get(actor.parentId) ?? [];
    bucket.push(actor);
    childrenOf.set(actor.parentId, bucket);
  }
  const foldersByParent = new Map<string | null, SerializedOutlinerFolder[]>();
  for (const folder of scene.folders) {
    const bucket = foldersByParent.get(folder.parentFolderId) ?? [];
    bucket.push(folder);
    foldersByParent.set(folder.parentFolderId, bucket);
  }
  const folderById = new Map(scene.folders.map((folder) => [folder.id, folder]));

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
        label: path ? `${path} / ${actor.name}` : actor.name,
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
        label: actor.name,
        depth,
        hasChildren: children.length > 0,
        expanded,
        muted: !actor.visible,
        icon: actorIcon(actor),
      });
      if (expanded) walkActors(actor.id, depth + 1);
    }
  };

  const actorsAtFolderRoot = (folderId: string | null) =>
    (childrenOf.get(null) ?? []).filter((actor) => actor.folderId === folderId);

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
          label: actor.name,
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
      label: actor.name,
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

export function SceneOutlinerPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applySceneChange, assetRegistry, loadGraphDocument } =
    useDocuments();
  const { selectedActorIds, selectActor, setSelectedActorIds, frameActor } =
    useSceneEditing();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [placeOpen, setPlaceOpen] = useState(false);
  const [renameFolderId, setRenameFolderId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [diskGraphs, setDiskGraphs] = useState<Map<string, SerializedGraph>>(
    () => new Map(),
  );

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const scene =
    doc?.ref.kind === "scene" ? (doc.content as SerializedScene) : null;

  const parentOf = useMemo(
    () => classParentLookup(assetRegistry?.list() ?? []),
    [assetRegistry],
  );

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

  const selectedRowIds = selectedFolderId
    ? [folderRowId(selectedFolderId)]
    : selectedActorIds.map((id) => actorRowId(id));
  const selectedRowId = selectedRowIds[0] ?? null;

  const setSelectedRowId = useCallback(
    (rowId: string | null, options?: TreeSelectOptions) => {
      if (!rowId) {
        setSelectedFolderId(null);
        selectActor(null);
        return;
      }
      const next = applyOutlinerRowSelect(
        rowId,
        options,
        nodes.map((node) => node.id),
        selectedActorIds,
      );
      setSelectedFolderId(next.folderId);
      if (next.folderId) {
        selectActor(null);
        return;
      }
      if (options?.range || options?.additive) {
        setSelectedActorIds(next.actorIds);
        return;
      }
      selectActor(next.actorIds[0] ?? null);
    },
    [nodes, selectActor, selectedActorIds, setSelectedActorIds],
  );

  const projectItems = useMemo(() => {
    const assets = assetRegistry?.list() ?? [];
    return projectPlaceActors(assets, (guid) =>
      prefabComponentsForGuid(guid, {
        assets,
        graphForPath: (path) => {
          const open = openDocuments.find(
            (entry) => entry.ref.kind === "graph" && entry.ref.path === path,
          );
          if (open?.content) return open.content as SerializedGraph;
          return diskGraphs.get(path);
        },
      }),
    );
  }, [assetRegistry, diskGraphs, openDocuments]);

  useEffect(() => {
    if (!placeOpen) return;
    let cancelled = false;
    const assets = assetRegistry?.list() ?? [];
    void (async () => {
      const next = new Map<string, SerializedGraph>();
      for (const asset of assets) {
        if (asset.header.type !== "Class" || !asset.path) continue;
        const graph = await loadGraphDocument(asset.path);
        if (graph) next.set(asset.path, graph);
      }
      if (!cancelled) setDiskGraphs(next);
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
          actors: [...scene.actors, spawnPlacedActor(scene, resolved, id)],
        });
        selectActor(id);
        setPlaceOpen(false);
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
                components: graph
                  ? prefabComponentsFromGraph(graph)
                  : kind.components,
              },
            });
          });
          return;
        }
      }
      finish(item);
    },
    [assetRegistry, loadGraphDocument, mutate, scene, selectActor],
  );

  const removeActor = useCallback(
    (actorId: string) => {
      if (!scene) return;
      const doomed = new Set(
        actorSubtree(scene, actorId).map((actor) => actor.id),
      );
      mutate({
        ...scene,
        actors: scene.actors.filter((actor) => !doomed.has(actor.id)),
      });
      selectActor(null);
    },
    [mutate, scene, selectActor],
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

  /** Deleting a folder keeps its actors; contents move up one level. */
  const removeFolder = useCallback(
    (folderId: string) => {
      if (!scene) return;
      const folder = scene.folders.find((entry) => entry.id === folderId);
      if (!folder) return;
      const promoteTo = folder.parentFolderId;
      mutate({
        ...scene,
        folders: scene.folders
          .filter((entry) => entry.id !== folderId)
          .map((entry) =>
            entry.parentFolderId === folderId
              ? { ...entry, parentFolderId: promoteTo }
              : entry,
          ),
        actors: scene.actors.map((actor) =>
          actor.folderId === folderId ? { ...actor, folderId: promoteTo } : actor,
        ),
      });
      setSelectedRowId(null);
    },
    [mutate, scene],
  );

  /**
   * Drop on a folder groups; drop on an actor attaches; drop on empty space
   * clears both. Folder membership and transform parenting stay independent,
   * so an actor is never in two places at once.
   */
  const reparentRow = useCallback(
    (dragRowId: string, targetRowId: string | null) => {
      if (!scene) return;
      const drag = outlinerRowTarget(dragRowId);
      if (!drag) return;
      const target = outlinerRowTarget(targetRowId);

      if (drag.kind === "folder") {
        const parentFolderId = target?.kind === "folder" ? target.id : null;
        if (parentFolderId === drag.id) return;
        if (wouldCreateFolderCycle(scene, drag.id, parentFolderId)) return;
        mutate({
          ...scene,
          folders: scene.folders.map((folder) =>
            folder.id === drag.id ? { ...folder, parentFolderId } : folder,
          ),
        });
        return;
      }

      if (target?.kind === "folder") {
        mutate({
          ...scene,
          actors: scene.actors.map((actor) =>
            actor.id === drag.id
              ? { ...actor, folderId: target.id, parentId: null }
              : actor,
          ),
        });
        return;
      }

      const parentId = target?.kind === "actor" ? target.id : null;
      if (parentId && wouldCreateCycle(scene, drag.id, parentId)) return;
      const folderId = parentId
        ? (scene.actors.find((actor) => actor.id === parentId)?.folderId ?? null)
        : null;
      mutate({
        ...scene,
        actors: scene.actors.map((actor) =>
          actor.id === drag.id ? { ...actor, parentId, folderId } : actor,
        ),
      });
    },
    [mutate, scene],
  );

  const actorMenuItems = useCallback(
    (actorId: string): NestedMenuItem[] => [
      {
        id: "duplicate-actor",
        label: "Duplicate",
        testId: `outliner-duplicate-${actorId}`,
        onSelect: () => {
          if (!scene) return;
          const source = scene.actors.find((actor) => actor.id === actorId);
          if (!source) return;
          const id = nextActorId(scene);
          mutate({
            ...scene,
            actors: [
              ...scene.actors,
              { ...structuredClone(source), id, name: `${source.name} Copy` },
            ],
          });
          selectActor(id);
        },
      },
      {
        id: "delete-actor",
        label: "Delete",
        testId: `outliner-delete-${actorId}`,
        onSelect: () => removeActor(actorId),
      },
    ],
    [mutate, removeActor, scene, selectActor],
  );

  const folderMenuItems = useCallback(
    (folderId: string): NestedMenuItem[] => [
      {
        id: "rename-folder",
        label: "Rename",
        testId: `outliner-rename-folder-${folderId}`,
        onSelect: () => setRenameFolderId(folderId),
      },
      {
        id: "delete-folder",
        label: "Delete",
        testId: `outliner-delete-folder-${folderId}`,
        onSelect: () => removeFolder(folderId),
      },
    ],
    [removeFolder],
  );

  const renamingFolder: SerializedOutlinerFolder | undefined = renameFolderId
    ? scene?.folders.find((folder) => folder.id === renameFolderId)
    : undefined;

  return (
    <PanelFrame data-testid="scene-outliner-panel">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 px-1 py-1">
          <SearchInput
            className="min-h-[var(--chrome-row,28px)]"
            placeholder="Search actors"
            aria-label="Search actors"
            value={search}
            onChange={setSearch}
            data-testid="outliner-search"
          />
          <IconActionButton
            label="New Folder"
            onClick={addFolder}
            disabled={!scene}
            data-testid="outliner-add-folder"
          >
            <FolderPlusIcon />
          </IconActionButton>
          <IconActionButton
            label="Add actor"
            onClick={() => setPlaceOpen(true)}
            disabled={!scene}
            data-testid="outliner-add-actor"
          >
            <PlusIcon />
          </IconActionButton>
        </div>
        <div className="min-h-0 flex-1">
          <TreeView
            nodes={nodes.map((node) => {
              const target = outlinerRowTarget(node.id);
              if (target?.kind === "folder") {
                return {
                  ...node,
                  trailing: (
                    <NestedMenu
                      items={folderMenuItems(target.id)}
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Folder menu for ${node.label}`}
                          data-testid={`outliner-menu-${node.id}`}
                        >
                          <MoreHorizontalIcon />
                        </Button>
                      }
                    />
                  ),
                };
              }
              const actorId = target?.id ?? node.id;
              return {
                ...node,
                trailing: (
                  <>
                    <IconActionButton
                      label={`Toggle visibility of ${node.label}`}
                      variant="ghost"
                      onClick={() => toggleFlag(actorId, "visible")}
                      data-testid={`outliner-visibility-${actorId}`}
                    >
                      {node.muted ? <EyeOffIcon /> : <EyeIcon />}
                    </IconActionButton>
                    <IconActionButton
                      label={`Toggle lock of ${node.label}`}
                      variant="ghost"
                      onClick={() => toggleFlag(actorId, "locked")}
                      data-testid={`outliner-lock-${actorId}`}
                      className={lockedIds.has(actorId) ? "text-primary" : undefined}
                    >
                      <LockIcon />
                    </IconActionButton>
                    <NestedMenu
                      items={actorMenuItems(actorId)}
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actor menu for ${node.label}`}
                          data-testid={`outliner-menu-${actorId}`}
                        >
                          <MoreHorizontalIcon />
                        </Button>
                      }
                    />
                  </>
                ),
              };
            })}
            selectedId={selectedRowId}
            selectedIds={selectedRowIds}
            onSelect={setSelectedRowId}
            onActivate={(id) => {
              const target = outlinerRowTarget(id);
              if (target?.kind === "actor") frameActor(target.id);
            }}
            onToggleExpanded={(id) =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onReparent={reparentRow}
            reparentArm="immediate"
            emptyLabel={scene ? "No actors yet" : "Open a scene"}
            data-testid="outliner-tree"
          />
        </div>
      </div>
      <PlaceActorsDialog
        open={placeOpen}
        onOpenChange={setPlaceOpen}
        onSelect={addActor}
        projectItems={projectItems}
      />
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
