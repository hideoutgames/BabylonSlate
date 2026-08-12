import { Toggle } from "@babylonslate/ui/components/toggle";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";
import type { SerializedScene } from "@babylonslate/core";
import type { GizmoTool } from "@babylonslate/render";
import {
  Gamepad2Icon,
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

export function ViewportToolbar({
  testIdPrefix = "",
}: {
  testIdPrefix?: string;
}) {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applySceneChange } = useDocuments();
  const {
    gizmoTool,
    setGizmoTool,
    snapEnabled,
    setSnapEnabled,
    joystickEnabled,
    setJoystickEnabled,
    viewportMode,
    setViewportMode,
  } = useSceneEditing();

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const scene =
    doc?.ref.kind === "scene" ? (doc.content as SerializedScene) : null;

  const setMode = (next: "2d" | "3d") => {
    setViewportMode(next);
    if (scene && scene.viewportMode !== next) {
      void applySceneChange(documentId, { ...scene, viewportMode: next });
    }
  };

  const toggleJoystick = (enabled: boolean) => {
    setJoystickEnabled(enabled);
    if (scene && scene.settings.editorJoystickEnabled !== enabled) {
      void applySceneChange(documentId, {
        ...scene,
        settings: { ...scene.settings, editorJoystickEnabled: enabled },
      });
    }
  };

  const toggleSnap = (enabled: boolean) => {
    setSnapEnabled(enabled);
    if (scene && scene.settings.grid.snapEnabled !== enabled) {
      void applySceneChange(documentId, {
        ...scene,
        settings: {
          ...scene.settings,
          grid: { ...scene.settings.grid, snapEnabled: enabled },
        },
      });
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={`${testIdPrefix}viewport-toolbar`}
    >
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={1}
        value={[gizmoTool]}
        onValueChange={(value) => {
          const next = value[0] as GizmoTool | undefined;
          if (next) setGizmoTool(next);
        }}
        aria-label="Gizmo tool"
      >
        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          return (
            <ToggleGroupItem
              key={tool.id}
              value={tool.id}
              aria-label={tool.label}
              data-testid={`${testIdPrefix}gizmo-tool-${tool.id}`}
            >
              <Icon />
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              variant="outline"
              size="sm"
              aria-label="Snap"
              pressed={snapEnabled}
              onPressedChange={toggleSnap}
              data-testid={`${testIdPrefix}gizmo-snap-toggle`}
            >
              <MagnetIcon />
            </Toggle>
          }
        />
        <TooltipContent>Snap</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              variant="outline"
              size="sm"
              aria-label="Camera joystick"
              pressed={joystickEnabled}
              onPressedChange={toggleJoystick}
              data-testid={`${testIdPrefix}gizmo-joystick-toggle`}
            >
              <Gamepad2Icon />
            </Toggle>
          }
        />
        <TooltipContent>Joystick</TooltipContent>
      </Tooltip>
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={1}
        value={[viewportMode]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "2d" || next === "3d") setMode(next);
        }}
        aria-label="Viewport Mode"
        data-testid={`${testIdPrefix}viewport-mode-toggle`}
      >
        <ToggleGroupItem
          value="3d"
          aria-label="3D viewport"
          data-testid={`${testIdPrefix}viewport-mode-3d`}
        >
          3D
        </ToggleGroupItem>
        <ToggleGroupItem
          value="2d"
          aria-label="2D viewport"
          data-testid={`${testIdPrefix}viewport-mode-2d`}
        >
          2D
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
