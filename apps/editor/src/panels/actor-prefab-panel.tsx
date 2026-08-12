import type { IDockviewPanelProps } from "dockview-react";
import { useMemo, useState } from "react";
import {
  PanelFrame,
  TreeView,
  TypeVisualIcon,
  resolveTypeVisual,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { usePrefabEditing } from "../context/prefab-editing-context";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";
import { IconActionButton } from "../components/icon-action-button";
import { AddComponentDialog } from "../components/add-component-dialog";

/**
 * Actor component tree for class documents. The 3D preview lives in the
 * sibling Prefab viewport tab. Persistence onto the class document is
 * deferred (docs/agents/issue-tracker.md — P6 prefab persistence).
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
  const [addOpen, setAddOpen] = useState(false);

  const nodes = useMemo<TreeViewNode[]>(
    () => [
      {
        id: PREFAB_ROOT_ID,
        label: "Prefab Root",
        depth: 0,
        hasChildren: components.length > 0,
        expanded: true,
      },
      ...components.map((component) => ({
        id: component.id,
        label: component.classId,
        depth: 1,
        hasChildren: false,
        expanded: false,
        icon: (
          <TypeVisualIcon
            visual={resolveTypeVisual({ classId: component.classId })}
          />
        ),
      })),
    ],
    [components],
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
      <p
        className="border-b border-border px-3 py-2 text-xs text-muted-foreground"
        data-testid="prefab-preview-only-note"
      >
        Preview only — component edits are not saved to the class document yet.
      </p>
      <TreeView
        nodes={nodes}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onReparent={reparentComponent}
        emptyLabel="No components"
        data-testid="prefab-tree"
      />
      <AddComponentDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSelect={addComponent}
        data-testid="prefab-add-component-catalog"
      />
    </PanelFrame>
  );
}
