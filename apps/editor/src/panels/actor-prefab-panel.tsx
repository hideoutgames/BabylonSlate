import type { IDockviewPanelProps } from "dockview-react";
import { useMemo, useState } from "react";
import {
  PanelFrame,
  SearchSheet,
  TreeView,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { usePrefabEditing } from "../context/prefab-editing-context";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";

const COMPONENT_CLASSES = [
  { id: "MeshComponent", label: "Mesh", description: "Renderable primitive" },
  { id: "SpriteComponent", label: "Sprite", description: "2D sprite" },
  { id: "CameraComponent", label: "Camera", description: "Scene camera" },
  { id: "LightComponent", label: "Light", description: "Scene light" },
];

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
  } = usePrefabEditing();
  const [addOpen, setAddOpen] = useState(false);

  const nodes = useMemo<TreeViewNode[]>(
    () => [
      {
        id: PREFAB_ROOT_ID,
        label: "Prefab root",
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
      })),
    ],
    [components],
  );

  return (
    <PanelFrame
      data-testid="actor-prefab-panel"
      toolbar={
        <>
          <Button
            size="sm"
            variant="outline"
            className="min-h-[var(--touch-target,44px)] min-w-[var(--touch-target,44px)]"
            aria-label="Add component"
            onClick={() => setAddOpen(true)}
            data-testid="prefab-add-component"
          >
            <PlusIcon />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="min-h-[var(--touch-target,44px)] min-w-[var(--touch-target,44px)]"
            aria-label="Remove component"
            disabled={!selectedId || selectedId === PREFAB_ROOT_ID}
            onClick={removeSelected}
            data-testid="prefab-remove-component"
          >
            <Trash2Icon />
          </Button>
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
        emptyLabel="No components"
        data-testid="prefab-tree"
      />
      <SearchSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add component"
        items={COMPONENT_CLASSES.map((entry) => ({
          id: entry.id,
          label: entry.label,
          description: entry.description,
        }))}
        onSelect={addComponent}
        data-testid="prefab-add-component-sheet"
      />
    </PanelFrame>
  );
}
