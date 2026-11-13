import type { AnimEvalState } from "@haptic/anim-graph";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@haptic/ui/components/select";
import { Toggle } from "@haptic/ui/components/toggle";
import type { AnimPreviewModel } from "../lib/use-anim-preview-model";
import { AnimGraphPreviewCanvas } from "./anim-graph-preview-canvas";

const NO_PREVIEW_MODEL = "";

/** A 3D animation preview's Model list and Bones toggle, for its transport bar. */
export function AnimPreviewModelControls({
  preview,
  onModelChange,
  showBones,
  onShowBonesChange,
  testIdPrefix,
}: {
  preview: AnimPreviewModel;
  onModelChange: (modelGuid: string | null) => void;
  showBones: boolean;
  onShowBonesChange: (showBones: boolean) => void;
  /** Test ids `${prefix}-model` and `${prefix}-bones`. */
  testIdPrefix: string;
}) {
  const { models, model, skeletonKind } = preview;
  return (
    <>
      <Select
        value={model?.header.guid ?? NO_PREVIEW_MODEL}
        onValueChange={(guid) => onModelChange(guid || null)}
        items={models.map((asset) => ({ value: asset.header.guid, label: asset.header.name }))}
        disabled={models.length === 0}
      >
        <SelectTrigger size="sm" aria-label="Preview Model" className="w-32" data-testid={`${testIdPrefix}-model`}>
          <SelectValue placeholder="No Model" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {models.map((asset) => (
              <SelectItem key={asset.header.guid} value={asset.header.guid}>
                {asset.header.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <Toggle
        size="sm"
        variant="outline"
        pressed={showBones}
        disabled={!skeletonKind}
        aria-label="Show Bones"
        data-testid={`${testIdPrefix}-bones`}
        onPressedChange={onShowBonesChange}
      >
        Bones
      </Toggle>
    </>
  );
}

/** The preview Model playing `getState`'s clip layers, or why there is nothing to show. */
export function AnimPreview3DView({
  preview,
  showBones,
  getState,
  subscribe,
  emptyText,
  "data-testid": testId,
}: {
  preview: AnimPreviewModel;
  showBones: boolean;
  getState: () => AnimEvalState | null;
  subscribe: (listener: () => void) => () => void;
  /** Shown when no Model can be previewed. */
  emptyText: string;
  "data-testid"?: string;
}) {
  const { source, modelPayload, model, clips, readModelBytes, skeletonKind } = preview;
  return (
    <div className="relative min-h-0 flex-1" data-testid={testId}>
      {source.bytes && modelPayload ? (
        <AnimGraphPreviewCanvas
          modelBytes={source.bytes}
          materialSlots={modelPayload.materialSlots}
          importScale={modelPayload.importScale}
          clips={clips}
          readModelBytes={readModelBytes}
          skeletonKind={skeletonKind}
          showBones={showBones}
          getState={getState}
          subscribe={subscribe}
        />
      ) : (
        <p className="p-3 text-sm text-muted-foreground" data-testid="anim-preview-empty">
          {source.error ?? (model ? "" : emptyText)}
        </p>
      )}
    </div>
  );
}
