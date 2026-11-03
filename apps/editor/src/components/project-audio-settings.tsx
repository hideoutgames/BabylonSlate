import type { ProjectDocument } from "@haptic/core";
import {
  AssetPickerControl,
  LabelHint,
  NumberField,
  assetRowIdentity,
  selectedPickerIdentity,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { Slider } from "@haptic/ui/components/slider";
import { Switch } from "@haptic/ui/components/switch";
import type { DocumentActions, RegistryState } from "../context/document-context-types";
import { SettingsSection } from "./settings-section";

const OCCLUSION_HINT = "Wall muffling for channels with Muffle Through Walls enabled.";

interface ProjectAudioSettingsProps {
  projectDocument: ProjectDocument;
  updateProjectSettings: DocumentActions["updateProjectSettings"];
  assetRegistry: RegistryState["assetRegistry"];
  setMixerPickerOpen: (open: boolean) => void;
}

/** Project Settings → Audio: Audio Mixer, Occlusion and reverb scales. The host renders the picker. */
export function ProjectAudioSettings({
  projectDocument,
  updateProjectSettings,
  assetRegistry,
  setMixerPickerOpen,
}: ProjectAudioSettingsProps) {
  return (
    <FieldGroup>
      <SettingsSection id="mixer" title="Mixer">
        <Field className="settings-field">
          <LabelHint hint="None bypasses channel and master volume controls.">
            <FieldLabel>Audio Mixer</FieldLabel>
          </LabelHint>
          <AssetPickerControl
            value={projectDocument.settings.audio.audioMixerGuid}
          >
            <Button
              type="button"
              variant="outline"
                className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
              onClick={() => setMixerPickerOpen(true)}
              data-testid="settings-audio-mixer"
              id="settings-audio-mixer"
            >
              {selectedPickerIdentity(
                assetRowIdentity(
                  (() => {
                    const asset = assetRegistry
                      ?.list()
                      .find(
                        (entry) =>
                          entry.header.guid ===
                          projectDocument.settings.audio.audioMixerGuid,
                      );
                    return asset
                      ? {
                          name: asset.header.name,
                          type: asset.header.type,
                        }
                      : undefined;
                  })(),
                ),
              )}
            </Button>
          </AssetPickerControl>
        </Field>
      </SettingsSection>
      <SettingsSection id="occlusion" title="Occlusion">
          <Field orientation="horizontal" className="settings-field">
          <LabelHint hint={OCCLUSION_HINT}>
            <FieldLabel htmlFor="settings-audio-occlusion">
              Occlusion
            </FieldLabel>
          </LabelHint>
          <Switch
            id="settings-audio-occlusion"
            aria-describedby="settings-audio-occlusion-description"
            checked={projectDocument.settings.audio.occlusionEnabled}
            onCheckedChange={(checked) =>
              updateProjectSettings({
                audio: {
                  ...projectDocument.settings.audio,
                  occlusionEnabled: checked === true,
                },
              })
            }
            data-testid="settings-audio-occlusion"
          />
          <FieldDescription id="settings-audio-occlusion-description" className="sr-only">
            {OCCLUSION_HINT}
          </FieldDescription>
        </Field>
      </SettingsSection>
      <SettingsSection id="reverb" title="Reverb">
        {(
          [
            [
              "settings-audio-reverb-wet-scale",
              "Reverb Wet Scale",
              "reverbWetScale",
              "Scales baked environment reverb. Sounds without a channel stay dry.",
            ],
            [
              "settings-audio-reverb-decay-scale",
              "Reverb Decay Scale",
              "reverbDecayScale",
              undefined,
            ],
            [
              "settings-audio-reverb-damping-scale",
              "Reverb Damping Scale",
              "reverbDampingScale",
              undefined,
            ],
          ] as const
        ).map(([id, label, key, hint]) => (
          <Field key={id} className="settings-field">
            {hint ? (
              <LabelHint hint={hint}>
                <FieldLabel id={`${id}-label`} htmlFor={id}>{label}</FieldLabel>
              </LabelHint>
            ) : (
              <FieldLabel id={`${id}-label`} htmlFor={id}>{label}</FieldLabel>
            )}
            <div className="flex min-w-0 items-center gap-2">
              <Slider
                aria-labelledby={`${id}-label`}
                className="min-w-0 flex-1"
                min={0}
                max={2}
                step={0.05}
                value={projectDocument.settings.audio[key]}
                onValueChange={(next) => {
                  const scale = Array.isArray(next) ? next[0] : next;
                  if (typeof scale !== "number") return;
                  updateProjectSettings({
                    audio: {
                      ...projectDocument.settings.audio,
                      [key]: scale,
                    },
                  });
                }}
                data-testid={`${id}-slider`}
              />
              <div className="w-20 shrink-0">
                <NumberField
                  id={id}
                  min={0}
                  max={2}
                  step={0.05}
                    className="min-h-[var(--chrome-row,28px)]"
                  value={projectDocument.settings.audio[key]}
                  onChange={(scale) =>
                    updateProjectSettings({
                      audio: {
                        ...projectDocument.settings.audio,
                        [key]: scale,
                      },
                    })
                  }
                  data-testid={id}
                />
              </div>
            </div>
          </Field>
        ))}
      </SettingsSection>
    </FieldGroup>
  );
}
