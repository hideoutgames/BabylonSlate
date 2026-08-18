import type { IDockviewPanelProps } from "dockview-react";
import { useMemo, useState } from "react";
import {
  PanelFrame,
  TreeView,
  TypeVisualIcon,
  resolveTypeVisual,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import { Badge } from "@babylonslate/ui/components/badge";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { usePrefabEditing } from "../context/prefab-editing-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { useSceneEditing } from "../context/scene-editing-context";
import {
  PREFAB_ROOT_ID,
  childrenOfPrefabParent,
  type PrefabComponentView,
} from "../lib/prefab-preview";
import { applyPrefabTreeSelect } from "../lib/prefab-tree-select";
import { IconActionButton } from "../components/icon-action-button";
import { AddComponentDialog } from "../components/add-component-dialog";
import {
  prefabComponentLabel,
  projectAddComponentItems,
} from "./add-component-catalog";
import { useDocuments } from "../context/document-context";

export function flattenPrefabComponents(
  components: readonly PrefabComponentView[],
  collapsed: ReadonlySet<string>,
  assetLabel?: (guid: string) => string | undefined,
): TreeViewNode[] {
  const rows: TreeViewNode[] = [];
  const roots = childrenOfPrefabParent(components, null);
  rows.push({
    id: PREFAB_ROOT_ID,
    label: "Prefab Root",
    depth: 0,
    hasChildren: roots.length > 0,
    expanded: !collapsed.has(PREFAB_ROOT_ID),
  });
  if (collapsed.has(PREFAB_ROOT_ID)) return rows;

  const walk = (parentId: string | null, depth: number) => {
    for (const component of childrenOfPrefabParent(components, parentId)) {
      const kids = childrenOfPrefabParent(components, component.id);
      const expanded = !collapsed.has(component.id);
      const inherited = Boolean(component.inheritedFrom);
      rows.push({
        id: component.id,
        label: prefabComponentLabel(component, assetLabel),
        depth,
        hasChildren: kids.length > 0,
        expanded,
        icon: (
          <TypeVisualIcon
            visual={resolveTypeVisual({ classId: component.classId })}
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

/**
 * Actor component tree for class documents. The 3D preview lives in the
 * sibling Prefab viewport tab. Edits write `SerializedGraph.components`.
 */
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
  } = usePrefabEditing();
  const { assetRegistry } = useDocuments();
  const { setSelectedMemberId, setSelectedNodeIds } = useGraphEditing();
  const { frameActor } = useSceneEditing();
  const [addOpen, setAddOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const listedAssets = assetRegistry?.list() ?? [];

  const nodes = useMemo(
    () =>
      flattenPrefabComponents(
        components,
        collapsed,
        (guid) =>
          listedAssets.find((asset) => asset.header.guid === guid)?.header
            .name,
      ),
    [collapsed, components, listedAssets],
  );

  const projectItems = useMemo(
    () => projectAddComponentItems(listedAssets),
    [listedAssets],
  );

  const canRemove = selectedIds.some((id) => {
    if (id === PREFAB_ROOT_ID) return false;
    const row = components.find((component) => component.id === id);
    return Boolean(row && !row.inheritedFrom);
  });

  return (
    <PanelFrame
      data-testid="actor-prefab-panel"
      toolbar={
        <>
          <IconActionButton
            label="Add component"
            onClick={() => setAddOpen(true)}
            data-testid="prefab-add-component"
          >
            <PlusIcon />
          </IconActionButton>
          <IconActionButton
            label="Remove component"
            disabled={!canRemove}
            onClick={removeSelected}
            data-testid="prefab-remove-component"
          >
            <Trash2Icon />
          </IconActionButton>
        </>
      }
    >
      <div className="min-h-0 flex-1">
        <TreeView
          nodes={nodes}
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
            if (next.some((entry) => entry !== PREFAB_ROOT_ID)) {
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
          onReparent={reparentComponent}
          reparentArm="immediate"
          onActivate={(id) => frameActor(id)}
          emptyLabel="No components"
          data-testid="prefab-tree"
        />
      </div>
      <AddComponentDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSelect={addComponent}
        projectItems={projectItems}
        data-testid="prefab-add-component-catalog"
      />
    </PanelFrame>
  );
}
