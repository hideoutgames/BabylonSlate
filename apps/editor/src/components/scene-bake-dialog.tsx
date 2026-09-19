import type { BakeAuthoringSettings } from "@babylonslate/core";
import type {
  SceneBakeProgress,
  SceneBakePhase,
} from "@babylonslate/render/scene-bake-job";
import { NumberField } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Progress } from "@babylonslate/ui/components/progress";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";

const phaseLabel: Record<SceneBakePhase, string> = {
  preparing: "Preparing Sources",
  unwrapping: "Generating UVs",
  building: "Preparing Lighting",
  compiling: "Compiling Lighting",
  baking: "Baking Lighting",
  readback: "Reading Lighting",
  assembling: "Preparing Atlases",
  writing: "Saving Bake",
};
export function SceneBakeDialog(props: {
  busy: boolean;
  ready: boolean;
  progress: SceneBakeProgress | null;
  error: string | null;
  message: string | null;
  settings: BakeAuthoringSettings;
  onSettings(settings: BakeAuthoringSettings): void;
  onStart(): void;
  onCancel(): void;
  onClose(): void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        showCloseButton={!props.busy}
        data-testid="scene-bake-dialog"
      >
        <DialogHeader>
          <DialogTitle>Bake Lighting</DialogTitle>
          <DialogDescription>
            Bake Static lighting and Stationary indirect light on this device.
            Existing lighting and the previous bake stay available if the job
            cannot finish.
          </DialogDescription>
        </DialogHeader>
        {!props.busy ? (
          <>
            <Alert>
              <AlertTitle>Current Bake Support</AlertTitle>
              <AlertDescription>
                Primitive meshes with constant, opaque, two-sided PBR Materials
                and fixed point lights. Set meshes to Static Receiver or Static
                Occluder and lights to Static or Stationary in Details. Imported
                models, textures, environment lighting and emissive sources are
                not supported yet. Up to 512 triangles, 64 receivers and 16
                lights; jobs stop after two minutes.
              </AlertDescription>
            </Alert>
            <FieldGroup>
              {(
                [
                  ["resolution", "Atlas Resolution", 32, 128],
                  ["paddingTexels", "Padding Texels", 1, 4],
                  ["samples", "Samples", 1, 4096],
                  ["bounces", "Path Vertices", 2, 8],
                ] as const
              ).map(([key, label, min, max]) => (
                <Field key={key} orientation="horizontal">
                  <FieldLabel htmlFor={`bake-${key}`}>{label}</FieldLabel>
                  <NumberField
                    id={`bake-${key}`}
                    aria-label={label}
                    value={props.settings[key]}
                    min={min}
                    max={max}
                    onChange={(value) =>
                      props.onSettings({
                        ...props.settings,
                        [key]: Math.round(value),
                      })
                    }
                  />
                </Field>
              ))}
            </FieldGroup>
          </>
        ) : (
          <div className="flex flex-col gap-2" role="status" aria-live="polite">
            <p data-testid="scene-bake-phase">
              {phaseLabel[props.progress?.phase ?? "preparing"]}
            </p>
            <Progress
              value={props.progress?.progress ?? 0}
              aria-label="Bake Lighting Progress"
            />
            {props.progress?.receivers ? (
              <p className="text-sm text-muted-foreground">
                Receiver {props.progress.receiver} of {props.progress.receivers}
              </p>
            ) : null}
          </div>
        )}
        {props.error ? (
          <Alert variant="destructive">
            <AlertTitle>Bake Not Saved</AlertTitle>
            <AlertDescription>{props.error}</AlertDescription>
          </Alert>
        ) : null}
        {props.message ? (
          <Alert>
            <AlertDescription>{props.message}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          {props.busy ? (
            <Button
              size="sm"
              className="pointer-coarse:min-h-11"
              variant="outline"
              onClick={props.onCancel}
            >
              Cancel Bake
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                className="pointer-coarse:min-h-11"
                variant="outline"
                onClick={props.onClose}
              >
                Close
              </Button>
              <Button
                size="sm"
                className="pointer-coarse:min-h-11"
                disabled={!props.ready}
                onClick={props.onStart}
              >
                Bake Lighting
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
