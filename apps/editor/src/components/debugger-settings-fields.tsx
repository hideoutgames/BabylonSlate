import { useEffect, useState } from "react";
import { DisclosureSection, NumberField } from "@babylonslate/editor-kit";
import type { EngineSettings } from "@babylonslate/vfs";
import { Switch } from "@babylonslate/ui/components/switch";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@babylonslate/ui/components/field";

export function DebuggerSettingsFields({ settings, onChange, focusTargetId }: {
  settings: EngineSettings;
  onChange: (patch: Partial<EngineSettings>) => void | Promise<void>;
  focusTargetId?: string;
}) {
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    if (focusTargetId === "setting-profile-budget-mib") setAdvanced(true);
  }, [focusTargetId]);
  const defaults = settings.debuggerDefaults;
  const update = (patch: Partial<typeof defaults>) => void onChange({ debuggerDefaults: { ...defaults, ...patch } });
  return <>
    <FieldSet>
      <FieldLegend>Session</FieldLegend>
      <Field orientation="horizontal" className="settings-field">
        <FieldContent>
          <FieldLabel htmlFor="setting-pause-on-play">Pause On Play</FieldLabel>
          <FieldDescription>Start Play and Simulation paused. This uses the same preference as the Debug menu.</FieldDescription>
        </FieldContent>
        <Switch id="setting-pause-on-play" checked={defaults.pauseOnPlay} onCheckedChange={(pauseOnPlay) => update({ pauseOnPlay })} />
      </Field>
    </FieldSet>
    <FieldSet>
      <FieldLegend>Profiler</FieldLegend>
      <Field className="settings-field">
        <FieldLabel htmlFor="setting-profile-duration">Recording Duration (Seconds)</FieldLabel>
        <NumberField id="setting-profile-duration" min={1} max={60} step={1} value={defaults.profileDurationSeconds}
          onChange={(value) => update({ profileDurationSeconds: Math.round(value) })} />
        <FieldDescription>Applies to the next explicitly started Performance recording in Play or Preview Build. Opening results does not start recording.</FieldDescription>
      </Field>
      <Field orientation="horizontal" className="settings-field">
        <FieldContent>
          <FieldLabel htmlFor="setting-profile-gpu">GPU Timing</FieldLabel>
          <FieldDescription>Request GPU timing during Performance recording when supported. Unavailable or invalid queries are omitted. Renderer-owned timing is unaffected.</FieldDescription>
        </FieldContent>
        <Switch id="setting-profile-gpu" checked={defaults.profileGpuTiming} onCheckedChange={(profileGpuTiming) => update({ profileGpuTiming })} />
      </Field>
      <DisclosureSection title="Advanced" open={advanced} onOpenChange={setAdvanced}>
        <Field className="settings-field">
          <FieldLabel htmlFor="setting-profile-budget-mib">Profile Retained Data Budget (MiB)</FieldLabel>
          <NumberField id="setting-profile-budget-mib" min={4} max={64} step={1} value={Math.round(defaults.profileByteBudget / (1024 * 1024))}
            onChange={(value) => update({ profileByteBudget: Math.round(value) * 1024 * 1024 })} />
          <FieldDescription>Bounds retained timing buffers. This is separate from Trace and is not a browser heap limit. No memory is reserved until recording starts.</FieldDescription>
        </Field>
      </DisclosureSection>
    </FieldSet>
    <FieldSet>
      <FieldLegend>Trace</FieldLegend>
      <Field className="settings-field">
        <FieldLabel htmlFor="setting-trace-budget-mib">Trace Memory Budget (MiB)</FieldLabel>
        <NumberField id="setting-trace-budget-mib" min={1} max={256} step={1}
          className="min-h-[var(--chrome-row,28px)]" data-testid="setting-trace-budget-mib"
          value={Math.round(settings.traceByteBudget / (1024 * 1024))}
          onChange={(mebibytes) => void onChange({ traceByteBudget: Math.round(mebibytes) * 1024 * 1024 })} />
        <FieldDescription>Applies to the next Play or Preview Build session. Bounds serialized trace data, not browser memory. Oldest complete frames are discarded when full; a single oversized frame stops recording and preserves earlier complete frames.</FieldDescription>
      </Field>
    </FieldSet>
  </>;
}
