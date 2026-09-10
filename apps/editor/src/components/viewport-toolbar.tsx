import {
  NestedMenu,
  NumberPromptDialog,
  type NestedMenuItem,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Badge } from "@babylonslate/ui/components/badge";
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
import { isSceneWorkspaceKind } from "@babylonslate/core";
import type { GizmoTool, ViewportShadingMode } from "@babylonslate/render";
import {
  ArrowDownToLineIcon,
  MagnetIcon,
  MoveIcon,
  RotateCwIcon,
  ScalingIcon,
  Settings2Icon,
  SquareDashedMousePointerIcon,
} from "lucide-react";
import { useState } from "react";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing } from "../context/scene-editing-context";
import { GridSizeDialog } from "./grid-size-dialog";
import { useLongPressMenu } from "../lib/use-long-press-menu";
import { IconActionButton } from "./icon-action-button";
import {
  patchEngineViewportPrefs,
  useEditorViewportPrefs,
} from "../lib/viewport-engine-prefs";

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
  showViewportModeToggle = true,
  showGizmoTools = true,
  onDrop,
  dropDisabled = true,
}: {
  testIdPrefix?: string;
  showDragSelect?: boolean;
  showViewportModeToggle?: boolean;
  showGizmoTools?: boolean;
  onDrop?: () => void;
  dropDisabled?: boolean;
}) {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applySceneChange } = useDocuments();
  const { flySpeed, gridSize, snapRotateDeg, snapScale } =
    useEditorViewportPrefs();
  const [numberPrompt, setNumberPrompt] = useState<null | "grid" | "camera">(
    null,
  );
  const snapMenu = useLongPressMenu({
    suppressClickAfterHold: true,
    onMenu: () => setNumberPrompt("grid"),
  });
  const {
    gizmoTool,
    setGizmoTool,
    snapEnabled,
    setSnapEnabled,
    joystickEnabled,
    setJoystickEnabled,
    gridVisible,
    setGridVisible,
    navmeshVisible,
    setNavmeshVisible,
    collisionsVisible,
    setCollisionsVisible,
    dragSelectActive,
    setDragSelectActive,
    viewportMode,
    setViewportMode,
    previewGameCamera,
    setPreviewGameCamera,
    pivotAroundCenter,
    setPivotAroundCenter,
    viewportShadingMode,
    setViewportShadingMode,
  } = useSceneEditing();

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const scene = isSceneWorkspaceKind(doc?.ref.kind)
    ? (doc.content as SerializedScene)
    : null;
  const snapIncrement =
    gizmoTool === "rotate"
      ? `${scene?.settings.grid.snapRotateDeg ?? snapRotateDeg}°`
      : gizmoTool === "scale"
        ? (scene?.settings.grid.snapScale ?? snapScale)
        : scene
          ? viewportMode === "2d"
            ? (scene.settings.grid.tileSize ?? 1)
            : (scene.settings.grid.snapTranslate ?? 1)
          : gridSize;

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

  const toggleNavmesh = (enabled: boolean) => {
    setNavmeshVisible(enabled);
    if (scene && scene.settings.showNavmesh !== enabled) {
      void applySceneChange(documentId, {
        ...scene,
        settings: { ...scene.settings, showNavmesh: enabled },
      });
    }
  };

  const settingsItems: NestedMenuItem[] = [
    {
      type: "submenu",
      id: "viewport-mode",
      label: "Viewport Mode",
      testId: `${testIdPrefix}viewport-shading-mode`,
      items: [
        {
          type: "radio-group",
          id: "viewport-shading",
          value: viewportShadingMode,
          closeOnClick: false,
          onValueChange: (value) =>
            setViewportShadingMode(value as ViewportShadingMode),
          items: [
            {
              id: "pbr",
              label: "PBR",
              value: "pbr",
              testId: `${testIdPrefix}viewport-shading-pbr`,
            },
            {
              id: "unlit",
              label: "Unlit",
              value: "unlit",
              testId: `${testIdPrefix}viewport-shading-unlit`,
            },
            {
              id: "wireframe",
              label: "Wireframe",
              value: "wireframe",
              testId: `${testIdPrefix}viewport-shading-wireframe`,
            },
          ],
        },
      ],
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
      id: "show-navmesh",
      label: "Show Navmesh",
      checked: navmeshVisible,
      closeOnClick: false,
      testId: `${testIdPrefix}viewport-show-navmesh-toggle`,
      onCheckedChange: toggleNavmesh,
    },
    {
      type: "checkbox",
      id: "show-collisions",
      label: "Show Collisions",
      checked: collisionsVisible,
      closeOnClick: false,
      testId: `${testIdPrefix}viewport-show-collisions-toggle`,
      onCheckedChange: setCollisionsVisible,
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
      id: "pivot-around-center",
      label: "Pivot Around Center",
      checked: pivotAroundCenter,
      closeOnClick: false,
      testId: `${testIdPrefix}viewport-pivot-around-center-toggle`,
      onCheckedChange: setPivotAroundCenter,
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
    {
      type: "submenu",
      id: "settings",
      label: "Settings",
      testId: `${testIdPrefix}viewport-settings-submenu`,
      items: [
        {
          id: "grid-size",
          label: "Grid Size",
          testId: `${testIdPrefix}viewport-grid-size`,
          onSelect: () => setNumberPrompt("grid"),
        },
        {
          id: "camera-speed",
          label: "Camera Speed",
          testId: `${testIdPrefix}viewport-camera-speed`,
          onSelect: () => setNumberPrompt("camera"),
        },
      ],
    },
  ];

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={`${testIdPrefix}viewport-toolbar`}
    >
      {showGizmoTools ? (
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
              <Tooltip key={tool.id}>
                <TooltipTrigger
                  render={
                    <ToggleGroupItem
                      value={tool.id}
                      aria-label={tool.label}
                      data-testid={`${testIdPrefix}gizmo-tool-${tool.id}`}
                    >
                      <Icon />
                    </ToggleGroupItem>
                  }
                />
                <TooltipContent>{tool.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </ToggleGroup>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              variant="outline"
              size="sm"
              aria-label="Snap Grid"
              {...snapMenu}
              aria-haspopup="dialog"
              pressed={snapEnabled}
              onPressedChange={toggleSnap}
              data-testid={`${testIdPrefix}gizmo-snap-toggle`}
            >
              <MagnetIcon />
              <span className="tabular-nums">{snapIncrement}</span>
            </Toggle>
          }
        />
        <TooltipContent>
          Snap {TOOLS.find((tool) => tool.id === gizmoTool)?.label} To{" "}
          {snapIncrement}. Hold Or Right-Click For Grid Size.
        </TooltipContent>
      </Tooltip>
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
      {onDrop ? (
        <IconActionButton
          type="button"
          size="sm"
          label="Drop"
          disabled={dropDisabled}
          onClick={onDrop}
          data-testid={`${testIdPrefix}viewport-drop`}
        >
          <ArrowDownToLineIcon />
        </IconActionButton>
      ) : null}
      <NestedMenu
        items={settingsItems}
        size="chrome"
        align="end"
        contentTestId={`${testIdPrefix}viewport-settings-menu`}
        contentClassName="w-max min-w-56 whitespace-nowrap"
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
      {showViewportModeToggle ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setMode(viewportMode === "3d" ? "2d" : "3d")}
          aria-label={`${viewportMode.toUpperCase()} Viewport; Switch To ${viewportMode === "3d" ? "2D" : "3D"}`}
          data-testid={`${testIdPrefix}viewport-mode-toggle`}
        >
          {viewportMode.toUpperCase()}
        </Button>
      ) : null}
      {viewportShadingMode !== "pbr" ? (
        <Badge variant="secondary">
          {viewportShadingMode === "wireframe" ? "Wireframe" : "Unlit"}
        </Badge>
      ) : null}
      {previewGameCamera ? (
        <Badge variant="secondary">Game Camera</Badge>
      ) : null}
      <GridSizeDialog
        open={numberPrompt === "grid"}
        onOpenChange={(open) => {
          if (!open) setNumberPrompt(null);
        }}
        initialValue={{
          gridSize: scene?.settings.grid.tileSize ?? gridSize,
          snapRotateDeg: scene?.settings.grid.snapRotateDeg ?? snapRotateDeg,
          snapScale: scene?.settings.grid.snapScale ?? snapScale,
        }}
        data-testid={`${testIdPrefix}viewport-grid-size-dialog`}
        onSubmit={(value) => {
          if (scene) {
            void applySceneChange(documentId, {
              ...scene,
              settings: {
                ...scene.settings,
                grid: {
                  ...scene.settings.grid,
                  tileSize: value.gridSize,
                  snapTranslate: value.gridSize,
                  snapRotateDeg: value.snapRotateDeg,
                  snapScale: value.snapScale,
                },
              },
            });
            return;
          }
          void patchEngineViewportPrefs({
            viewportGridSize: value.gridSize,
            viewportSnapRotateDeg: value.snapRotateDeg,
            viewportSnapScale: value.snapScale,
          });
        }}
      />
      <NumberPromptDialog
        open={numberPrompt === "camera"}
        onOpenChange={(open) => {
          if (!open) setNumberPrompt(null);
        }}
        title="Camera Speed"
        label="Camera Speed"
        description="How fast the editor camera flies in world units per second."
        initialValue={flySpeed}
        data-testid={`${testIdPrefix}viewport-camera-speed-dialog`}
        onSubmit={(value) => {
          void patchEngineViewportPrefs({ viewportFlySpeed: value });
        }}
      />
    </div>
  );
}
