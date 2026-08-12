import { Button } from "@babylonslate/ui/components/button";
import type { SerializedScene } from "@babylonslate/core";
import type { GizmoTool } from "@babylonslate/render";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing } from "../context/scene-editing-context";
import { usePlay } from "../context/play-context";

const TOOLS: Array<{ id: GizmoTool; label: string }> = [
  { id: "translate", label: "Move" },
  { id: "rotate", label: "Rotate" },
  { id: "scale", label: "Scale" },
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
  const { playing, startPlay, stopPlay } = usePlay();

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
      {TOOLS.map((tool) => (
        <Button
          key={tool.id}
          size="sm"
          variant={gizmoTool === tool.id ? "secondary" : "ghost"}
          className="min-h-11 min-w-11"
          aria-pressed={gizmoTool === tool.id}
          onClick={() => setGizmoTool(tool.id)}
          data-testid={`gizmo-tool-${tool.id}`}
        >
          {tool.label}
        </Button>
      ))}
      <Button
        size="sm"
        variant={snapEnabled ? "secondary" : "ghost"}
        className="min-h-11 min-w-11"
        aria-pressed={snapEnabled}
        onClick={toggleSnap}
        data-testid="gizmo-snap-toggle"
      >
        Snap
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="min-h-11 min-w-11"
        onClick={toggleMode}
        data-testid="viewport-mode-toggle"
      >
        {viewportMode === "3d" ? "3D" : "2D"}
      </Button>
      <Button
        size="sm"
        variant={playing ? "destructive" : "default"}
        className="min-h-11 min-w-11"
        onClick={() => (playing ? stopPlay() : startPlay())}
        data-testid="viewport-play-toggle"
      >
        {playing ? "Stop" : "Play"}
      </Button>
    </div>
  );
}
