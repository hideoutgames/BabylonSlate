import { useState, type ReactNode } from "react";
import { LabelHint, NumberField, SCRUB_SNAP_STRENGTH_LABELS } from "@haptic/editor-kit";
import {
  DOUBLE_TAP_TIME_MS_STEP,
  HOLD_TIME_MS_STEP,
  MAX_DOUBLE_TAP_TIME_MS,
  MAX_GRAPH_PIN_SCALE,
  MAX_GRAPH_SNAP_GRID_SIZE,
  MAX_HOLD_TIME_MS,
  MAX_NUMBER_SNAP_STRENGTH,
  MAX_TEXT_SIZE_PERCENT,
  MAX_TOUCH_TARGET_SCALE,
  GRAPH_PIN_SCALE_STEP,
  MIN_DOUBLE_TAP_TIME_MS,
  MIN_GRAPH_PIN_SCALE,
  MIN_GRAPH_SNAP_GRID_SIZE,
  MIN_HOLD_TIME_MS,
  MIN_TEXT_SIZE_PERCENT,
  MIN_TOUCH_TARGET_SCALE,
  TEXT_SIZE_PERCENT_STEP,
  TOUCH_TARGET_SCALE_STEP,
  type EngineSettings,
} from "@haptic/vfs";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { Slider } from "@haptic/ui/components/slider";
import { Switch } from "@haptic/ui/components/switch";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@haptic/ui/components/select";
import { SettingsSection } from "./settings-section";

const REDUCE_MOTION_ITEMS: Array<{ value: EngineSettings["reduceMotion"]; label: string }> = [
  { value: "system", label: "System" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

function sliderScalar(next: number | readonly number[]): number | undefined {
  const scalar = Array.isArray(next) ? next[0] : next;
  return typeof scalar === "number" ? scalar : undefined;
}

/**
 * A label, a stepped slider and the current value as text. `applyOnRelease`
 * shows a drag's value but applies it only when the drag ends (keys apply at
 * once): for settings that resize the slider itself, such as Text Size, which
 * would otherwise move the track under the pointer mid-drag.
 */
function SteppedSliderField({
  id,
  label,
  hint,
  min,
  max,
  step,
  value,
  format,
  applyOnRelease = false,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  applyOnRelease?: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const fieldLabel = <FieldLabel id={`${id}-label`} htmlFor={id}>{label}</FieldLabel>;
  return (
    <Field className="settings-field">
      {hint ? <LabelHint hint={hint}>{fieldLabel}</LabelHint> : fieldLabel}
      <div className="flex min-w-0 items-center gap-3">
        <Slider
          id={id}
          aria-labelledby={`${id}-label`}
          className="min-w-0 flex-1"
          data-testid={id}
          min={min}
          max={max}
          step={step}
          value={[shown]}
          onValueChange={(next) => {
            const scalar = sliderScalar(next);
            if (scalar === undefined) return;
            if (applyOnRelease) setDraft(scalar);
            else onChange(scalar);
          }}
          onValueCommitted={applyOnRelease ? (next) => {
            const scalar = sliderScalar(next);
            setDraft(null);
            if (scalar !== undefined && scalar !== value) onChange(scalar);
          } : undefined}
        />
        <span className="w-14 shrink-0 text-right text-xs tabular-nums" data-testid={`${id}-value`}>
          {format(shown)}
        </span>
      </div>
    </Field>
  );
}

function SwitchField({
  id,
  label,
  hint,
  checked,
  dependent = false,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  dependent?: boolean;
  onChange: (checked: boolean) => void;
}): ReactNode {
  const fieldLabel = <FieldLabel htmlFor={id}>{label}</FieldLabel>;
  return (
    <Field orientation="horizontal" className={dependent ? "settings-field settings-field-dependent" : "settings-field"}>
      {hint ? <LabelHint hint={hint}>{fieldLabel}</LabelHint> : fieldLabel}
      <Switch id={id} data-testid={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
    </Field>
  );
}

const times = (value: number) => `${Number(value.toFixed(2))}×`;
const milliseconds = (value: number) => `${value} ms`;

/** Engine Settings → Accessibility. */
export function AccessibilitySettingsFields({
  settings,
  onChange,
}: {
  settings: EngineSettings;
  onChange: (patch: Partial<EngineSettings>) => void | Promise<void>;
}) {
  return (
    <>
      <SettingsSection id="display" title="Display">
        <SteppedSliderField
          id="setting-text-size"
          label="Text Size"
          min={MIN_TEXT_SIZE_PERCENT}
          max={MAX_TEXT_SIZE_PERCENT}
          step={TEXT_SIZE_PERCENT_STEP}
          value={settings.textSizePercent}
          format={(value) => `${value}%`}
          applyOnRelease
          onChange={(textSizePercent) => void onChange({ textSizePercent })}
        />
        <Field className="settings-field">
          <LabelHint hint="System follows the device's reduced motion setting.">
            <FieldLabel htmlFor="setting-reduce-motion">Reduce Motion</FieldLabel>
          </LabelHint>
          <Select
            items={REDUCE_MOTION_ITEMS}
            value={settings.reduceMotion}
            onValueChange={(value) => {
              const item = REDUCE_MOTION_ITEMS.find((entry) => entry.value === value);
              if (item) void onChange({ reduceMotion: item.value });
            }}
          >
            <SelectTrigger id="setting-reduce-motion" size="sm" className="w-full" data-testid="setting-reduce-motion">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {REDUCE_MOTION_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </SettingsSection>

      <SettingsSection id="touchInput" title="Touch And Input">
        <SteppedSliderField
          id="setting-touch-target-size"
          label="Touch Target Size"
          hint="Size of the buttons, rows and pins you tap in the touch layout. Graph pins use it with a mouse too."
          min={MIN_TOUCH_TARGET_SCALE}
          max={MAX_TOUCH_TARGET_SCALE}
          step={TOUCH_TARGET_SCALE_STEP}
          value={settings.touchTargetScale}
          format={times}
          onChange={(touchTargetScale) => void onChange({ touchTargetScale })}
        />
        <SteppedSliderField
          id="setting-hold-time"
          label="Hold Time"
          hint="How long to hold before a menu opens. Holding to drag starts at half of it."
          min={MIN_HOLD_TIME_MS}
          max={MAX_HOLD_TIME_MS}
          step={HOLD_TIME_MS_STEP}
          value={settings.holdTimeMs}
          format={milliseconds}
          onChange={(holdTimeMs) => void onChange({ holdTimeMs })}
        />
        <SteppedSliderField
          id="setting-double-tap-time"
          label="Double-Tap Time"
          hint="The longest gap between the two taps of a double-tap."
          min={MIN_DOUBLE_TAP_TIME_MS}
          max={MAX_DOUBLE_TAP_TIME_MS}
          step={DOUBLE_TAP_TIME_MS_STEP}
          value={settings.doubleTapTimeMs}
          format={milliseconds}
          onChange={(doubleTapTimeMs) => void onChange({ doubleTapTimeMs })}
        />
        <SteppedSliderField
          id="setting-number-snap-strength"
          label="Number Snap Strength"
          hint="How long dragging a number field pauses on round values such as 0.5, 1 and 10."
          min={0}
          max={MAX_NUMBER_SNAP_STRENGTH}
          step={1}
          value={settings.numberSnapStrength}
          format={(value) => SCRUB_SNAP_STRENGTH_LABELS[value] ?? String(value)}
          onChange={(numberSnapStrength) => void onChange({ numberSnapStrength })}
        />
      </SettingsSection>

      <SettingsSection id="graphPins" title="Graph Pins">
        <SwitchField
          id="setting-tap-to-connect"
          label="Tap To Connect Pins"
          hint="Tap a pin, then a pin on the other side, to connect them. Dragging between pins always works."
          checked={settings.graphTapToConnect}
          onChange={(graphTapToConnect) => void onChange({ graphTapToConnect })}
        />
        <SteppedSliderField
          id="setting-large-pins"
          label="Large Pins"
          hint="Enlarges pins, the area around them you can tap, and wires."
          min={MIN_GRAPH_PIN_SCALE}
          max={MAX_GRAPH_PIN_SCALE}
          step={GRAPH_PIN_SCALE_STEP}
          value={settings.graphPinScale}
          format={times}
          onChange={(graphPinScale) => void onChange({ graphPinScale })}
        />
        <SwitchField
          id="setting-pin-type-letters"
          label="Pin Type Letters"
          hint="Shows the type inside each data pin, such as B for Boolean, so types do not rely on colour."
          checked={settings.graphPinTypeLetters}
          onChange={(graphPinTypeLetters) => void onChange({ graphPinTypeLetters })}
        />
      </SettingsSection>

      <SettingsSection id="graphNodes" title="Graph Nodes">
        <SwitchField
          id="setting-snapped-nodes"
          label="Snapped Nodes"
          hint="A node moves freely while you drag it and snaps to the grid when you let go."
          checked={settings.graphSnapNodes}
          onChange={(graphSnapNodes) => void onChange({ graphSnapNodes })}
        />
        <Field className="settings-field settings-field-dependent">
          <FieldLabel htmlFor="setting-snap-grid-size">Snap Grid Size (Pixels)</FieldLabel>
          <NumberField
            id="setting-snap-grid-size"
            data-testid="setting-snap-grid-size"
            min={MIN_GRAPH_SNAP_GRID_SIZE}
            max={MAX_GRAPH_SNAP_GRID_SIZE}
            step={1}
            integer
            disabled={!settings.graphSnapNodes}
            value={settings.graphSnapGridSize}
            onChange={(graphSnapGridSize) => void onChange({ graphSnapGridSize })}
          />
        </Field>
      </SettingsSection>

      <SettingsSection id="graphConnections" title="Graph Connections">
        <SwitchField
          id="setting-graph-assistant"
          label="Node Connection Assistant"
          hint="Dragging a node near another previews wires to their free matching pins and connects them on release."
          checked={settings.graphAssistantEnabled}
          onChange={(graphAssistantEnabled) => void onChange({ graphAssistantEnabled })}
        />
        <Field className="settings-field settings-field-dependent">
          <FieldLabel htmlFor="setting-graph-distance">Connection Distance (Pixels)</FieldLabel>
          <NumberField
            id="setting-graph-distance"
            min={8}
            max={200}
            step={1}
            disabled={!settings.graphAssistantEnabled}
            value={settings.graphAssistantDistance}
            onChange={(graphAssistantDistance) => void onChange({ graphAssistantDistance })}
          />
        </Field>
        <SwitchField
          id="setting-graph-shake"
          label="Shake Nodes To Disconnect"
          hint="Shaking a node back and forth while dragging it breaks all its wires."
          checked={settings.graphShakeEnabled}
          onChange={(graphShakeEnabled) => void onChange({ graphShakeEnabled })}
        />
      </SettingsSection>
    </>
  );
}
