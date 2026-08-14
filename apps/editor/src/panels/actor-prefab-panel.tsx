import type { IDockviewPanelProps } from "dockview-react";
import { useMemo, useState } from "react";
import {
  PanelFrame,
  TreeView,
  TypeVisualIcon,
  resolveTypeVisual,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import type { SerializedComponent } from "@babylonslate/core";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { usePrefabEditing } from "../context/prefab-editing-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { PREFAB_ROOT_ID, childrenOfPrefabParent } from "../lib/prefab-preview";
import { IconActionButton } from "../components/icon-action-button";
import { AddComponentDialog } from "../components/add-component-dialog";

export function flattenPrefabComponents(
  components: readonly SerializedComponent[],
  collapsed: ReadonlySet<string>,
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
      rows.push({
        id: component.id,
        label: component.classId,
        depth,
        hasChildren: kids.length > 0,
        expanded,
        icon: (
          <TypeVisualIcon
            visual={resolveTypeVisual({ classId: component.classId })}
          />
        ),
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
    setSelectedId,
    addComponent,
    removeSelected,
    reparentComponent,
  } = usePrefabEditing();
  const { setSelectedMemberId, setSelectedNodeIds } = useGraphEditing();
  const [addOpen, setAddOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const nodes = useMemo(
    () => flattenPrefabComponents(components, collapsed),
    [collapsed, components],
  );

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
            disabled={!selectedId || selectedId === PREFAB_ROOT_ID}
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
          onSelect={(id) => {
            setSelectedId(id);
            if (id && id !== PREFAB_ROOT_ID) {
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
          emptyLabel="No components"
          data-testid="prefab-tree"
        />
      </div>
      <AddComponentDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSelect={addComponent}
        data-testid="prefab-add-component-catalog"
      />
    </PanelFrame>
  );
}
