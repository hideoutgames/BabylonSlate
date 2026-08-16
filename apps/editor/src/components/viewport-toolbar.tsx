import { NestedMenu, type NestedMenuItem } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
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
  MoveIcon,
  RotateCwIcon,
  ScalingIcon,
  Settings2Icon,
  SquareDashedMousePointerIcon,
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
  showDragSelect = true,
}: {
  testIdPrefix?: string;
  showDragSelect?: boolean;
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
    gridVisible,
    setGridVisible,
    dragSelectActive,
    setDragSelectActive,
    viewportMode,
    setViewportMode,
    previewGameCamera,
    setPreviewGameCamera,
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

  const toggleGrid = (enabled: boolean) => {
    setGridVisible(enabled);
    if (scene && scene.settings.grid.showGrid !== enabled) {
      void applySceneChange(documentId, {
        ...scene,
        settings: {
          ...scene.settings,
          grid: { ...scene.settings.grid, showGrid: enabled },
        },
      });
    }
  };

  const settingsItems: NestedMenuItem[] = [
    {
      type: "checkbox",
      id: "snap",
      label: "Snap",
      checked: snapEnabled,
      closeOnClick: false,
      testId: `${testIdPrefix}gizmo-snap-toggle`,
      onCheckedChange: toggleSnap,
    },
    {
      type: "checkbox",
      id: "show-grid",
      label: "Show Grid",
      checked: gridVisible,
      closeOnClick: false,
      testId: `${testIdPrefix}viewport-show-grid-toggle`,
      onCheckedChange: toggleGrid,
    },
    {
      type: "checkbox",
      id: "joystick",
      label: "Joystick",
      checked: joystickEnabled,
      closeOnClick: false,
      testId: `${testIdPrefix}gizmo-joystick-toggle`,
      onCheckedChange: toggleJoystick,
    },
    {
      type: "checkbox",
      id: "game-camera",
      label: "Game Camera",
      checked: previewGameCamera,
      closeOnClick: false,
      testId: `${testIdPrefix}viewport-game-camera-toggle`,
      onCheckedChange: setPreviewGameCamera,
    },
  ];

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
          const active = gizmoTool === tool.id;
          return (
            <ToggleGroupItem
              key={tool.id}
              value={tool.id}
              aria-label={tool.label}
              data-testid={`${testIdPrefix}gizmo-tool-${tool.id}`}
            >
              <Icon />
              <span
                data-testid="gizmo-tool-label"
                className="grid min-w-0 overflow-hidden transition-[grid-template-columns] duration-200 ease-out"
                style={{ gridTemplateColumns: active ? "1fr" : "0fr" }}
                aria-hidden={!active}
              >
                <span className="min-w-0 overflow-hidden whitespace-nowrap">
                  {tool.label}
                </span>
              </span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      {showDragSelect ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                variant="outline"
                size="sm"
                aria-label="Drag Select"
                pressed={dragSelectActive}
                onPressedChange={(pressed) => setDragSelectActive(pressed)}
                data-testid={`${testIdPrefix}viewport-drag-select`}
              >
                <SquareDashedMousePointerIcon />
              </Toggle>
            }
          />
          <TooltipContent>Drag Select</TooltipContent>
        </Tooltip>
      ) : null}
      <NestedMenu
        items={settingsItems}
        size="chrome"
        align="end"
        contentTestId={`${testIdPrefix}viewport-settings-menu`}
        trigger={
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Viewport Settings"
            data-testid={`${testIdPrefix}viewport-settings`}
          />
        }
      >
        <Settings2Icon />
      </NestedMenu>
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
