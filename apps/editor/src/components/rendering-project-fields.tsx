import {
  normalizeRenderEffectsSettings,
} from "@haptic/core";
import {
  AssetPickerControl,
  LabelHint,
  NumberField,
  assetRowIdentity,
  selectedPickerIdentity,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@haptic/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";
import { Switch } from "@haptic/ui/components/switch";
import type { RenderingProjectContext } from "./rendering-settings-sections";

/** Project-only Rendering controls that `RENDERING_SETTINGS_SECTIONS` places. */

// Label tooltips that also stay their control's screen-reader description.
const CUSTOM_RESOLUTION_HINT = "Sets the design size for Play and exported games. Overrides Follow System.";
const BLACK_BARS_HINT = "Adds bars to preserve the design size. Off fills the window without stretching.";
const UPSCALING_HINT = "Pixelated enlarges the design size by the largest whole multiple that fits, with sharp square pixels, at full resolution. Without Black Bars the view extends to fill the window.";

export function RenderModeField({ render, setRender }: RenderingProjectContext) {
  return (
    <Field className="settings-field">
      <LabelHint hint="CEL uses banded lighting. Scenes can override its style.">
        <FieldLabel htmlFor="setting-render-mode">Render Mode</FieldLabel>
      </LabelHint>
      <Select value={render.mode ?? "pbr"}
        onValueChange={(mode) => {
          if (mode === "pbr" || mode === "cel") setRender({ ...render, mode });
        }}>
        <SelectTrigger id="setting-render-mode" data-testid="setting-render-mode">
          <SelectValue>{render.mode === "cel" ? "CEL" : "PBR"}</SelectValue>
        </SelectTrigger>
        <SelectContent><SelectGroup>
          <SelectItem value="pbr">PBR</SelectItem>
          <SelectItem value="cel">CEL</SelectItem>
        </SelectGroup></SelectContent>
      </Select>
    </Field>
  );
}

export function ResolutionFields({ render, setRender }: RenderingProjectContext) {
  return (
    <FieldGroup className="gap-2">
      <Field orientation="horizontal" className="settings-field">
        <LabelHint hint={CUSTOM_RESOLUTION_HINT}>
          <FieldLabel htmlFor="setting-render-custom">Custom Resolution</FieldLabel>
        </LabelHint>
        <Switch
          id="setting-render-custom"
          aria-describedby="setting-render-custom-description"
          checked={render.customResolution}
          onCheckedChange={(checked) => setRender({ ...render, customResolution: checked === true })}
          data-testid="setting-render-custom"
        />
        <FieldDescription id="setting-render-custom-description" className="sr-only">{CUSTOM_RESOLUTION_HINT}</FieldDescription>
      </Field>
      <Field className="settings-field settings-field-dependent">
        <FieldLabel htmlFor="setting-render-width">Render Size</FieldLabel>
        <div className="flex items-center gap-2">
          <NumberField
            id="setting-render-width"
            min={1}
            step={1}
            disabled={!render.customResolution}
            className="min-h-[var(--chrome-row,28px)]"
            value={render.width}
            onChange={(width) => setRender({ ...render, width })}
            data-testid="setting-render-width"
            aria-label="Render Width"
          />
          <span aria-hidden="true">×</span>
          <NumberField
            id="setting-render-height"
            min={1}
            step={1}
            disabled={!render.customResolution}
            className="min-h-[var(--chrome-row,28px)]"
            value={render.height}
            onChange={(height) => setRender({ ...render, height })}
            data-testid="setting-render-height"
            aria-label="Render Height"
          />
        </div>
      </Field>
      <Field orientation="horizontal" className="settings-field settings-field-dependent" data-disabled={!render.customResolution}>
        <LabelHint hint={BLACK_BARS_HINT}>
          <FieldLabel htmlFor="setting-render-black-bars">Black Bars</FieldLabel>
        </LabelHint>
        <Switch
          id="setting-render-black-bars"
          aria-describedby="setting-render-black-bars-description"
          checked={render.blackBars}
          disabled={!render.customResolution}
          onCheckedChange={(checked) => setRender({ ...render, blackBars: checked === true })}
          data-testid="setting-render-black-bars"
        />
        <FieldDescription id="setting-render-black-bars-description" className="sr-only">{BLACK_BARS_HINT}</FieldDescription>
      </Field>
      {render.customResolution ? (
        <Field className="settings-field settings-field-dependent">
          <LabelHint hint={UPSCALING_HINT}>
            <FieldLabel htmlFor="setting-render-upscaling">Upscaling</FieldLabel>
          </LabelHint>
          <Select value={render.upscaling}
            onValueChange={(upscaling) => {
              if (upscaling === "smooth" || upscaling === "pixelated") setRender({ ...render, upscaling });
            }}>
            <SelectTrigger id="setting-render-upscaling" data-testid="setting-render-upscaling"
              aria-describedby="setting-render-upscaling-description">
              <SelectValue>{render.upscaling === "pixelated" ? "Pixelated" : "Smooth"}</SelectValue>
            </SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="smooth">Smooth</SelectItem>
              <SelectItem value="pixelated">Pixelated</SelectItem>
            </SelectGroup></SelectContent>
          </Select>
          <FieldDescription id="setting-render-upscaling-description" className="sr-only">{UPSCALING_HINT}</FieldDescription>
        </Field>
      ) : null}
    </FieldGroup>
  );
}

export function ProjectLutControl({ context: { render, assetRegistry, setLutPickerOpen }, control }: {
  context: RenderingProjectContext;
  control: { id: string; disabled: boolean };
}) {
  const guid = normalizeRenderEffectsSettings(render.effects).colorGrading.lutTextureGuid;
  const asset = guid ? assetRegistry?.getByGuid(guid) : undefined;
  return (
    <AssetPickerControl value={guid}>
      <Button
        type="button"
        variant="outline"
        className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
        onClick={() => setLutPickerOpen(true)}
        data-testid={control.id}
        id={control.id}
        disabled={control.disabled}
      >
        {selectedPickerIdentity(assetRowIdentity(asset ? { name: asset.header.name, type: asset.header.type } : undefined))}
      </Button>
    </AssetPickerControl>
  );
}
