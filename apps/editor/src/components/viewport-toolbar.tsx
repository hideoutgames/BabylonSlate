import { Button } from "@babylonslate/ui/components/button";
import type { SerializedScene } from "@babylonslate/core";
import type { GizmoTool } from "@babylonslate/render";
import {
  BoxIcon,
  MagnetIcon,
  MoveIcon,
  RotateCwIcon,
  ScalingIcon,
} from "lucide-react";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing } from "../context/scene-editing-context";

const TOOLS: Array<{
  id: GizmoTool;
  label: string;
  icon: typeof MoveIcon;
}> = [
  { id: "translate", label: "Move", icon: MoveIcon },
  { id: "rotate", label: "Rotate", icon: RotateCwIcon },
  { id: "scale", label: "Scale", icon: ScalingIcon },
];

export function ViewportToolbar() {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applySceneChange } = useDocuments();
  const {
    gizmoTool,
    setGizmoTool,
    snapEnabled,
    setSnapEnabled,
    viewportMode,
    setViewportMode,
  } = useSceneEditing();

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const scene =
    doc?.ref.kind === "scene" ? (doc.content as SerializedScene) : null;

  const toggleMode = () => {
    const next = viewportMode === "3d" ? "2d" : "3d";
    setViewportMode(next);
    // The toggle is always available; it also updates the scene's default.
    if (scene && scene.viewportMode !== next) {
      void applySceneChange(documentId, { ...scene, viewportMode: next });
    }
  };

  const toggleSnap = () => {
    const next = !snapEnabled;
    setSnapEnabled(next);
    if (scene && scene.settings.grid.snapEnabled !== next) {
      void applySceneChange(documentId, {
        ...scene,
        settings: {
          ...scene.settings,
          grid: { ...scene.settings.grid, snapEnabled: next },
        },
      });
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid="viewport-toolbar"
    >
      {TOOLS.map((tool) => {
        const Icon = tool.icon;
        return (
          <Button
            key={tool.id}
            size="sm"
            variant={gizmoTool === tool.id ? "secondary" : "ghost"}
            className="min-h-11 min-w-11"
            aria-label={tool.label}
            aria-pressed={gizmoTool === tool.id}
            onClick={() => setGizmoTool(tool.id)}
            data-testid={`gizmo-tool-${tool.id}`}
          >
            <Icon />
          </Button>
        );
      })}
      <Button
        size="sm"
        variant={snapEnabled ? "secondary" : "ghost"}
        className="min-h-11 min-w-11"
        aria-label="Snap"
        aria-pressed={snapEnabled}
        onClick={toggleSnap}
        data-testid="gizmo-snap-toggle"
      >
        <MagnetIcon />
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="min-h-11 min-w-11"
        aria-label={viewportMode === "3d" ? "3D viewport" : "2D viewport"}
        onClick={toggleMode}
        data-testid="viewport-mode-toggle"
      >
        <BoxIcon data-icon="inline-start" />
        {viewportMode === "3d" ? "3D" : "2D"}
      </Button>
    </div>
  );
}
