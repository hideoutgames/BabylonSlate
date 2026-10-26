import { NestedMenu, NumericDragField, type NestedMenuItem } from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import {
  SCENE_LAYER_ACTOR_SIZE_MODES,
  SCENE_LAYER_ANCHOR_LABELS,
  SCENE_LAYER_ANCHORS,
  type SceneLayerActorDesign,
  type SceneLayerActorSizeMode,
  type SceneLayerAnchor,
} from "@haptic/core";
import { ChevronDownIcon, FrameIcon } from "lucide-react";
import { useEffect, useState } from "react";

const SIZE_MODE_LABELS: Record<SceneLayerActorSizeMode, string> = {
  fullscreen: "Fullscreen",
  desired: "Desired",
  custom: "Custom",
};

/**
 * SceneLayerActor Prefab island controls: how the orange frame is sized
 * (Fullscreen, Desired, Custom pixels) and which frame point sits on the
 * Prefab Root.
 */
export function SceneLayerActorFrameControls({
  design,
  disabled = false,
  onChange,
}: {
  design: SceneLayerActorDesign;
  disabled?: boolean;
  onChange: (next: SceneLayerActorDesign) => void;
}) {
  // A scrub previews locally and commits once, so one gesture is one undo entry.
  const [draft, setDraft] = useState(design.customSizePx);
  useEffect(() => setDraft(design.customSizePx), [design.customSizePx]);
  const commitSize = (size: { width: number; height: number }) => {
    setDraft(size);
    if (size.width !== design.customSizePx.width || size.height !== design.customSizePx.height) {
      onChange({ ...design, customSizePx: size });
    }
  };
  const items: NestedMenuItem[] = [
    {
      type: "radio-group",
      id: "frame-size",
      value: design.sizeMode,
      disabled,
      onValueChange: (value) => onChange({ ...design, sizeMode: value as SceneLayerActorSizeMode }),
      items: SCENE_LAYER_ACTOR_SIZE_MODES.map((mode) => ({
        id: mode,
        label: SIZE_MODE_LABELS[mode],
        value: mode,
        testId: `prefab-frame-size-${mode}`,
      })),
    },
    { type: "separator", id: "frame-separator" },
    {
      type: "submenu",
      id: "frame-root-pivot",
      label: "Root Pivot",
      disabled,
      testId: "prefab-frame-root-pivot",
      items: [{
        type: "radio-group",
        id: "frame-root-anchor",
        value: design.rootAnchor,
        onValueChange: (value) => onChange({ ...design, rootAnchor: value as SceneLayerAnchor }),
        items: SCENE_LAYER_ANCHORS.map((anchor) => ({
          id: anchor,
          label: SCENE_LAYER_ANCHOR_LABELS[anchor],
          value: anchor,
          testId: `prefab-frame-root-${anchor}`,
        })),
      }],
    },
  ];
  return (
    <>
      <NestedMenu
        items={items}
        size="chrome"
        align="end"
        contentTestId="prefab-frame-menu"
        contentClassName="w-max min-w-44 whitespace-nowrap"
        trigger={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            aria-label={`Frame: ${SIZE_MODE_LABELS[design.sizeMode]}`}
            data-testid="prefab-frame"
          />
        }
      >
        <FrameIcon />
        <span>{SIZE_MODE_LABELS[design.sizeMode]}</span>
        <ChevronDownIcon className="toolbar-island-caret" />
      </NestedMenu>
      {design.sizeMode === "custom" ? (
        <div className="flex w-44 items-center gap-0.5" data-testid="prefab-frame-custom-size">
          <NumericDragField
            label="W"
            aria-label="Custom Width"
            value={draft.width}
            min={1}
            sensitivity={1}
            precision={0}
            unit="px"
            disabled={disabled}
            onChange={(width) => setDraft((size) => ({ ...size, width }))}
            onDragEnd={(width) => commitSize({ ...draft, width })}
            data-testid="prefab-frame-custom-width"
          />
          <NumericDragField
            label="H"
            aria-label="Custom Height"
            value={draft.height}
            min={1}
            sensitivity={1}
            precision={0}
            unit="px"
            disabled={disabled}
            onChange={(height) => setDraft((size) => ({ ...size, height }))}
            onDragEnd={(height) => commitSize({ ...draft, height })}
            data-testid="prefab-frame-custom-height"
          />
        </div>
      ) : null}
    </>
  );
}
