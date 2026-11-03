import { LabelHint, NumberField } from "@haptic/editor-kit";
import type { EngineSettings } from "@haptic/vfs";
import { MAX_TRACES_KEPT } from "@haptic/core";
import { Switch } from "@haptic/ui/components/switch";
import { Field, FieldLabel } from "@haptic/ui/components/field";
import { SettingsSection } from "./settings-section";

export function DebuggerSettingsFields({ settings, onChange }: {
  settings: EngineSettings;
  onChange: (patch: Partial<EngineSettings>) => void | Promise<void>;
}) {
  const defaults = settings.debuggerDefaults;
  const update = (patch: Partial<typeof defaults>) => void onChange({ debuggerDefaults: { ...defaults, ...patch } });
  return <>
    <SettingsSection id="diagnostics" title="Diagnostics">
      <Field orientation="horizontal" className="settings-field">
        <LabelHint hint="Shows developer diagnostics, such as the Feature Test starter and Copy Error when a scene fails to load. Copied reports include device and GPU details but no project files.">
          <FieldLabel htmlFor="setting-debug-mode">Debug Mode</FieldLabel>
        </LabelHint>
        <Switch id="setting-debug-mode" data-testid="setting-debug-mode" checked={settings.debugMode}
          onCheckedChange={(debugMode) => void onChange({ debugMode })} />
      </Field>
      <Field orientation="horizontal" className="settings-field settings-field-dependent" data-disabled={!settings.debugMode || undefined}>
        <LabelHint hint="Checks every WebGL call so Copy Error names the one that failed; rendering is much slower while it is on. Requires Debug Mode.">
          <FieldLabel htmlFor="setting-trace-graphics-errors">Trace Graphics Errors</FieldLabel>
        </LabelHint>
        <Switch id="setting-trace-graphics-errors" data-testid="setting-trace-graphics-errors" disabled={!settings.debugMode}
          checked={settings.debugMode && settings.traceGraphicsErrors}
          onCheckedChange={(traceGraphicsErrors) => void onChange({ traceGraphicsErrors })} />
      </Field>
    </SettingsSection>
    <SettingsSection id="simulation" title="Simulation">
      <Field orientation="horizontal" className="settings-field">
        <LabelHint hint="On keeps the final scene of the next Simulation as one Undo step; off discards gameplay and live edits. Changes are never applied partially.">
          <FieldLabel htmlFor="setting-keep-simulation-changes">Keep Simulation Changes</FieldLabel>
        </LabelHint>
        <Switch id="setting-keep-simulation-changes" checked={defaults.keepSimulationChanges}
          onCheckedChange={(keepSimulationChanges) => update({ keepSimulationChanges })} />
      </Field>
    </SettingsSection>
    <SettingsSection id="session" title="Session">
      <Field orientation="horizontal" className="settings-field">
        <LabelHint hint="The first time a node throws, logs an Error or fails an Assert, the game pauses and the editor opens the graph at that node. Applies to the next Play or Simulation session.">
          <FieldLabel htmlFor="setting-pause-simulation-on-errors">Pause On Errors</FieldLabel>
        </LabelHint>
        <Switch id="setting-pause-simulation-on-errors" checked={defaults.pauseSimulationOnErrors}
          onCheckedChange={(pauseSimulationOnErrors) => update({ pauseSimulationOnErrors })} />
      </Field>
      <Field orientation="horizontal" className="settings-field">
        <LabelHint hint="Starts Play and Simulation paused; the Debug menu shares this preference.">
          <FieldLabel htmlFor="setting-pause-on-play">Pause On Play</FieldLabel>
        </LabelHint>
        <Switch id="setting-pause-on-play" checked={defaults.pauseOnPlay} onCheckedChange={(pauseOnPlay) => update({ pauseOnPlay })} />
      </Field>
    </SettingsSection>
    <SettingsSection id="profiler" title="Profiler">
      <Field className="settings-field">
        <LabelHint hint="Length of the next Performance recording you start in Play or Preview Build.">
          <FieldLabel htmlFor="setting-profile-duration">Recording Duration (Seconds)</FieldLabel>
        </LabelHint>
        <NumberField id="setting-profile-duration" min={1} max={60} step={1} value={defaults.profileDurationSeconds}
          onChange={(value) => update({ profileDurationSeconds: Math.round(value) })} />
      </Field>
      <Field orientation="horizontal" className="settings-field">
        <LabelHint hint="Requests GPU timing during Performance recording where the device supports it.">
          <FieldLabel htmlFor="setting-profile-gpu">GPU Timing</FieldLabel>
        </LabelHint>
        <Switch id="setting-profile-gpu" checked={defaults.profileGpuTiming} onCheckedChange={(profileGpuTiming) => update({ profileGpuTiming })} />
      </Field>
      <Field className="settings-field">
        <LabelHint hint="Bounds retained Performance timing buffers, separately from Trace. Nothing is reserved until recording starts.">
          <FieldLabel htmlFor="setting-profile-budget-mib">Profile Retained Data Budget (MiB)</FieldLabel>
        </LabelHint>
        <NumberField id="setting-profile-budget-mib" min={4} max={64} step={1} value={Math.round(defaults.profileByteBudget / (1024 * 1024))}
          onChange={(value) => update({ profileByteBudget: Math.round(value) * 1024 * 1024 })} />
      </Field>
    </SettingsSection>
    <SettingsSection id="trace" title="Trace">
      <Field className="settings-field">
        <LabelHint hint="Bounds serialized trace data for the next Play or Preview Build session. When it is full, the oldest complete frames are discarded.">
          <FieldLabel htmlFor="setting-trace-budget-mib">Trace Memory Budget (MiB)</FieldLabel>
        </LabelHint>
        <NumberField id="setting-trace-budget-mib" min={1} max={256} step={1}
          className="min-h-[var(--chrome-row,28px)]" data-testid="setting-trace-budget-mib"
          value={Math.round(settings.traceByteBudget / (1024 * 1024))}
          onChange={(mebibytes) => void onChange({ traceByteBudget: Math.round(mebibytes) * 1024 * 1024 })} />
      </Field>
      <Field className="settings-field">
        <LabelHint hint="Per project on this device; Debug > Recent Traces lists them. Recording another deletes the oldest, except traces open in a tab.">
          <FieldLabel htmlFor="setting-traces-kept">Traces Kept</FieldLabel>
        </LabelHint>
        <NumberField id="setting-traces-kept" min={1} max={MAX_TRACES_KEPT} step={1}
          className="min-h-[var(--chrome-row,28px)]" data-testid="setting-traces-kept"
          value={settings.tracesKept}
          onChange={(tracesKept) => void onChange({ tracesKept: Math.round(tracesKept) })} />
      </Field>
    </SettingsSection>
  </>;
}
