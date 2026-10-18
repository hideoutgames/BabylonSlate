import type { IDockviewPanelProps } from "dockview-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ContextMenuOverlay,
  NestedMenu,
  PanelFrame,
  SearchInput,
  TreeView,
  TypeVisualIcon,
  engineParentOf,
  resolveTypeVisual,
  useContextMenu,
  walkAncestry,
  type NestedMenuItem,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import { MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { usePrefabEditing } from "../context/prefab-editing-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { useSceneEditing } from "../context/scene-editing-context";
import { useKeybindCommand, useKeybindings } from "../context/keybind-context";
import {
  PREFAB_ROOT_ID,
  prefabChildrenByParent,
  type PrefabComponentView,
} from "../lib/prefab-preview";
import { applyPrefabTreeSelect } from "../lib/prefab-tree-select";
import { IconActionButton } from "../components/icon-action-button";
import { AddComponentMenu } from "../components/add-component-menu";
import { anchorBelow } from "../lib/menu-anchor";
import { QUIET_ROW_ACTION } from "../lib/row-action-classes";
import { usePhoneLayout } from "../shell/use-platform-layout";
import {
  prefabComponentLabelParts,
  physicsWorldFromOpenDocuments,
  projectAddComponentItems,
  renamedComponentName,
} from "./add-component-catalog";
import { useRegistryState, useOpenDocument } from "../context/document-context";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  classIdFromClassAsset,
  classParentLookup,
} from "../lib/content-browser-helpers";

export function flattenPrefabComponents(
  components: readonly PrefabComponentView[],
  collapsed: ReadonlySet<string>,
  assetLabel?: (guid: string) => string | undefined,
  parentOf: (id: string) => string | null | undefined = engineParentOf,
  search = "",
): TreeViewNode[] {
  const rows: TreeViewNode[] = [];
  const childrenOf = prefabChildrenByParent(components);
  const roots = childrenOf.get(null) ?? [];
  // Search lists the matches flat under Prefab Root, like the Outliner.
  const needle = search.trim().toLowerCase();
  rows.push({
    id: PREFAB_ROOT_ID,
    label: "Prefab Root",
    depth: 0,
    hasChildren: roots.length > 0,
    expanded: needle !== "" || !collapsed.has(PREFAB_ROOT_ID),
  });
  if (!needle && collapsed.has(PREFAB_ROOT_ID)) return rows;

  const walk = (parentId: string | null, depth: number) => {
    for (const component of childrenOf.get(parentId) ?? []) {
      const kids = childrenOf.get(component.id) ?? [];
      const expanded = needle !== "" || !collapsed.has(component.id);
      const inherited = Boolean(component.inheritedFrom);
      const { name, detail } = prefabComponentLabelParts(component, assetLabel);
      const label = detail ? `${name} ${detail}` : name;
      if (!needle || label.toLowerCase().includes(needle)) rows.push({
        id: component.id,
        label,
        renamable: true,
        renameValue: name,
        renameSuffix: detail,
        depth: needle ? 1 : depth,
        hasChildren: !needle && kids.length > 0,
        expanded,
        icon: (
          <TypeVisualIcon
            visual={resolveTypeVisual({
              classId: component.classId,
              ancestry: walkAncestry(component.classId, parentOf),
            })}
          />
        ),
        trailing: inherited ? (
          <Badge
            variant="secondary"
            className="px-1 py-0 text-[9px] leading-4"
            data-testid={`prefab-inherited-${component.id}`}
          >
            Inherited
          </Badge>
        ) : undefined,
      });
      if (expanded && kids.length > 0) walk(component.id, depth + 1);
    }
  };
  walk(null, 1);
  return rows;
}

/** A row's "…" control; the panel builds its items when it opens. */
function ComponentRowMenu({
  rowId,
  label,
  size,
  onOpen,
  items,
}: {
  rowId: string;
  label: string;
  size: "touch-icon" | "icon-sm";
  onOpen: (rowId: string) => void;
  items: (rowId: string, anchor: () => { x: number; y: number }) => NestedMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const anchor = () =>
    buttonRef.current ? anchorBelow(buttonRef.current) : { x: 0, y: 0 };
  return (
    <NestedMenu
      open={open}
      onOpenChange={(next) => {
        if (next) onOpen(rowId);
        setOpen(next);
      }}
      items={open ? items(rowId, anchor) : []}
      trigger={
        <Button
          ref={buttonRef}
          type="button"
          variant="ghost"
          size={size}
          aria-label={`Component Menu For ${label}`}
          className={QUIET_ROW_ACTION}
          data-testid={`prefab-row-menu-${rowId}`}
        >
          <MoreHorizontalIcon />
        </Button>
      }
    />
  );
}

/**
 * Actor component tree for Class and Prefab documents. The 3D preview lives in
 * the sibling Prefab viewport tab. Edits write the document's `components`.
 */
const WORLD_KINDS = ["scene", "scene-layer"] as const;

export function ActorPrefabPanel(_props: IDockviewPanelProps) {
  void _props;
  const {
    components,
    selectedId,
    selectedIds,
    setSelectedIds,
    addComponent,
    removeSelected,
    reparentComponent,
    renameComponent,
  } = usePrefabEditing();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const { documentId } = useDocumentWorkspace();
  const doc = useOpenDocument(documentId);
  // The open world Scene or Scene Layer sets the Add Component physics world.
  const worldDocuments = useOpenDocumentsOfKinds(WORLD_KINDS);
  const { setSelectedMemberId, setSelectedNodeIds } = useGraphEditing();
  const { frameActor } = useSceneEditing();
  const keybinds = useKeybindings();
  const phone = usePhoneLayout();
  const actionSize = phone ? "touch-icon" : "icon-sm";
  const panelRef = useRef<HTMLDivElement>(null);
  const [addAnchor, setAddAnchor] = useState<{ x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // `list()` returns a new array per call; keep one per registry change so the
  // tree and Add Component memos below do not rebuild on every render.
  const listedAssets = useMemo(() => {
    void registryEpoch;
    return assetRegistry?.list() ?? [];
  }, [assetRegistry, registryEpoch]);
  const isPrefabAsset = doc?.ref.kind === "prefab";
  const docPath = doc?.ref.path;
  const overlay = useMemo(() => {
    const indexed = listedAssets.find((asset) => asset.path === docPath);
    if (!indexed) return false;
    return walkAncestry(
      classIdFromClassAsset(indexed),
      classParentLookup(listedAssets),
    ).includes("SceneLayerActor");
  }, [docPath, listedAssets]);

  const nodes = useMemo(
    () =>
      flattenPrefabComponents(
        components,
        collapsed,
        (guid) =>
          listedAssets.find((asset) => asset.header.guid === guid)?.header
            .name,
        classParentLookup(listedAssets),
        search,
      ),
    [collapsed, components, listedAssets, search],
  );

  // Prefab assets stay logic-free, so scripted project components are not offered.
  const projectItems = useMemo(
    () => (isPrefabAsset ? [] : projectAddComponentItems(listedAssets)),
    [isPrefabAsset, listedAssets],
  );

  const removable = (ids: readonly string[]) =>
    ids.some((id) => {
      if (id === PREFAB_ROOT_ID) return false;
      const row = components.find((component) => component.id === id);
      return Boolean(row && !row.inheritedFrom);
    });

  // A new component nests under the selected one, so the add surfaces say where.
  const addTarget = components.find(
    (component) => component.id === selectedId && selectedId !== PREFAB_ROOT_ID,
  );
  const addTitle = `Add Component To ${
    addTarget ? prefabComponentLabelParts(addTarget).name : "Prefab Root"
  }`;

  // Menus opened on a row act on the selection that opening made, so their
  // items call the latest handlers rather than those of the render that built them.
  const latest = useRef({ removeSelected });
  useLayoutEffect(() => {
    latest.current = { removeSelected };
  });

  /** A row menu acts on the selection, or on the row alone when it is outside it. */
  const selectRowForMenu = (rowId: string) => {
    if (!selectedIds.includes(rowId)) setSelectedIds([rowId]);
  };

  const rowMenuItems = (
    rowId: string,
    anchor: () => { x: number; y: number },
  ): NestedMenuItem[] => {
    if (rowId === PREFAB_ROOT_ID) {
      return [
        {
          id: "add-component",
          label: "Add Component…",
          icon: <PlusIcon />,
          testId: "prefab-row-add-component",
          onSelect: () => setAddAnchor(anchor()),
        },
      ];
    }
    const targets = selectedIds.includes(rowId) ? selectedIds : [rowId];
    return [
      {
        id: "add-child-component",
        label: "Add Child Component…",
        icon: <PlusIcon />,
        testId: "prefab-row-add-child-component",
        onSelect: () => setAddAnchor(anchor()),
      },
      {
        id: "rename-component",
        label: "Rename",
        icon: <PencilIcon />,
        shortcut: keybinds.get("edit.rename")?.[0],
        testId: "prefab-row-rename",
        onSelect: () => setRenamingId(rowId),
      },
      { type: "separator", id: "delete-separator" },
      {
        id: "delete-component",
        label: targets.length > 1 ? "Delete Selected" : "Delete",
        icon: <Trash2Icon />,
        variant: "destructive",
        disabled: !removable(targets),
        shortcut: keybinds.get("edit.delete")?.[0],
        testId: "prefab-row-delete",
        onSelect: () => latest.current.removeSelected(),
      },
    ];
  };

  const { menu, closeMenu, openMenuAt } = useContextMenu({ items: [] });

  useKeybindCommand("edit.delete", removeSelected, {
    enabled: removable(selectedIds),
    focusWithinRef: panelRef,
  });

  const treeNodes = nodes.map((node): TreeViewNode => ({
    ...node,
    trailing: (
      <>
        {node.trailing}
        <ComponentRowMenu
          rowId={node.id}
          label={node.label}
          size={actionSize}
          onOpen={selectRowForMenu}
          items={rowMenuItems}
        />
      </>
    ),
  }));

  return (
    <PanelFrame data-testid="actor-prefab-panel">
      <div ref={panelRef} className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-panel-header px-1 py-1">
          <SearchInput
            className={phone ? "h-11" : "h-7"}
            placeholder="Search components"
            aria-label="Search components"
            value={search}
            onChange={setSearch}
            data-testid="prefab-component-search"
          />
          <IconActionButton
            label={addTitle}
            size={actionSize}
            onClick={(event) => setAddAnchor(anchorBelow(event.currentTarget))}
            data-testid="prefab-add-component"
          >
            <PlusIcon />
          </IconActionButton>
        </div>
        <div className="min-h-0 flex-1">
          <TreeView
            rowHeight={phone ? 44 : undefined}
            nodes={treeNodes}
            selectedId={selectedId}
            selectedIds={selectedIds}
            onSelect={(id, options) => {
              if (!id) return;
              const next = applyPrefabTreeSelect({
                visibleIds: nodes.map((node) => node.id),
                selectedIds,
                id,
                additive: options?.additive,
                range: options?.range,
              });
              setSelectedIds(next);
              // Prefab Root Details replace a graph node's, so picking the root
              // also leaves the canvas and Class member selection.
              if (next.length > 0) {
                setSelectedMemberId(null);
                setSelectedNodeIds([]);
              }
            }}
            onToggleExpanded={(id) =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            // Search flattens the hierarchy, so a drop there would not mean what it shows.
            onReparent={search.trim() ? undefined : reparentComponent}
            onActivate={(id) => frameActor(id)}
            onContextMenu={(id, x, y) => {
              selectRowForMenu(id);
              openMenuAt(x, y, rowMenuItems(id, () => ({ x, y })));
            }}
            renamingId={renamingId}
            onRenameRequest={setRenamingId}
            onRenameDone={(id, name) => {
              setRenamingId(null);
              const component = components.find((entry) => entry.id === id);
              if (name !== null && component) {
                renameComponent(id, renamedComponentName(component.classId, name));
              }
            }}
            emptyLabel="No components"
            data-testid="prefab-tree"
          />
        </div>
      </div>
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
      <AddComponentMenu
        open={addAnchor !== null}
        onOpenChange={(open) => {
          if (!open) setAddAnchor(null);
        }}
        anchor={addAnchor}
        onSelect={addComponent}
        projectItems={projectItems}
        overlay={overlay}
        physicsWorld={physicsWorldFromOpenDocuments(worldDocuments)}
        title={addTitle}
        data-testid="prefab-add-component-catalog"
      />
    </PanelFrame>
  );
}
