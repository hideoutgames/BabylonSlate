import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PanelFrame,
  SearchSheet,
  TreeView,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedComponent,
  type SerializedScene,
} from "@babylonslate/core";
import { createEngine, type EngineHandle } from "@babylonslate/render";
import { Button } from "@babylonslate/ui/components/button";

const COMPONENT_CLASSES = [
  { id: "MeshComponent", label: "Mesh", description: "Renderable primitive" },
  { id: "SpriteComponent", label: "Sprite", description: "2D sprite" },
  { id: "CameraComponent", label: "Camera", description: "Scene camera" },
  { id: "LightComponent", label: "Light", description: "Scene light" },
];

/** Preview scene holding the prefab's components on a single actor. */
export function previewSceneFor(
  components: SerializedComponent[],
): SerializedScene {
  return {
    ...createDefaultScene(),
    name: "Prefab preview",
    actors: [createActor("prefab-root", "Prefab", { components })],
  };
}

/**
 * Actor Prefab tab for class documents: the component tree the class spawns
 * with, plus a minimal 3D preview of the same components.
 */
export function ActorPrefabPanel(_props: IDockviewPanelProps) {
  void _props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const [components, setComponents] = useState<SerializedComponent[]>(() => [
    createMeshComponent("prefab-mesh", "box"),
  ]);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>("prefab-mesh");

  const nodes = useMemo<TreeViewNode[]>(
    () => [
      {
        id: "prefab-root",
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = createEngine(canvas, { editor: true });
    engineRef.current = handle;
    return () => {
      handle.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.loadScene(previewSceneFor(components));
    engineRef.current?.resize();
  }, [components]);

  return (
    <PanelFrame
      title="Prefab"
      data-testid="actor-prefab-panel"
      toolbar={
        <>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 min-w-11"
            onClick={() => setAddOpen(true)}
            data-testid="prefab-add-component"
          >
            Add
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 min-w-11"
            disabled={!selectedId || selectedId === "prefab-root"}
            onClick={() =>
              setComponents((current) =>
                current.filter((component) => component.id !== selectedId),
              )
            }
            data-testid="prefab-remove-component"
          >
            Remove
          </Button>
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-32 flex-1">
          <TreeView
            nodes={nodes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            emptyLabel="No components"
            data-testid="prefab-tree"
          />
        </div>
        <div className="h-40 shrink-0 border-t border-border">
          <canvas
            ref={canvasRef}
            className="h-full w-full touch-none"
            data-testid="prefab-preview-canvas"
          />
        </div>
      </div>
      <SearchSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add component"
        items={COMPONENT_CLASSES.map((entry) => ({
          id: entry.id,
          label: entry.label,
          description: entry.description,
        }))}
        onSelect={(classId) =>
          setComponents((current) => [
            ...current,
            {
              id: `prefab-component-${current.length + 1}`,
              classId,
              properties:
                classId === "MeshComponent"
                  ? { meshKind: "box", assetGuid: null }
                  : {},
            },
          ])
        }
        data-testid="prefab-add-component-sheet"
      />
    </PanelFrame>
  );
}
